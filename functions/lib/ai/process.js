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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processAi = void 0;
exports.firestoreReachable = firestoreReachable;
const functions = __importStar(require("firebase-functions/v2"));
const admin = __importStar(require("firebase-admin"));
const openai_1 = __importDefault(require("openai"));
const params_1 = require("firebase-functions/params");
const prompts_1 = require("./prompts");
const tracker_1 = require("../usage/tracker");
const auth_1 = require("../auth");
const rate_limiter_1 = require("../rate-limiter");
const openaiKey = (0, params_1.defineSecret)("OPENAI_API_KEY");
const MODEL = "gpt-4o-mini";
const EMBED_MODEL = "text-embedding-3-small";
/** Long transcript cleanup must return nearly full input length; default 512 truncates. */
function maxCompletionTokens(task) {
    switch (task) {
        case "chat":
            return 1024;
        case "cleanupTranscript":
        case "cleanupAndTitle":
            return 16384;
        case "moodAnalysis":
            return 4096;
        default:
            return 512;
    }
}
// Tasks that return a JSON object (enhanceAll). actions/tags return arrays — must use plain text.
const JSON_TASKS = new Set(["enhanceAll", "cleanupAndTitle", "moodAnalysis"]);
/** Strip leading "Title:" or "**Title:**" line from cleanup transcript output. */
function stripLeadingTitle(text) {
    var _a, _b;
    const trimmed = text.trimStart();
    const firstLine = (_b = (_a = trimmed.split("\n")[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
    if (firstLine.startsWith("Title:") || firstLine.startsWith("**Title:**")) {
        return trimmed.split("\n").slice(1).join("\n").trim();
    }
    return text.trim();
}
/** Extract JSON array from raw text (handles markdown code blocks or extra text). */
function extractJsonArray(raw) {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start)
        return [];
    const slice = trimmed.substring(start, end + 1);
    try {
        const parsed = JSON.parse(slice);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch (_a) {
        return [];
    }
}
const WHISPER_MODEL = "whisper-1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper limit: 25 MB
// Tasks that don't go through the chat completions path
const NON_CHAT_TASKS = new Set(["embed", "transcribe"]);
// Allowed app IDs — add new apps here when onboarding them
const ALLOWED_APP_IDS = new Set([
    "voicenote",
    "fitness",
    "journal",
    "moodtracker",
    "default",
]);
exports.processAi = functions.https.onRequest({
    secrets: [openaiKey],
    // Long transcript cleanup + 16k completion can exceed 60s
    timeoutSeconds: 300,
    memory: "512MiB",
    cors: true,
    invoker: "public",
}, async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
    // ── Method ─────────────────────────────────────────────────────────────
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    // ── Parse body ──────────────────────────────────────────────────────────
    let body;
    try {
        body =
            typeof req.body === "string" ? JSON.parse(req.body) : (_a = req.body) !== null && _a !== void 0 ? _a : {};
    }
    catch (_y) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
    }
    const { task, appId = "default" } = body;
    if (!task) {
        res.status(400).json({ error: "Missing required field: task" });
        return;
    }
    if (!ALLOWED_APP_IDS.has(appId)) {
        res.status(400).json({ error: `Unknown appId: ${appId}` });
        return;
    }
    const TASKS_REQUIRING_NOTE = new Set([
        "summarize", "title", "actions", "tags", "enhanceAll",
        "mainPoints", "meetingReport", "cleanupTranscript",
        "draftEmail", "draftBlog", "translate", "draftTweet",
        "cleanupAndTitle",
    ]);
    if (TASKS_REQUIRING_NOTE.has(task) && (!body.note || !body.note.transcription)) {
        res.status(400).json({ error: `Task "${task}" requires a note with transcription` });
        return;
    }
    if (task === "moodAnalysis" && (!body.moodEntries || body.moodEntries.length < 2)) {
        res.status(400).json({ error: "moodAnalysis requires at least 2 mood entries" });
        return;
    }
    const MAX_INPUT_CHARS = 50000;
    if (((_b = body.note) === null || _b === void 0 ? void 0 : _b.transcription) && body.note.transcription.length > MAX_INPUT_CHARS) {
        res.status(400).json({ error: `Transcript too long (${body.note.transcription.length} chars). Max ${MAX_INPUT_CHARS}.` });
        return;
    }
    // ── Auth ───────────────────────────────────────────────────────────────
    // Tokens from cross-project apps (e.g. voicenote using ai-voice-note-29b96)
    // can't be verified here — fall back to device-ID rate limiting instead.
    const auth = await (0, auth_1.verifyAuth)(req);
    // ── Rate limit ─────────────────────────────────────────────────────────
    const clientId = (0, rate_limiter_1.getClientId)(req, auth.uid);
    const { allowed, remaining } = await (0, rate_limiter_1.checkRateLimit)(clientId, appId);
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
        res.status(500).json({ error: "OPENAI_API_KEY not configured" });
        return;
    }
    const openai = new openai_1.default({ apiKey });
    // ── Embed task (separate path) ─────────────────────────────────────────
    if (NON_CHAT_TASKS.has(task)) {
        if (task === "embed") {
            const texts = (_c = body.texts) !== null && _c !== void 0 ? _c : [];
            if (!Array.isArray(texts) || texts.length === 0) {
                res.status(400).json({ error: "embed task requires a non-empty texts array" });
                return;
            }
            if (texts.length > 2048) {
                res.status(400).json({ error: "Max 2048 texts per embed request" });
                return;
            }
            try {
                const response = await openai.embeddings.create({
                    model: EMBED_MODEL,
                    input: texts,
                });
                const embeddings = Array(texts.length).fill(null);
                for (const item of (_d = response.data) !== null && _d !== void 0 ? _d : []) {
                    if (item.index >= 0 && item.index < texts.length) {
                        embeddings[item.index] = item.embedding;
                    }
                }
                const totalTokens = (_f = (_e = response.usage) === null || _e === void 0 ? void 0 : _e.total_tokens) !== null && _f !== void 0 ? _f : 0;
                (0, tracker_1.trackUsage)({ appId, userId: clientId, feature: "embed", model: EMBED_MODEL, promptTokens: totalTokens, completionTokens: 0 }).catch(() => { });
                res.json({ result: embeddings, tokensUsed: totalTokens });
            }
            catch (e) {
                const err = e;
                functions.logger.error("[processAi] embed error", { msg: err.message, appId });
                res.status(502).json({ error: (_g = err.message) !== null && _g !== void 0 ? _g : "Embed error" });
            }
            return;
        }
        if (task === "transcribe") {
            const audioBase64 = body["audioBase64"];
            const audioFormat = (_h = body["audioFormat"]) !== null && _h !== void 0 ? _h : "m4a";
            if (!audioBase64 || audioBase64.length === 0) {
                res.status(400).json({ error: "transcribe task requires audioBase64 field" });
                return;
            }
            const audioBuffer = Buffer.from(audioBase64, "base64");
            if (audioBuffer.length > MAX_AUDIO_BYTES) {
                res.status(400).json({ error: `Audio too large (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 25MB.` });
                return;
            }
            try {
                const file = new File([audioBuffer], `audio.${audioFormat}`, {
                    type: `audio/${audioFormat}`,
                });
                const response = await openai.audio.transcriptions.create({
                    model: WHISPER_MODEL,
                    file,
                    response_format: "text",
                });
                (0, tracker_1.trackUsage)({ appId, userId: clientId, feature: "transcribe", model: WHISPER_MODEL, promptTokens: 0, completionTokens: 0 }).catch(() => { });
                res.json({ result: response, tokensUsed: 0 });
            }
            catch (e) {
                const err = e;
                functions.logger.error("[processAi] transcribe error", { msg: err.message, appId });
                res.status(502).json({ error: (_j = err.message) !== null && _j !== void 0 ? _j : "Transcription error" });
            }
            return;
        }
    }
    // ── Build messages ─────────────────────────────────────────────────────
    let messages;
    try {
        messages = (0, prompts_1.buildMessages)(body);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
        return;
    }
    // ── Chat completion ────────────────────────────────────────────────────
    try {
        const isJson = JSON_TASKS.has(task);
        const completion = await openai.chat.completions.create(Object.assign({ model: MODEL, messages, temperature: 0.3, max_tokens: maxCompletionTokens(task) }, (isJson ? { response_format: { type: "json_object" } } : {})));
        const raw = (_m = (_l = (_k = completion.choices[0]) === null || _k === void 0 ? void 0 : _k.message) === null || _l === void 0 ? void 0 : _l.content) !== null && _m !== void 0 ? _m : "";
        const promptTokens = (_p = (_o = completion.usage) === null || _o === void 0 ? void 0 : _o.prompt_tokens) !== null && _p !== void 0 ? _p : 0;
        const completionTokens = (_r = (_q = completion.usage) === null || _q === void 0 ? void 0 : _q.completion_tokens) !== null && _r !== void 0 ? _r : 0;
        const totalTokens = promptTokens + completionTokens;
        // ── Parse result ────────────────────────────────────────────────────
        let result;
        if (task === "moodAnalysis") {
            try {
                const parsed = JSON.parse(raw);
                const cards = parsed["cards"];
                result = Array.isArray(cards) ? cards : [parsed];
            }
            catch (_z) {
                result = raw.trim();
            }
        }
        else if (task === "enhanceAll") {
            try {
                const parsed = JSON.parse(raw);
                result = {
                    title: ((_s = parsed["title"]) !== null && _s !== void 0 ? _s : "").trim(),
                    summary: ((_t = parsed["summary"]) !== null && _t !== void 0 ? _t : "").trim(),
                    actions: Array.isArray(parsed["actions"])
                        ? parsed["actions"].map(String)
                        : [],
                    tags: Array.isArray(parsed["tags"])
                        ? parsed["tags"].map(String)
                        : [],
                };
            }
            catch (_0) {
                result = { title: "", summary: raw.trim(), actions: [], tags: [] };
            }
        }
        else if (task === "cleanupAndTitle") {
            try {
                const parsed = JSON.parse(raw);
                result = {
                    title: ((_u = parsed["title"]) !== null && _u !== void 0 ? _u : "").trim(),
                    cleanTranscript: ((_v = parsed["cleanTranscript"]) !== null && _v !== void 0 ? _v : "").trim(),
                };
            }
            catch (_1) {
                result = { title: "", cleanTranscript: raw.trim() };
            }
        }
        else if (task === "actions" || task === "tags") {
            result = extractJsonArray(raw);
        }
        else if (task === "cleanupTranscript") {
            result = stripLeadingTitle(raw.trim());
        }
        else {
            result = raw.trim();
        }
        // ── Track usage (fire-and-forget) ────────────────────────────────────
        (0, tracker_1.trackUsage)({
            appId,
            userId: clientId,
            feature: task,
            model: MODEL,
            promptTokens,
            completionTokens,
        }).catch(() => { });
        res.json({ result, tokensUsed: totalTokens });
    }
    catch (e) {
        const err = e;
        functions.logger.error("[processAi] OpenAI error", {
            msg: err.message,
            cause: String((_w = err.cause) !== null && _w !== void 0 ? _w : ""),
            status: err.status,
            code: err.code,
            task,
            appId,
        });
        res.status(502).json({ error: (_x = err.message) !== null && _x !== void 0 ? _x : "OpenAI error" });
    }
});
// ── Helper: verify Firestore is reachable (called by health check) ────────────
async function firestoreReachable() {
    try {
        await admin.firestore().collection("_health").limit(1).get();
        return true;
    }
    catch (_a) {
        return false;
    }
}
//# sourceMappingURL=process.js.map