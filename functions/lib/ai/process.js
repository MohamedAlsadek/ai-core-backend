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
// Tasks that return structured JSON from OpenAI
const JSON_TASKS = new Set(["enhanceAll", "actions", "tags"]);
// Allowed app IDs — add new apps here when onboarding them
const ALLOWED_APP_IDS = new Set([
    "voicenote",
    "fitness",
    "journal",
    "default",
]);
exports.processAi = functions.https.onRequest({
    secrets: [openaiKey],
    timeoutSeconds: 60,
    memory: "256MiB",
    cors: true,
    invoker: "public",
}, async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
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
    catch (_p) {
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
    // ── Auth ───────────────────────────────────────────────────────────────
    const auth = await (0, auth_1.verifyAuth)(req);
    if (!auth.uid) {
        res
            .status(401)
            .json({ error: (_b = auth.error) !== null && _b !== void 0 ? _b : "Unauthorized", code: "UNAUTHORIZED" });
        return;
    }
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
    // ── Build messages ─────────────────────────────────────────────────────
    let messages;
    try {
        messages = (0, prompts_1.buildMessages)(body);
    }
    catch (e) {
        res.status(400).json({ error: e.message });
        return;
    }
    // ── Call OpenAI ────────────────────────────────────────────────────────
    const openai = new openai_1.default({ apiKey });
    try {
        const isJson = JSON_TASKS.has(task);
        const completion = await openai.chat.completions.create(Object.assign({ model: MODEL, messages, temperature: 0.3, max_tokens: task === "chat" ? 1024 : 512 }, (isJson ? { response_format: { type: "json_object" } } : {})));
        const raw = (_e = (_d = (_c = completion.choices[0]) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.content) !== null && _e !== void 0 ? _e : "";
        const promptTokens = (_g = (_f = completion.usage) === null || _f === void 0 ? void 0 : _f.prompt_tokens) !== null && _g !== void 0 ? _g : 0;
        const completionTokens = (_j = (_h = completion.usage) === null || _h === void 0 ? void 0 : _h.completion_tokens) !== null && _j !== void 0 ? _j : 0;
        const totalTokens = promptTokens + completionTokens;
        // ── Parse result ────────────────────────────────────────────────────
        let result;
        if (task === "enhanceAll") {
            try {
                const parsed = JSON.parse(raw);
                result = {
                    title: ((_k = parsed["title"]) !== null && _k !== void 0 ? _k : "").trim(),
                    summary: ((_l = parsed["summary"]) !== null && _l !== void 0 ? _l : "").trim(),
                    actions: Array.isArray(parsed["actions"])
                        ? parsed["actions"].map(String)
                        : [],
                    tags: Array.isArray(parsed["tags"])
                        ? parsed["tags"].map(String)
                        : [],
                };
            }
            catch (_q) {
                result = { title: "", summary: raw.trim(), actions: [], tags: [] };
            }
        }
        else if (task === "actions" || task === "tags") {
            try {
                const parsed = JSON.parse(raw);
                result = Array.isArray(parsed) ? parsed.map(String) : [];
            }
            catch (_r) {
                result = [];
            }
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
        }).catch(() => {
            /* non-fatal */
        });
        res.json({ result, tokensUsed: totalTokens });
    }
    catch (e) {
        const err = e;
        functions.logger.error("[processAi] OpenAI error", {
            msg: err.message,
            cause: String((_m = err.cause) !== null && _m !== void 0 ? _m : ""),
            status: err.status,
            code: err.code,
            task,
            appId,
        });
        res.status(502).json({ error: (_o = err.message) !== null && _o !== void 0 ? _o : "OpenAI error" });
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