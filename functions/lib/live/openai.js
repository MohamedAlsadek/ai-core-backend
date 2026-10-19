"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOpenAiSession = createOpenAiSession;
const types_1 = require("./types");
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const REALTIME_URL = "wss://api.openai.com/v1/realtime";
// Server-controlled: the same model as processAi's transcribe task, so live
// text costs what file transcription does.
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const SAMPLE_RATE = 24000; // the only PCM rate the Realtime API accepts
const SECRET_TTL_SECONDS = 60;
/** Live words without speaker labels. [language] null lets the model detect it. */
async function createOpenAiSession(apiKey, opts) {
    const transcription = { model: TRANSCRIBE_MODEL };
    if (opts.language)
        transcription["language"] = opts.language;
    const res = await fetch(CLIENT_SECRETS_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            expires_after: { anchor: "created_at", seconds: SECRET_TTL_SECONDS },
            session: {
                type: "transcription",
                audio: {
                    input: {
                        format: { type: "audio/pcm", rate: SAMPLE_RATE },
                        noise_reduction: { type: "near_field" },
                        transcription,
                        turn_detection: {
                            type: "server_vad",
                            threshold: 0.5,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 500,
                        },
                    },
                },
            },
        }),
        signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    const secret = typeof (body === null || body === void 0 ? void 0 : body.value) === "string" ? body.value : "";
    if (!res.ok || !secret) {
        throw new types_1.LiveProviderError(`OpenAI client secret failed (HTTP ${res.status})`);
    }
    return {
        provider: "openai",
        url: REALTIME_URL,
        headers: { Authorization: `Bearer ${secret}` },
        sampleRate: SAMPLE_RATE,
    };
}
//# sourceMappingURL=openai.js.map