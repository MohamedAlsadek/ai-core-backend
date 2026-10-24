import * as functions from "firebase-functions/v2";
import {defineSecret} from "firebase-functions/params";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";
import {ASSEMBLYAI_LANGUAGES, createAssemblyAiSession} from "./assemblyai";
import {createOpenAiSession} from "./openai";
import {LiveProvider, LiveSessionGrant} from "./types";

const assemblyAiKey = defineSecret("ASSEMBLYAI_API_KEY");
// Same Secret Manager entry as processAi (defineSecret de-duplicates by name).
const openaiKey = defineSecret("OPENAI_API_KEY");

const ALLOWED_APP_IDS = new Set(["voicenote"]);
const LANGUAGE_CODE = /^[a-z]{2,3}$/;
/** AssemblyAI's own per-session cap. */
const MAX_SESSION_SECONDS = 3 * 60 * 60;

/**
 * POST /liveSession — short-lived credentials for live transcription.
 *
 * The app picks the provider, falls back on its own, and tracks each user's
 * monthly budget; this function only issues credentials, so provider API
 * keys never leave the server.
 *
 * Body: {appId, provider: "assemblyai" | "openai", language?, maxSeconds?}
 *       maxSeconds caps an AssemblyAI session at what the user's budget
 *       still covers; AssemblyAI ends the session there.
 * → LiveSessionGrant
 *   422 LANGUAGE_UNSUPPORTED  AssemblyAI can't stream this language
 */
export const liveSession = functions.https.onRequest(
  {
    secrets: [assemblyAiKey, openaiKey],
    timeoutSeconds: 30,
    memory: "256MiB",
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

    const provider = body["provider"];
    if (provider !== "assemblyai" && provider !== "openai") {
      res.status(400).json({error: "provider must be assemblyai or openai"});
      return;
    }

    const auth = await verifyAuth(req as Parameters<typeof verifyAuth>[0]);
    const clientId = getClientId(req as Parameters<typeof getClientId>[0], auth.uid);

    const languageRaw = typeof body["language"] === "string" ?
      body["language"].trim().toLowerCase() :
      "";
    const language = LANGUAGE_CODE.test(languageRaw) ? languageRaw : null;
    const maxSecondsRaw = body["maxSeconds"];
    const maxSeconds = typeof maxSecondsRaw === "number" && maxSecondsRaw > 0 ?
      Math.min(maxSecondsRaw, MAX_SESSION_SECONDS) :
      MAX_SESSION_SECONDS;

    const {allowed} = await checkRateLimit(clientId, `${appId}-live`);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    try {
      const grant = await startSession(provider, language, maxSeconds);
      if ("code" in grant) {
        res.status(grant.status).json({error: grant.error, code: grant.code});
        return;
      }
      functions.logger.info("[liveSession] started", {provider, appId});
      res.json(grant);
    } catch (e) {
      functions.logger.error("[liveSession] provider error", {
        provider,
        msg: (e as Error).message,
      });
      res.status(502).json({
        error: "Live transcription unavailable",
        code: "PROVIDER_ERROR",
      });
    }
  },
);

type Refusal = {status: number; code: string; error: string};

async function startSession(
  provider: LiveProvider,
  language: string | null,
  maxSeconds: number,
): Promise<LiveSessionGrant | Refusal> {
  if (provider === "openai") {
    // OpenAI's realtime language field takes ISO 639-1 codes only.
    return createOpenAiSession(openaiKey.value().trim(), {
      language: language?.length === 2 ? language : null,
    });
  }

  if (language && !ASSEMBLYAI_LANGUAGES.has(language)) {
    return {
      status: 422,
      code: "LANGUAGE_UNSUPPORTED",
      error: `Speaker-labelled live transcription doesn't support ${language}`,
    };
  }
  return createAssemblyAiSession(assemblyAiKey.value().trim(), {
    maxSessionSeconds: maxSeconds,
    language,
  });
}
