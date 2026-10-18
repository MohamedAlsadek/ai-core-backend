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
exports.transcribeSpeakers = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const params_1 = require("firebase-functions/params");
const auth_1 = require("../auth");
const rate_limiter_1 = require("../rate-limiter");
const tracker_1 = require("../usage/tracker");
// Same Secret Manager entry as processAi (defineSecret de-duplicates by name).
const openaiKey = (0, params_1.defineSecret)("OPENAI_API_KEY");
// Server-controlled model, same lockdown rule as processAi: never read the
// model from the request.
const SPEAKER_MODEL = "gpt-4o-transcribe-diarize";
const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI upload limit
const UPSTREAM_TIMEOUT_MS = 500000; // leaves headroom under timeoutSeconds
const ALLOWED_APP_IDS = new Set(["voicenote"]);
const ALLOWED_FORMATS = new Set([
    "flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "ogg", "wav", "webm",
]);
const ISO_639_1 = /^[a-z]{2}$/;
function parseSegments(raw) {
    if (!Array.isArray(raw))
        return [];
    const segments = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object")
            continue;
        const seg = entry;
        const text = typeof seg["text"] === "string" ? seg["text"].trim() : "";
        if (!text)
            continue;
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
exports.transcribeSpeakers = functions.https.onRequest({
    secrets: [openaiKey],
    timeoutSeconds: 540,
    memory: "1GiB",
    concurrency: 6,
    cors: true,
    invoker: "public",
}, async (req, res) => {
    var _a, _b;
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    let body;
    try {
        const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        body = parsed && typeof parsed === "object" ? parsed : {};
    }
    catch (_c) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
    }
    const appId = typeof body["appId"] === "string" ? body["appId"] : "";
    if (!ALLOWED_APP_IDS.has(appId)) {
        res.status(400).json({ error: `Unknown appId: ${appId}` });
        return;
    }
    const audioBase64 = typeof body["audioBase64"] === "string" ? body["audioBase64"] : "";
    if (!audioBase64) {
        res.status(400).json({ error: "audioBase64 is required" });
        return;
    }
    const audioFormat = typeof body["audioFormat"] === "string" ?
        body["audioFormat"].toLowerCase() :
        "m4a";
    if (!ALLOWED_FORMATS.has(audioFormat)) {
        res.status(400).json({ error: `Unsupported audioFormat: ${audioFormat}` });
        return;
    }
    const languageRaw = typeof body["language"] === "string" ?
        body["language"].trim().toLowerCase() :
        "";
    const language = ISO_639_1.test(languageRaw) ? languageRaw : undefined;
    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.length === 0) {
        res.status(400).json({ error: "audioBase64 is empty or invalid" });
        return;
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        res.status(413).json({
            error: `Audio too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 25MB.`,
        });
        return;
    }
    const auth = await (0, auth_1.verifyAuth)(req);
    const clientId = (0, rate_limiter_1.getClientId)(req, auth.uid);
    const { allowed, remaining } = await (0, rate_limiter_1.checkRateLimit)(clientId, `${appId}-speakers`);
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
        res.status(500).json({ error: "OPENAI_API_KEY not configured" });
        return;
    }
    // The pinned openai SDK (v4) predates diarization, so call the REST
    // endpoint directly instead of upgrading the SDK under processAi.
    const form = new FormData();
    form.append("file", new File([audioBuffer], `audio.${audioFormat}`, { type: `audio/${audioFormat}` }));
    form.append("model", SPEAKER_MODEL);
    form.append("response_format", "diarized_json");
    // Required by the diarization model for audio longer than 30 seconds.
    form.append("chunking_strategy", "auto");
    if (language)
        form.append("language", language);
    let upstream;
    try {
        upstream = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    }
    catch (e) {
        const err = e;
        functions.logger.error("[transcribeSpeakers] request failed", { msg: err.message, appId });
        res.status(502).json({ error: (_a = err.message) !== null && _a !== void 0 ? _a : "Speaker transcription failed" });
        return;
    }
    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok || !payload) {
        const upstreamError = payload === null || payload === void 0 ? void 0 : payload["error"];
        const message = (_b = upstreamError === null || upstreamError === void 0 ? void 0 : upstreamError.message) !== null && _b !== void 0 ? _b : `Speaker transcription failed (HTTP ${upstream.status})`;
        functions.logger.error("[transcribeSpeakers] upstream error", { status: upstream.status, msg: message, appId });
        res.status(502).json({ error: message });
        return;
    }
    const segments = parseSegments(payload["segments"]);
    // The diarized `text` field embeds speaker prefixes; return plain text so
    // `text` means the same thing it does for processAi's transcribe task.
    const text = segments.length > 0 ?
        segments.map((s) => s.text).join(" ") :
        (typeof payload["text"] === "string" ? payload["text"].trim() : "");
    const usage = payload["usage"];
    const durationSeconds = typeof (usage === null || usage === void 0 ? void 0 : usage.seconds) === "number" ?
        usage.seconds :
        (typeof payload["duration"] === "number" ? payload["duration"] : null);
    const speakerCount = new Set(segments.map((s) => s.speaker).filter((s) => s !== null)).size;
    (0, tracker_1.trackUsage)({
        appId,
        userId: clientId,
        feature: "transcribeSpeakers",
        model: SPEAKER_MODEL,
        promptTokens: 0,
        completionTokens: 0,
    }).catch(() => { });
    // Counts only — never log transcript content.
    functions.logger.info("[transcribeSpeakers] ok", {
        appId,
        durationSeconds,
        segments: segments.length,
        speakers: speakerCount,
    });
    res.json({ result: { text, segments }, durationSeconds });
});
//# sourceMappingURL=speakers.js.map