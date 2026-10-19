import * as functions from "firebase-functions/v2";
import {defineSecret} from "firebase-functions/params";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";
import {ASSEMBLYAI_LANGUAGES, createAssemblyAiSession} from "./assemblyai";
import {recordAssemblyAiSeconds, remainingAssemblyAiSeconds} from "./allowance";
import {createOpenAiSession} from "./openai";
import {LiveProvider, LiveSessionGrant} from "./types";

const assemblyAiKey = defineSecret("ASSEMBLYAI_API_KEY");
// Same Secret Manager entry as processAi (defineSecret de-duplicates by name).
const openaiKey = defineSecret("OPENAI_API_KEY");

const ALLOWED_APP_IDS = new Set(["voicenote"]);
const LANGUAGE_CODE = /^[a-z]{2,3}$/;
/** Below this, a new speaker-labelled session isn't worth opening. */
const MIN_ASSEMBLYAI_SECONDS = 60;

/**
 * POST /liveSession — short-lived credentials for live transcription.
 *
 * The app picks the provider and falls back on its own; this function only
 * issues credentials, so provider API keys never leave the server.
 *
 * Start:  {appId, provider: "assemblyai" | "openai", language?}
 *         → LiveSessionGrant
 *         429 LIVE_LIMIT_REACHED  monthly speaker-labelled time used up
 *         422 LANGUAGE_UNSUPPORTED  AssemblyAI can't stream this language
 * Usage:  {appId, action: "usage", provider: "assemblyai", seconds}
 *         → {ok: true}   (counts toward the monthly allowance)
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

    if (body["action"] === "usage") {
      const seconds = body["seconds"];
      if (provider !== "assemblyai" || typeof seconds !== "number") {
        res.status(400).json({error: "usage needs provider assemblyai and seconds"});
        return;
      }
      try {
        await recordAssemblyAiSeconds(clientId, seconds);
      } catch (e) {
        functions.logger.error("[liveSession] usage write failed", {msg: (e as Error).message});
      }
      res.json({ok: true});
      return;
    }

    const languageRaw = typeof body["language"] === "string" ?
      body["language"].trim().toLowerCase() :
      "";
    const language = LANGUAGE_CODE.test(languageRaw) ? languageRaw : null;

    const {allowed} = await checkRateLimit(clientId, `${appId}-live`);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    try {
      const grant = await startSession(provider, clientId, language);
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
  clientId: string,
  language: string | null,
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
  const remaining = await remainingAssemblyAiSeconds(clientId);
  if (remaining < MIN_ASSEMBLYAI_SECONDS) {
    return {
      status: 429,
      code: "LIVE_LIMIT_REACHED",
      error: "Monthly speaker-labelled live time used up",
    };
  }
  return createAssemblyAiSession(assemblyAiKey.value().trim(), {
    maxSessionSeconds: remaining,
    language,
  });
}
