import * as functions from "firebase-functions/v2";
import {defineSecret} from "firebase-functions/params";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";

const assemblyAiKey = defineSecret("ASSEMBLYAI_API_KEY");

const API = "https://api.assemblyai.com/v2";
const ALLOWED_APP_IDS = new Set(["voicenote"]);
const LANGUAGE_CODE = /^[a-z]{2,3}$/;
/** Cloud Run caps request bodies at 32 MiB; the app sends longer audio in parts. */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 25 * 60 * 1000;

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

/**
 * POST /transcribeFile — transcribes one audio file with AssemblyAI.
 *
 * Body:  the audio bytes, in any common format.
 * Query: appId=voicenote, speakers=true|false, language=<ISO code> (optional;
 *        detected automatically otherwise).
 * Response: {result: {text, segments: [{start, end, text, speaker}]}, durationSeconds}
 *           with times in seconds, the same shape as transcribeSpeakers.
 *
 * The app checks each user's monthly budget before calling; this function
 * rate-limits per client and deletes the transcript from AssemblyAI once
 * it's been returned.
 */
export const transcribeFile = functions.https.onRequest(
  {
    secrets: [assemblyAiKey],
    timeoutSeconds: 1800,
    memory: "1GiB",
    concurrency: 10,
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    const appId = String(req.query["appId"] ?? "");
    if (!ALLOWED_APP_IDS.has(appId)) {
      res.status(400).json({error: `Unknown appId: ${appId}`});
      return;
    }

    const audio = req.rawBody;
    if (!audio || audio.length === 0) {
      res.status(400).json({error: "Audio body is required"});
      return;
    }
    if (audio.length > MAX_UPLOAD_BYTES) {
      res.status(413).json({error: "Audio too large; send it in parts"});
      return;
    }

    const speakers = req.query["speakers"] === "true";
    const languageRaw = String(req.query["language"] ?? "").trim().toLowerCase();
    const language = LANGUAGE_CODE.test(languageRaw) ? languageRaw : null;

    const auth = await verifyAuth(req as Parameters<typeof verifyAuth>[0]);
    const clientId = getClientId(req as Parameters<typeof getClientId>[0], auth.uid);
    const {allowed} = await checkRateLimit(clientId, `${appId}-file`);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    const key = assemblyAiKey.value().trim();
    let transcriptId: string | null = null;
    try {
      const uploadUrl = await upload(key, audio);
      transcriptId = await submit(key, uploadUrl, speakers, language);
      const transcript = await waitForCompletion(key, transcriptId);
      const segments = speakers ?
        fromUtterances(transcript["utterances"]) :
        await sentences(key, transcriptId);
      const text = typeof transcript["text"] === "string" ?
        transcript["text"].trim() :
        segments.map((s) => s.text).join(" ");
      const durationSeconds = typeof transcript["audio_duration"] === "number" ?
        transcript["audio_duration"] :
        null;
      // Counts only — never log transcript content.
      functions.logger.info("[transcribeFile] ok", {
        appId,
        speakers,
        durationSeconds,
        segments: segments.length,
      });
      res.json({result: {text, segments}, durationSeconds});
    } catch (e) {
      const message = (e as Error).message || "Transcription failed";
      functions.logger.error("[transcribeFile] failed", {msg: message, appId});
      res.status(502).json({error: message});
    } finally {
      if (transcriptId) await remove(key, transcriptId);
    }
  },
);

async function assemblyAi(
  key: string,
  path: string,
  init: {method?: string; body?: BodyInit; json?: unknown} = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {authorization: key};
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || !payload) {
    const detail = typeof payload?.["error"] === "string" ? payload["error"] : `HTTP ${res.status}`;
    throw new Error(`AssemblyAI ${path}: ${detail}`);
  }
  return payload;
}

async function upload(key: string, audio: Buffer): Promise<string> {
  const payload = await assemblyAi(key, "/upload", {body: new Uint8Array(audio)});
  const url = payload["upload_url"];
  if (typeof url !== "string") throw new Error("AssemblyAI upload returned no URL");
  return url;
}

async function submit(
  key: string,
  audioUrl: string,
  speakers: boolean,
  language: string | null,
): Promise<string> {
  const base = {audio_url: audioUrl, speaker_labels: speakers};
  let payload: Record<string, unknown>;
  try {
    payload = await assemblyAi(key, "/transcript", {
      json: language ? {...base, language_code: language} : {...base, language_detection: true},
    });
  } catch (e) {
    // A language AssemblyAI doesn't know is rejected outright; detect it instead.
    if (!language) throw e;
    payload = await assemblyAi(key, "/transcript", {json: {...base, language_detection: true}});
  }
  const id = payload["id"];
  if (typeof id !== "string") throw new Error("AssemblyAI returned no transcript id");
  return id;
}

async function waitForCompletion(key: string, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const transcript = await assemblyAi(key, `/transcript/${id}`);
    if (transcript["status"] === "completed") return transcript;
    if (transcript["status"] === "error") {
      throw new Error(String(transcript["error"] ?? "AssemblyAI transcription failed"));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("AssemblyAI transcription timed out");
}

async function sentences(key: string, id: string): Promise<Segment[]> {
  const payload = await assemblyAi(key, `/transcript/${id}/sentences`);
  return toSegments(payload["sentences"], false);
}

function fromUtterances(raw: unknown): Segment[] {
  return toSegments(raw, true);
}

/** AssemblyAI times are milliseconds; the app's segment format uses seconds. */
function toSegments(raw: unknown, withSpeakers: boolean): Segment[] {
  if (!Array.isArray(raw)) return [];
  const segments: Segment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const text = typeof item["text"] === "string" ? item["text"].trim() : "";
    if (!text) continue;
    const speaker = withSpeakers && typeof item["speaker"] === "string" ?
      item["speaker"].trim() :
      "";
    segments.push({
      start: typeof item["start"] === "number" ? item["start"] / 1000 : 0,
      end: typeof item["end"] === "number" ? item["end"] / 1000 : 0,
      text,
      speaker: speaker || null,
    });
  }
  return segments;
}

async function remove(key: string, id: string): Promise<void> {
  try {
    await assemblyAi(key, `/transcript/${id}`, {method: "DELETE"});
  } catch (e) {
    functions.logger.warn("[transcribeFile] could not delete transcript", {
      msg: (e as Error).message,
    });
  }
}
