import * as functions from "firebase-functions/v2";
import {defineSecret} from "firebase-functions/params";
import OpenAI from "openai";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";
import {trackUsage} from "../usage/tracker";

// Same Secret Manager entry as processAi (defineSecret de-duplicates by name).
const openaiKey = defineSecret("OPENAI_API_KEY");

// Server-controlled model, same lockdown rule as processAi: never read the
// model from the request.
const SPEAKER_MODEL = "gpt-4o-transcribe-diarize";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI upload limit
const UPSTREAM_TIMEOUT_MS = 500_000; // leaves headroom under timeoutSeconds
const ALLOWED_APP_IDS = new Set(["voicenote"]);
const ALLOWED_FORMATS = new Set([
  "flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "ogg", "wav", "webm",
]);
const ISO_639_1 = /^[a-z]{2}$/;

interface SpeakerSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

function parseSegments(raw: unknown): SpeakerSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: SpeakerSegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const seg = entry as Record<string, unknown>;
    const text = typeof seg["text"] === "string" ? seg["text"].trim() : "";
    if (!text) continue;
    const speaker = typeof seg["speaker"] === "string" ? seg["speaker"].trim() : "";
    segments.push({
      start: typeof seg["start"] === "number" ? seg["start"] : 0,
      end: typeof seg["end"] === "number" ? seg["end"] : 0,
      text,
      speaker: speaker || null,
    });
  }
  return segments;
}

/**
 * POST /transcribeSpeakers — speaker-labelled transcription of one file.
 *
 * Deliberately separate from processAi so regular transcription is never
 * affected by this model, its latency, or its quota. Speaker passes use their
 * own daily rate-limit bucket for the same reason.
 *
 * Body: {appId, audioBase64, audioFormat?, language?}
 * Response: {result: {text, segments: [{start, end, text, speaker}]}, durationSeconds}
 * (segment times in seconds).
 */
export const transcribeSpeakers = functions.https.onRequest(
  {
    secrets: [openaiKey],
    timeoutSeconds: 540,
    memory: "1GiB",
    concurrency: 6,
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      res.status(400).json({error: "Invalid JSON body"});
      return;
    }

    const appId = typeof body["appId"] === "string" ? body["appId"] : "";
    if (!ALLOWED_APP_IDS.has(appId)) {
      res.status(400).json({error: `Unknown appId: ${appId}`});
      return;
    }

    const audioBase64 = typeof body["audioBase64"] === "string" ? body["audioBase64"] : "";
    if (!audioBase64) {
      res.status(400).json({error: "audioBase64 is required"});
      return;
    }

    const audioFormat = typeof body["audioFormat"] === "string" ?
      body["audioFormat"].toLowerCase() :
      "m4a";
    if (!ALLOWED_FORMATS.has(audioFormat)) {
      res.status(400).json({error: `Unsupported audioFormat: ${audioFormat}`});
      return;
    }

    const languageRaw = typeof body["language"] === "string" ?
      body["language"].trim().toLowerCase() :
      "";
    const language = ISO_639_1.test(languageRaw) ? languageRaw : undefined;

    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.length === 0) {
      res.status(400).json({error: "audioBase64 is empty or invalid"});
      return;
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      res.status(413).json({
        error: `Audio too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 25MB.`,
      });
      return;
    }

    const auth = await verifyAuth(req as Parameters<typeof verifyAuth>[0]);
    const clientId = getClientId(
      req as Parameters<typeof getClientId>[0],
      auth.uid,
    );
    const {allowed, remaining} = await checkRateLimit(clientId, `${appId}-speakers`);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }
    if (remaining >= 0) {
      res.setHeader("X-RateLimit-Remaining", remaining);
    }

    const apiKey = openaiKey.value().trim();
    if (!apiKey) {
      res.status(500).json({error: "OPENAI_API_KEY not configured"});
      return;
    }

    // Through the SDK rather than global fetch: fetch gives up after five
    // minutes without response headers, and long files take longer than
    // that. The pinned SDK (v4) predates diarization, so the diarization
    // fields are passed through as-is.
    const openai = new OpenAI({apiKey, timeout: UPSTREAM_TIMEOUT_MS, maxRetries: 0});
    let payload: Record<string, unknown>;
    try {
      payload = await openai.audio.transcriptions.create({
        file: new File([audioBuffer], `audio.${audioFormat}`, {type: `audio/${audioFormat}`}),
        model: SPEAKER_MODEL,
        response_format: "diarized_json",
        // Required by the diarization model for audio longer than 30 seconds.
        chunking_strategy: "auto",
        ...(language ? {language} : {}),
      } as unknown as OpenAI.Audio.TranscriptionCreateParams) as unknown as Record<string, unknown>;
    } catch (e) {
      const err = e as Error & {status?: number};
      functions.logger.error("[transcribeSpeakers] upstream error", {
        status: err.status,
        msg: err.message,
        appId,
      });
      res.status(502).json({error: err.message ?? "Speaker transcription failed"});
      return;
    }

    const segments = parseSegments(payload["segments"]);
    // The diarized `text` field embeds speaker prefixes; return plain text so
    // `text` means the same thing it does for processAi's transcribe task.
    const text = segments.length > 0 ?
      segments.map((s) => s.text).join(" ") :
      (typeof payload["text"] === "string" ? payload["text"].trim() : "");
    const usage = payload["usage"] as {seconds?: number} | undefined;
    const durationSeconds = typeof usage?.seconds === "number" ?
      usage.seconds :
      (typeof payload["duration"] === "number" ? payload["duration"] : null);
    const speakerCount = new Set(
      segments.map((s) => s.speaker).filter((s): s is string => s !== null),
    ).size;

    trackUsage({
      appId,
      userId: clientId,
      feature: "transcribeSpeakers",
      model: SPEAKER_MODEL,
      promptTokens: 0,
      completionTokens: 0,
    }).catch(() => {});
    // Counts only — never log transcript content.
    functions.logger.info("[transcribeSpeakers] ok", {
      appId,
      durationSeconds,
      segments: segments.length,
      speakers: speakerCount,
    });

    res.json({result: {text, segments}, durationSeconds});
  },
);
