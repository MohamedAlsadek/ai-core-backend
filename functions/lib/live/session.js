"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveSession = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const params_1 = require("firebase-functions/params");
const auth_1 = require("../auth");
const rate_limiter_1 = require("../rate-limiter");
const assemblyai_1 = require("./assemblyai");
const allowance_1 = require("./allowance");
const openai_1 = require("./openai");
const assemblyAiKey = (0, params_1.defineSecret)("ASSEMBLYAI_API_KEY");
// Same Secret Manager entry as processAi (defineSecret de-duplicates by name).
const openaiKey = (0, params_1.defineSecret)("OPENAI_API_KEY");
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
exports.liveSession = functions.https.onRequest({
    secrets: [assemblyAiKey, openaiKey],
    timeoutSeconds: 30,
    memory: "256MiB",
    cors: true,
    invoker: "public",
}, async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    let body;
    try {
        const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        body = parsed && typeof parsed === "object" ? parsed : {};
    }
    catch (_a) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
    }
    const appId = typeof body["appId"] === "string" ? body["appId"] : "";
    if (!ALLOWED_APP_IDS.has(appId)) {
        res.status(400).json({ error: `Unknown appId: ${appId}` });
        return;
    }
    const provider = body["provider"];
    if (provider !== "assemblyai" && provider !== "openai") {
        res.status(400).json({ error: "provider must be assemblyai or openai" });
        return;
    }
    const auth = await (0, auth_1.verifyAuth)(req);
    const clientId = (0, rate_limiter_1.getClientId)(req, auth.uid);
    if (body["action"] === "usage") {
        const seconds = body["seconds"];
        if (provider !== "assemblyai" || typeof seconds !== "number") {
            res.status(400).json({ error: "usage needs provider assemblyai and seconds" });
            return;
        }
        try {
            await (0, allowance_1.recordAssemblyAiSeconds)(clientId, seconds);
        }
        catch (e) {
            functions.logger.error("[liveSession] usage write failed", { msg: e.message });
        }
        res.json({ ok: true });
        return;
    }
    const languageRaw = typeof body["language"] === "string" ?
        body["language"].trim().toLowerCase() :
        "";
    const language = LANGUAGE_CODE.test(languageRaw) ? languageRaw : null;
    const { allowed } = await (0, rate_limiter_1.checkRateLimit)(clientId, `${appId}-live`);
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
            res.status(grant.status).json({ error: grant.error, code: grant.code });
            return;
        }
        functions.logger.info("[liveSession] started", { provider, appId });
        res.json(grant);
    }
    catch (e) {
        functions.logger.error("[liveSession] provider error", {
            provider,
            msg: e.message,
        });
        res.status(502).json({
            error: "Live transcription unavailable",
            code: "PROVIDER_ERROR",
        });
    }
});
async function startSession(provider, clientId, language) {
    if (provider === "openai") {
        // OpenAI's realtime language field takes ISO 639-1 codes only.
        return (0, openai_1.createOpenAiSession)(openaiKey.value().trim(), {
            language: (language === null || language === void 0 ? void 0 : language.length) === 2 ? language : null,
        });
    }
    if (language && !assemblyai_1.ASSEMBLYAI_LANGUAGES.has(language)) {
        return {
            status: 422,
            code: "LANGUAGE_UNSUPPORTED",
            error: `Speaker-labelled live transcription doesn't support ${language}`,
        };
    }
    const remaining = await (0, allowance_1.remainingAssemblyAiSeconds)(clientId);
    if (remaining < MIN_ASSEMBLYAI_SECONDS) {
        return {
            status: 429,
            code: "LIVE_LIMIT_REACHED",
            error: "Monthly speaker-labelled live time used up",
        };
    }
    return (0, assemblyai_1.createAssemblyAiSession)(assemblyAiKey.value().trim(), {
        maxSessionSeconds: remaining,
        language,
    });
}
//# sourceMappingURL=session.js.map