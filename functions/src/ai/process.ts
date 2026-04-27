import * as functions from "firebase-functions/v2";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import {defineSecret} from "firebase-functions/params";
import {buildMessages, TaskPayload, TaskType} from "./prompts";
import {trackUsage} from "../usage/tracker";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";

const openaiKey = defineSecret("OPENAI_API_KEY");

// ── Model lockdown ───────────────────────────────────────────────────────────
// These are the ONLY models this backend will ever call. Model selection is
// 100% server-controlled — never read from the request body. To change a model
// you must edit and redeploy this file. Do not refactor this to read from
// `body`, environment variables, or anything client-influenced.
const MODELS = Object.freeze({
  chat: "gpt-4o-mini",
  embed: "text-embedding-3-small",
  // All STT in this service uses gpt-4o-mini-transcribe (the `transcribe` task
  // and the voiceMoodInfer pipeline). Server-controlled; never from the client.
  transcribe: "gpt-4o-mini-transcribe",
} as const);

const MODEL = MODELS.chat;
const EMBED_MODEL = MODELS.embed;
const TRANSCRIBE_MODEL = MODELS.transcribe;

/** Long transcript cleanup must return nearly full input length; default 512 truncates. */
function maxCompletionTokens(task: TaskType): number {
  switch (task) {
    case "chat":
      return 1024;
    case "cleanupTranscript":
    case "cleanupAndTitle":
      return 16384;
    case "moodAnalysis":
      return 4096;
    case "voiceMoodInfer":
      // Output is a small JSON object with a 280-char note; 600 is plenty
      // of headroom even with multi-byte characters.
      return 600;
    default:
      return 512;
  }
}

// Tasks that return a JSON object (enhanceAll). actions/tags return arrays — must use plain text.
const JSON_TASKS = new Set<TaskType>(["enhanceAll", "cleanupAndTitle", "moodAnalysis", "voiceMoodInfer"]);

/** Strip leading "Title:" or "**Title:**" line from cleanup transcript output. */
function stripLeadingTitle(text: string): string {
  const trimmed = text.trimStart();
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("Title:") || firstLine.startsWith("**Title:**")) {
    return trimmed.split("\n").slice(1).join("\n").trim();
  }
  return text.trim();
}

/** Extract JSON array from raw text (handles markdown code blocks or extra text). */
function extractJsonArray(raw: string): string[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  const slice = trimmed.substring(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // max upload for `transcribe` task

// Tasks that don't go through the chat completions path
const NON_CHAT_TASKS = new Set<TaskType>(["embed", "transcribe"]);

// Explicit allowlist of every task this backend will accept. Anything else is
// rejected at the request boundary so a client can't probe for hidden tasks
// or force a code path that bypasses model lockdown.
const ALLOWED_TASKS: ReadonlySet<TaskType> = new Set<TaskType>([
  "summarize", "title", "actions", "tags", "chat", "enhanceAll", "custom",
  "embed", "transcribe", "mainPoints", "meetingReport", "cleanupTranscript",
  "draftEmail", "draftBlog", "translate", "draftTweet", "cleanupAndTitle",
  "moodAnalysis", "voiceMoodInfer",
]);

// Fields a client is NEVER allowed to set. Stripped before any downstream
// code reads from the body so a future refactor can't accidentally honor
// them. Keeps model selection, token caps, etc. server-controlled.
const FORBIDDEN_BODY_FIELDS = [
  "model", "modelId", "modelName", "engine",
  "temperature", "max_tokens", "maxTokens", "top_p", "topP",
  "response_format", "responseFormat",
];

// Allowed app IDs — add new apps here when onboarding them
const ALLOWED_APP_IDS = new Set([
  "voicenote",
  "fitness",
  "journal",
  "moodtracker",
  "default",
]);

export const processAi = functions.https.onRequest(
  {
    secrets: [openaiKey],
    // Long transcript cleanup + 16k completion can exceed 60s
    timeoutSeconds: 300,
    memory: "512MiB",
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    // ── Method ─────────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    let body: TaskPayload & {appId?: string; moodEntries?: Array<{date: string; moodType: string; activities: string[]; note: string; sleepHours: string | null}>};
    try {
      body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    } catch {
      res.status(400).json({error: "Invalid JSON body"});
      return;
    }

    // Defensive: drop any client-supplied field that could influence model
    // selection or generation params. Model lockdown is enforced here too,
    // not just by the absence of these fields in TaskPayload.
    const bodyAsRecord = body as unknown as Record<string, unknown>;
    for (const f of FORBIDDEN_BODY_FIELDS) {
      if (f in bodyAsRecord) delete bodyAsRecord[f];
    }

    const {task, appId = "default"} = body;

    if (!task) {
      res.status(400).json({error: "Missing required field: task"});
      return;
    }

    if (!ALLOWED_TASKS.has(task)) {
      res.status(400).json({error: `Unknown task: ${task}`});
      return;
    }

    if (!ALLOWED_APP_IDS.has(appId)) {
      res.status(400).json({error: `Unknown appId: ${appId}`});
      return;
    }

    const TASKS_REQUIRING_NOTE = new Set<TaskType>([
      "summarize", "title", "actions", "tags", "enhanceAll",
      "mainPoints", "meetingReport", "cleanupTranscript",
      "draftEmail", "draftBlog", "translate", "draftTweet",
      "cleanupAndTitle",
    ]);
    if (TASKS_REQUIRING_NOTE.has(task) && (!body.note || !body.note.transcription)) {
      res.status(400).json({error: `Task "${task}" requires a note with transcription`});
      return;
    }

    if (task === "moodAnalysis") {
      // Schema v2 clients send `entries`, v1 clients send `moodEntries`.
      // Either is valid; require at least 2 of whichever was provided.
      const v2Count = Array.isArray(body.entries) ? body.entries.length : 0;
      const v1Count = Array.isArray(body.moodEntries) ? body.moodEntries.length : 0;
      if (v2Count < 2 && v1Count < 2) {
        res.status(400).json({error: "moodAnalysis requires at least 2 mood entries"});
        return;
      }
    }

    const MAX_INPUT_CHARS = 50_000;
    if (body.note?.transcription && body.note.transcription.length > MAX_INPUT_CHARS) {
      res.status(400).json({error: `Transcript too long (${body.note.transcription.length} chars). Max ${MAX_INPUT_CHARS}.`});
      return;
    }

    // ── Auth ───────────────────────────────────────────────────────────────
    // Tokens from cross-project apps (e.g. voicenote using ai-voice-note-29b96)
    // can't be verified here — fall back to device-ID rate limiting instead.
    const auth = await verifyAuth(req as Parameters<typeof verifyAuth>[0]);

    // ── Rate limit ─────────────────────────────────────────────────────────
    const clientId = getClientId(
      req as Parameters<typeof getClientId>[0],
      auth.uid, // undefined for cross-project tokens → uses device ID
    );
    const {allowed, remaining} = await checkRateLimit(clientId, appId);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    // Expose remaining requests in headers
    if (remaining >= 0) {
      res.setHeader("X-RateLimit-Remaining", remaining);
    }

    // ── Validate API key ───────────────────────────────────────────────────
    const apiKey = openaiKey.value().trim();
    if (!apiKey) {
      res.status(500).json({error: "OPENAI_API_KEY not configured"});
      return;
    }

    const openai = new OpenAI({apiKey});

    // ── Embed task (separate path) ─────────────────────────────────────────
    if (NON_CHAT_TASKS.has(task)) {
      if (task === "embed") {
        const texts = body.texts ?? [];
        if (!Array.isArray(texts) || texts.length === 0) {
          res.status(400).json({error: "embed task requires a non-empty texts array"});
          return;
        }
        if (texts.length > 2048) {
          res.status(400).json({error: "Max 2048 texts per embed request"});
          return;
        }
        try {
          const response = await openai.embeddings.create({
            model: EMBED_MODEL,
            input: texts,
          });
          const embeddings = Array<number[] | null>(texts.length).fill(null);
          for (const item of response.data ?? []) {
            if (item.index >= 0 && item.index < texts.length) {
              embeddings[item.index] = item.embedding;
            }
          }
          const totalTokens = response.usage?.total_tokens ?? 0;
          trackUsage({appId, userId: clientId, feature: "embed", model: EMBED_MODEL, promptTokens: totalTokens, completionTokens: 0}).catch(() => {});
          res.json({result: embeddings, tokensUsed: totalTokens});
        } catch (e) {
          const err = e as Error;
          functions.logger.error("[processAi] embed error", {msg: err.message, appId});
          res.status(502).json({error: err.message ?? "Embed error"});
        }
        return;
      }

      if (task === "transcribe") {
        const audioBase64 = (body as unknown as Record<string, unknown>)["audioBase64"] as string | undefined;
        const audioFormat = ((body as unknown as Record<string, unknown>)["audioFormat"] as string | undefined) ?? "m4a";

        if (!audioBase64 || audioBase64.length === 0) {
          res.status(400).json({error: "transcribe task requires audioBase64 field"});
          return;
        }

        const audioBuffer = Buffer.from(audioBase64, "base64");
        if (audioBuffer.length > MAX_AUDIO_BYTES) {
          res.status(400).json({error: `Audio too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 25MB.`});
          return;
        }

        try {
          const file = new File([audioBuffer], `audio.${audioFormat}`, {
            type: `audio/${audioFormat}`,
          });

          const response = await openai.audio.transcriptions.create({
            model: TRANSCRIBE_MODEL,
            file,
            response_format: "text",
          });

          trackUsage({appId, userId: clientId, feature: "transcribe", model: TRANSCRIBE_MODEL, promptTokens: 0, completionTokens: 0}).catch(() => {});
          res.json({result: response, tokensUsed: 0});
        } catch (e) {
          const err = e as Error;
          functions.logger.error("[processAi] transcribe error", {msg: err.message, appId});
          res.status(502).json({error: err.message ?? "Transcription error"});
        }
        return;
      }
    }

    // ── voiceMoodInfer (separate path) ────────────────────────────────────
    // Two-step pipeline: (1) gpt-4o-mini-transcribe, (2) chat-completion
    // mood inference. Done server-side in one HTTP round trip so the client
    // sees ~3s end-to-end instead of ~6s. If the inference step fails after
    // a successful transcription, we still return the transcript — the
    // user already paid the latency cost, don't make them pay it again.
    if (task === "voiceMoodInfer") {
      // Tighter audio cap than the standalone transcribe task. 60s of m4a
      // mono 32kbps is ~240KB; 5MB gives ~20× headroom for higher bitrates
      // and bounds the worst-case OpenAI bill per request.
      const VOICE_MOOD_MAX_AUDIO_BYTES = 5 * 1024 * 1024;

      const reqBody = body as unknown as Record<string, unknown>;
      const audioBase64 = reqBody["audioBase64"] as string | undefined;
      const audioFormat = (reqBody["audioFormat"] as string | undefined) ?? "m4a";
      const presuppliedTranscript = (reqBody["voiceTranscript"] as string | undefined)?.trim();

      if (!audioBase64 && !presuppliedTranscript) {
        res.status(400).json({error: "voiceMoodInfer requires either audioBase64 or voiceTranscript"});
        return;
      }

      // ── Step 1: transcribe (or use the presupplied transcript) ────────
      let transcript = presuppliedTranscript ?? "";
      let transcribeTokens = 0;

      if (!presuppliedTranscript) {
        const audioBuffer = Buffer.from(audioBase64!, "base64");
        if (audioBuffer.length > VOICE_MOOD_MAX_AUDIO_BYTES) {
          res.status(400).json({error: `Audio too large for voiceMoodInfer (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 5MB.`});
          return;
        }

        try {
          const file = new File([audioBuffer], `audio.${audioFormat}`, {
            type: `audio/${audioFormat}`,
          });
          const stt = await openai.audio.transcriptions.create({
            model: TRANSCRIBE_MODEL,
            file,
            response_format: "text",
          });
          transcript = String(stt).trim();
        } catch (e) {
          const err = e as Error;
          functions.logger.error("[processAi] voiceMoodInfer transcribe error", {msg: err.message, appId});
          res.status(502).json({error: err.message ?? "Transcription error", code: "TRANSCRIBE_FAILED"});
          return;
        }

        trackUsage({appId, userId: clientId, feature: "voiceMoodInfer.transcribe", model: TRANSCRIBE_MODEL, promptTokens: 0, completionTokens: 0}).catch(() => {});
      }

      // ── Step 2: mood inference (best-effort — never fails the call) ────
      // Defaults returned if inference is skipped or fails. The client can
      // distinguish "no inference" from "inference said neutral with high
      // confidence" via the `confidence` field.
      let moodType: string | null = null;
      let suggestedActivityIds: string[] = [];
      let cleanedNote = "";
      let confidence: "high" | "medium" | "low" = "low";
      let inferTokens = 0;

      // Skip inference if the transcript is too short to be meaningful.
      // Threshold tuned to roughly "did the user say more than a single
      // word." The client renders this as "Couldn't catch the mood" and
      // falls back to manual entry.
      const MIN_TRANSCRIBABLE_CHARS = 4;
      if (transcript.length >= MIN_TRANSCRIBABLE_CHARS) {
        try {
          // buildMessages reads the transcript from `payload.voiceTranscript`
          // — pass the just-resolved transcript through, regardless of how
          // we obtained it.
          const inferMessages = buildMessages({
            ...body,
            task: "voiceMoodInfer",
            voiceTranscript: transcript,
          } as TaskPayload);

          const completion = await openai.chat.completions.create({
            model: MODEL,
            messages: inferMessages,
            temperature: 0.3,
            max_tokens: maxCompletionTokens("voiceMoodInfer"),
            response_format: {type: "json_object"},
          });

          const raw = completion.choices[0]?.message?.content ?? "";
          inferTokens = (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0);

          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;

            // ── Sanitize: never trust the model's output, always allowlist.
            const VALID_MOODS = new Set(["veryHappy", "happy", "neutral", "sad", "verySad"]);
            const rawMood = String(parsed["moodType"] ?? "").trim();
            moodType = VALID_MOODS.has(rawMood) ? rawMood : null;

            // Filter suggested IDs against what the client actually has.
            const userActivities = Array.isArray(body.userActivities) ? body.userActivities : [];
            const userIdSet = new Set(
              userActivities.map((a) => `${a.categoryId}:${a.itemId}`),
            );
            const rawIds = Array.isArray(parsed["suggestedActivityIds"]) ?
              (parsed["suggestedActivityIds"] as unknown[]).map(String) :
              [];
            suggestedActivityIds = rawIds
              .filter((id) => userIdSet.has(id))
              .slice(0, 4);

            // Truncate the cleaned note to keep storage and AI Wrap input
            // bounded. The 280-char limit matches the prompt contract.
            const rawNote = String(parsed["cleanedNote"] ?? "").trim();
            cleanedNote = rawNote.length > 280 ? rawNote.slice(0, 280) : rawNote;

            const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
            const rawConf = String(parsed["confidence"] ?? "").trim();
            confidence = (VALID_CONFIDENCE.has(rawConf) ? rawConf : "medium") as
              "high" | "medium" | "low";
          } catch {
            functions.logger.warn("[processAi] voiceMoodInfer parse failed — returning transcript only", {appId});
          }
        } catch (e) {
          const err = e as Error;
          functions.logger.warn("[processAi] voiceMoodInfer inference call failed — returning transcript only", {msg: err.message, appId});
        }

        trackUsage({appId, userId: clientId, feature: "voiceMoodInfer.infer", model: MODEL, promptTokens: 0, completionTokens: inferTokens}).catch(() => {});
      }

      res.json({
        result: {
          transcript,
          moodType,
          suggestedActivityIds,
          cleanedNote,
          confidence,
        },
        tokensUsed: transcribeTokens + inferTokens,
      });
      return;
    }

    // ── Build messages ─────────────────────────────────────────────────────
    let messages: {role: "user" | "assistant" | "system"; content: string}[];
    try {
      messages = buildMessages(body);
    } catch (e) {
      res.status(400).json({error: (e as Error).message});
      return;
    }

    // ── Chat completion ────────────────────────────────────────────────────
    try {
      const isJson = JSON_TASKS.has(task);
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.3,
        max_tokens: maxCompletionTokens(task),
        ...(isJson ? {response_format: {type: "json_object"}} : {}),
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const totalTokens = promptTokens + completionTokens;

      // ── Parse result ────────────────────────────────────────────────────
      let result: unknown;

      if (task === "moodAnalysis") {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const cards = parsed["cards"];
          result = Array.isArray(cards) ? cards : [parsed];
        } catch {
          result = raw.trim();
        }
      } else if (task === "enhanceAll") {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          result = {
            title: ((parsed["title"] as string | undefined) ?? "").trim(),
            summary: ((parsed["summary"] as string | undefined) ?? "").trim(),
            actions: Array.isArray(parsed["actions"])
              ? (parsed["actions"] as unknown[]).map(String)
              : [],
            tags: Array.isArray(parsed["tags"])
              ? (parsed["tags"] as unknown[]).map(String)
              : [],
          };
        } catch {
          result = {title: "", summary: raw.trim(), actions: [], tags: []};
        }
      } else if (task === "cleanupAndTitle") {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          result = {
            title: ((parsed["title"] as string | undefined) ?? "").trim(),
            cleanTranscript: ((parsed["cleanTranscript"] as string | undefined) ?? "").trim(),
          };
        } catch {
          result = {title: "", cleanTranscript: raw.trim()};
        }
      } else if (task === "actions" || task === "tags") {
        result = extractJsonArray(raw);
      } else if (task === "cleanupTranscript") {
        result = stripLeadingTitle(raw.trim());
      } else {
        result = raw.trim();
      }

      // ── Track usage (fire-and-forget) ────────────────────────────────────
      trackUsage({
        appId,
        userId: clientId,
        feature: task,
        model: MODEL,
        promptTokens,
        completionTokens,
      }).catch(() => {/* non-fatal */});

      res.json({result, tokensUsed: totalTokens});
    } catch (e) {
      const err = e as Error & {
        status?: number;
        code?: string;
        cause?: unknown;
      };
      functions.logger.error("[processAi] OpenAI error", {
        msg: err.message,
        cause: String(err.cause ?? ""),
        status: err.status,
        code: err.code,
        task,
        appId,
      });
      res.status(502).json({error: err.message ?? "OpenAI error"});
    }
  },
);

// ── Helper: verify Firestore is reachable (called by health check) ────────────
export async function firestoreReachable(): Promise<boolean> {
  try {
    await admin.firestore().collection("_health").limit(1).get();
    return true;
  } catch {
    return false;
  }
}
