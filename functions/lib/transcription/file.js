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
exports.transcribeFile = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const params_1 = require("firebase-functions/params");
const auth_1 = require("../auth");
const rate_limiter_1 = require("../rate-limiter");
const assemblyAiKey = (0, params_1.defineSecret)("ASSEMBLYAI_API_KEY");
const API = "https://api.assemblyai.com/v2";
const ALLOWED_APP_IDS = new Set(["voicenote"]);
const LANGUAGE_CODE = /^[a-z]{2,3}$/;
/** Cloud Run caps request bodies at 32 MiB; the app sends longer audio in parts. */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 25 * 60 * 1000;
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
exports.transcribeFile = functions.https.onRequest({
    secrets: [assemblyAiKey],
    timeoutSeconds: 1800,
    memory: "1GiB",
    concurrency: 10,
    cors: true,
    invoker: "public",
}, async (req, res) => {
    var _a, _b;
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const appId = String((_a = req.query["appId"]) !== null && _a !== void 0 ? _a : "");
    if (!ALLOWED_APP_IDS.has(appId)) {
        res.status(400).json({ error: `Unknown appId: ${appId}` });
        return;
    }
    const audio = req.rawBody;
    if (!audio || audio.length === 0) {
        res.status(400).json({ error: "Audio body is required" });
        return;
    }
    if (audio.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "Audio too large; send it in parts" });
        return;
    }
    const speakers = req.query["speakers"] === "true";
    const languageRaw = String((_b = req.query["language"]) !== null && _b !== void 0 ? _b : "").trim().toLowerCase();
    const language = LANGUAGE_CODE.test(languageRaw) ? languageRaw : null;
    const auth = await (0, auth_1.verifyAuth)(req);
    const clientId = (0, rate_limiter_1.getClientId)(req, auth.uid);
    const { allowed } = await (0, rate_limiter_1.checkRateLimit)(clientId, `${appId}-file`);
    if (!allowed) {
        res.status(429).json({
            error: "Rate limit exceeded. Try again tomorrow.",
            code: "RATE_LIMIT_EXCEEDED",
        });
        return;
    }
    const key = assemblyAiKey.value().trim();
    let transcriptId = null;
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
        res.json({ result: { text, segments }, durationSeconds });
    }
    catch (e) {
        const message = e.message || "Transcription failed";
        functions.logger.error("[transcribeFile] failed", { msg: message, appId });
        res.status(502).json({ error: message });
    }
    finally {
        if (transcriptId)
            await remove(key, transcriptId);
    }
});
async function assemblyAi(key, path, init = {}) {
    var _a;
    const headers = { authorization: key };
    let body = init.body;
    if (init.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(init.json);
    }
    const res = await fetch(`${API}${path}`, {
        method: (_a = init.method) !== null && _a !== void 0 ? _a : (body ? "POST" : "GET"),
        headers,
        body,
        signal: AbortSignal.timeout(120000),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload) {
        const detail = typeof (payload === null || payload === void 0 ? void 0 : payload["error"]) === "string" ? payload["error"] : `HTTP ${res.status}`;
        throw new Error(`AssemblyAI ${path}: ${detail}`);
    }
    return payload;
}
async function upload(key, audio) {
    const payload = await assemblyAi(key, "/upload", { body: new Uint8Array(audio) });
    const url = payload["upload_url"];
    if (typeof url !== "string")
        throw new Error("AssemblyAI upload returned no URL");
    return url;
}
async function submit(key, audioUrl, speakers, language) {
    const base = { audio_url: audioUrl, speaker_labels: speakers };
    let payload;
    try {
        payload = await assemblyAi(key, "/transcript", {
            json: language ? Object.assign(Object.assign({}, base), { language_code: language }) : Object.assign(Object.assign({}, base), { language_detection: true }),
        });
    }
    catch (e) {
        // A language AssemblyAI doesn't know is rejected outright; detect it instead.
        if (!language)
            throw e;
        payload = await assemblyAi(key, "/transcript", { json: Object.assign(Object.assign({}, base), { language_detection: true }) });
    }
    const id = payload["id"];
    if (typeof id !== "string")
        throw new Error("AssemblyAI returned no transcript id");
    return id;
}
async function waitForCompletion(key, id) {
    var _a;
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
        const transcript = await assemblyAi(key, `/transcript/${id}`);
        if (transcript["status"] === "completed")
            return transcript;
        if (transcript["status"] === "error") {
            throw new Error(String((_a = transcript["error"]) !== null && _a !== void 0 ? _a : "AssemblyAI transcription failed"));
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("AssemblyAI transcription timed out");
}
async function sentences(key, id) {
    const payload = await assemblyAi(key, `/transcript/${id}/sentences`);
    return toSegments(payload["sentences"], false);
}
function fromUtterances(raw) {
    return toSegments(raw, true);
}
/** AssemblyAI times are milliseconds; the app's segment format uses seconds. */
function toSegments(raw, withSpeakers) {
    if (!Array.isArray(raw))
        return [];
    const segments = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== "object")
            continue;
        const item = entry;
        const text = typeof item["text"] === "string" ? item["text"].trim() : "";
        if (!text)
            continue;
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
async function remove(key, id) {
    try {
        await assemblyAi(key, `/transcript/${id}`, { method: "DELETE" });
    }
    catch (e) {
        functions.logger.warn("[transcribeFile] could not delete transcript", {
            msg: e.message,
        });
    }
}
//# sourceMappingURL=file.js.map