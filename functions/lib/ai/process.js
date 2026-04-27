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
});
const MODEL = MODELS.chat;
const EMBED_MODEL = MODELS.embed;
const TRANSCRIBE_MODEL = MODELS.transcribe;
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
        case "voiceMoodInfer":
            // Output is a small JSON object with a 280-char note; 600 is plenty
            // of headroom even with multi-byte characters.
            return 600;
        default:
            return 512;
    }
}
// Tasks that return a JSON object (enhanceAll). actions/tags return arrays — must use plain text.
const JSON_TASKS = new Set(["enhanceAll", "cleanupAndTitle", "moodAnalysis", "voiceMoodInfer"]);
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
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // max upload for `transcribe` task
// Tasks that don't go through the chat completions path
const NON_CHAT_TASKS = new Set(["embed", "transcribe"]);
// Explicit allowlist of every task this backend will accept. Anything else is
// rejected at the request boundary so a client can't probe for hidden tasks
// or force a code path that bypasses model lockdown.
const ALLOWED_TASKS = new Set([
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
exports.processAi = functions.https.onRequest({
    secrets: [openaiKey],
    // Long transcript cleanup + 16k completion can exceed 60s
    timeoutSeconds: 300,
    memory: "512MiB",
    cors: true,
    invoker: "public",
}, async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10;
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
    catch (_11) {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
    }
    // Defensive: drop any client-supplied field that could influence model
    // selection or generation params. Model lockdown is enforced here too,
    // not just by the absence of these fields in TaskPayload.
    const bodyAsRecord = body;
    for (const f of FORBIDDEN_BODY_FIELDS) {
        if (f in bodyAsRecord)
            delete bodyAsRecord[f];
    }
    const { task, appId = "default" } = body;
    if (!task) {
        res.status(400).json({ error: "Missing required field: task" });
        return;
    }
    if (!ALLOWED_TASKS.has(task)) {
        res.status(400).json({ error: `Unknown task: ${task}` });
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
    if (task === "moodAnalysis") {
        // Schema v2 clients send `entries`, v1 clients send `moodEntries`.
        // Either is valid; require at least 2 of whichever was provided.
        const v2Count = Array.isArray(body.entries) ? body.entries.length : 0;
        const v1Count = Array.isArray(body.moodEntries) ? body.moodEntries.length : 0;
        if (v2Count < 2 && v1Count < 2) {
            res.status(400).json({ error: "moodAnalysis requires at least 2 mood entries" });
            return;
        }
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
                    model: TRANSCRIBE_MODEL,
                    file,
                    response_format: "text",
                });
                (0, tracker_1.trackUsage)({ appId, userId: clientId, feature: "transcribe", model: TRANSCRIBE_MODEL, promptTokens: 0, completionTokens: 0 }).catch(() => { });
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
        const reqBody = body;
        const audioBase64 = reqBody["audioBase64"];
        const audioFormat = (_k = reqBody["audioFormat"]) !== null && _k !== void 0 ? _k : "m4a";
        const presuppliedTranscript = (_l = reqBody["voiceTranscript"]) === null || _l === void 0 ? void 0 : _l.trim();
        if (!audioBase64 && !presuppliedTranscript) {
            res.status(400).json({ error: "voiceMoodInfer requires either audioBase64 or voiceTranscript" });
            return;
        }
        // ── Step 1: transcribe (or use the presupplied transcript) ────────
        let transcript = presuppliedTranscript !== null && presuppliedTranscript !== void 0 ? presuppliedTranscript : "";
        let transcribeTokens = 0;
        if (!presuppliedTranscript) {
            const audioBuffer = Buffer.from(audioBase64, "base64");
            if (audioBuffer.length > VOICE_MOOD_MAX_AUDIO_BYTES) {
                res.status(400).json({ error: `Audio too large for voiceMoodInfer (${Math.round(audioBuffer.length / 1024 / 1024)}MB). Max 5MB.` });
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
            }
            catch (e) {
                const err = e;
                functions.logger.error("[processAi] voiceMoodInfer transcribe error", { msg: err.message, appId });
                res.status(502).json({ error: (_m = err.message) !== null && _m !== void 0 ? _m : "Transcription error", code: "TRANSCRIBE_FAILED" });
                return;
            }
            (0, tracker_1.trackUsage)({ appId, userId: clientId, feature: "voiceMoodInfer.transcribe", model: TRANSCRIBE_MODEL, promptTokens: 0, completionTokens: 0 }).catch(() => { });
        }
        // ── Step 2: mood inference (best-effort — never fails the call) ────
        // Defaults returned if inference is skipped or fails. The client can
        // distinguish "no inference" from "inference said neutral with high
        // confidence" via the `confidence` field.
        let moodType = null;
        let suggestedActivityIds = [];
        let cleanedNote = "";
        let confidence = "low";
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
                const inferMessages = (0, prompts_1.buildMessages)(Object.assign(Object.assign({}, body), { task: "voiceMoodInfer", voiceTranscript: transcript }));
                const completion = await openai.chat.completions.create({
                    model: MODEL,
                    messages: inferMessages,
                    temperature: 0.3,
                    max_tokens: maxCompletionTokens("voiceMoodInfer"),
                    response_format: { type: "json_object" },
                });
                const raw = (_q = (_p = (_o = completion.choices[0]) === null || _o === void 0 ? void 0 : _o.message) === null || _p === void 0 ? void 0 : _p.content) !== null && _q !== void 0 ? _q : "";
                inferTokens = ((_s = (_r = completion.usage) === null || _r === void 0 ? void 0 : _r.prompt_tokens) !== null && _s !== void 0 ? _s : 0) + ((_u = (_t = completion.usage) === null || _t === void 0 ? void 0 : _t.completion_tokens) !== null && _u !== void 0 ? _u : 0);
                try {
                    const parsed = JSON.parse(raw);
                    // ── Sanitize: never trust the model's output, always allowlist.
                    const VALID_MOODS = new Set(["veryHappy", "happy", "neutral", "sad", "verySad"]);
                    const rawMood = String((_v = parsed["moodType"]) !== null && _v !== void 0 ? _v : "").trim();
                    moodType = VALID_MOODS.has(rawMood) ? rawMood : null;
                    // Filter suggested IDs against what the client actually has.
                    const userActivities = Array.isArray(body.userActivities) ? body.userActivities : [];
                    const userIdSet = new Set(userActivities.map((a) => `${a.categoryId}:${a.itemId}`));
                    const rawIds = Array.isArray(parsed["suggestedActivityIds"]) ?
                        parsed["suggestedActivityIds"].map(String) :
                        [];
                    suggestedActivityIds = rawIds
                        .filter((id) => userIdSet.has(id))
                        .slice(0, 4);
                    // Truncate the cleaned note to keep storage and AI Wrap input
                    // bounded. The 280-char limit matches the prompt contract.
                    const rawNote = String((_w = parsed["cleanedNote"]) !== null && _w !== void 0 ? _w : "").trim();
                    cleanedNote = rawNote.length > 280 ? rawNote.slice(0, 280) : rawNote;
                    const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
                    const rawConf = String((_x = parsed["confidence"]) !== null && _x !== void 0 ? _x : "").trim();
                    confidence = (VALID_CONFIDENCE.has(rawConf) ? rawConf : "medium");
                }
                catch (_12) {
                    functions.logger.warn("[processAi] voiceMoodInfer parse failed — returning transcript only", { appId });
                }
            }
            catch (e) {
                const err = e;
                functions.logger.warn("[processAi] voiceMoodInfer inference call failed — returning transcript only", { msg: err.message, appId });
            }
            (0, tracker_1.trackUsage)({ appId, userId: clientId, feature: "voiceMoodInfer.infer", model: MODEL, promptTokens: 0, completionTokens: inferTokens }).catch(() => { });
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
        const raw = (_0 = (_z = (_y = completion.choices[0]) === null || _y === void 0 ? void 0 : _y.message) === null || _z === void 0 ? void 0 : _z.content) !== null && _0 !== void 0 ? _0 : "";
        const promptTokens = (_2 = (_1 = completion.usage) === null || _1 === void 0 ? void 0 : _1.prompt_tokens) !== null && _2 !== void 0 ? _2 : 0;
        const completionTokens = (_4 = (_3 = completion.usage) === null || _3 === void 0 ? void 0 : _3.completion_tokens) !== null && _4 !== void 0 ? _4 : 0;
        const totalTokens = promptTokens + completionTokens;
        // ── Parse result ────────────────────────────────────────────────────
        let result;
        if (task === "moodAnalysis") {
            try {
                const parsed = JSON.parse(raw);
                const cards = parsed["cards"];
                result = Array.isArray(cards) ? cards : [parsed];
            }
            catch (_13) {
                result = raw.trim();
            }
        }
        else if (task === "enhanceAll") {
            try {
                const parsed = JSON.parse(raw);
                result = {
                    title: ((_5 = parsed["title"]) !== null && _5 !== void 0 ? _5 : "").trim(),
                    summary: ((_6 = parsed["summary"]) !== null && _6 !== void 0 ? _6 : "").trim(),
                    actions: Array.isArray(parsed["actions"])
                        ? parsed["actions"].map(String)
                        : [],
                    tags: Array.isArray(parsed["tags"])
                        ? parsed["tags"].map(String)
                        : [],
                };
            }
            catch (_14) {
                result = { title: "", summary: raw.trim(), actions: [], tags: [] };
            }
        }
        else if (task === "cleanupAndTitle") {
            try {
                const parsed = JSON.parse(raw);
                result = {
                    title: ((_7 = parsed["title"]) !== null && _7 !== void 0 ? _7 : "").trim(),
                    cleanTranscript: ((_8 = parsed["cleanTranscript"]) !== null && _8 !== void 0 ? _8 : "").trim(),
                };
            }
            catch (_15) {
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
            cause: String((_9 = err.cause) !== null && _9 !== void 0 ? _9 : ""),
            status: err.status,
            code: err.code,
            task,
            appId,
        });
        res.status(502).json({ error: (_10 = err.message) !== null && _10 !== void 0 ? _10 : "OpenAI error" });
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