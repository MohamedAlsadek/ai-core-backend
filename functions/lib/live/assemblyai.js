"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASSEMBLYAI_LANGUAGES = void 0;
exports.createAssemblyAiSession = createAssemblyAiSession;
const types_1 = require("./types");
const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const STREAM_URL = "wss://streaming.assemblyai.com/v3/ws";
// Server-controlled streaming config (same lockdown rule as processAi:
// never read the model from the request).
const SPEECH_MODEL = "universal-3-6-pro";
const SAMPLE_RATE = 16000;
const TOKEN_TTL_SECONDS = 60;
const MIN_SESSION_SECONDS = 60;
const MAX_SESSION_SECONDS = 3 * 60 * 60; // AssemblyAI's per-session cap
/** Languages universal-3-6-pro streams; other languages use OpenAI. */
exports.ASSEMBLYAI_LANGUAGES = new Set([
    "af", "ar", "yue", "ca", "da", "nl", "en", "et", "fi", "fr", "gl", "de",
    "he", "hi", "it", "ja", "ko", "zh", "mr", "no", "nn", "fa", "pt", "ro",
    "ru", "es", "sv", "tr", "ur", "vi", "xh", "zu",
]);
/** Live words with speaker labels. [language] null lets the model detect it. */
async function createAssemblyAiSession(apiKey, opts) {
    const maxSessionSeconds = Math.round(Math.min(Math.max(opts.maxSessionSeconds, MIN_SESSION_SECONDS), MAX_SESSION_SECONDS));
    const tokenParams = new URLSearchParams({
        expires_in_seconds: String(TOKEN_TTL_SECONDS),
        max_session_duration_seconds: String(maxSessionSeconds),
    });
    const res = await fetch(`${TOKEN_URL}?${tokenParams}`, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    const token = typeof (body === null || body === void 0 ? void 0 : body.token) === "string" ? body.token : "";
    if (!res.ok || !token) {
        throw new types_1.LiveProviderError(`AssemblyAI token failed (HTTP ${res.status})`);
    }
    const query = new URLSearchParams({
        token,
        sample_rate: String(SAMPLE_RATE),
        encoding: "pcm_s16le",
        speech_model: SPEECH_MODEL,
        speaker_labels: "true",
    });
    if (opts.language)
        query.set("language_codes", JSON.stringify([opts.language]));
    return {
        provider: "assemblyai",
        url: `${STREAM_URL}?${query}`,
        headers: {},
        sampleRate: SAMPLE_RATE,
        maxSessionSeconds,
    };
}
//# sourceMappingURL=assemblyai.js.map