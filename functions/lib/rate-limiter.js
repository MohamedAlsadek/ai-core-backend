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
exports.getClientId = getClientId;
exports.checkRateLimit = checkRateLimit;
const admin = __importStar(require("firebase-admin"));
const RATE_LIMIT_PER_DAY = 100;
/** Derive a stable client ID from token, device header, or IP. */
function getClientId(req, uid) {
    var _a, _b;
    if (uid)
        return `uid_${uid}`;
    const deviceId = (_a = req.headers["x-device-id"]) !== null && _a !== void 0 ? _a : req.headers["X-Device-ID"];
    if (deviceId && typeof deviceId === "string" && deviceId.length > 0) {
        return `d_${deviceId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 64)}`;
    }
    const forwarded = req.headers["x-forwarded-for"];
    const ip = forwarded
        ? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
            .split(",")[0]
            .trim()
        : (_b = req.ip) !== null && _b !== void 0 ? _b : "unknown";
    return `ip_${ip.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
}
function docId(clientId, appId) {
    return `${appId}_${clientId}`.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 128);
}
/**
 * Atomically checks and increments the daily request count.
 * Returns {allowed: true} or {allowed: false}.
 * On Firestore error, allows the request so the app never breaks.
 */
async function checkRateLimit(clientId, appId) {
    const db = admin.firestore();
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection("rate_limits").doc(docId(clientId, appId));
    try {
        return await db.runTransaction(async (tx) => {
            var _a;
            const snap = await tx.get(ref);
            const data = snap.exists ? snap.data() : null;
            const isNewDay = !data || data["date"] !== today;
            const requests = isNewDay ? 0 : ((_a = data === null || data === void 0 ? void 0 : data["requests"]) !== null && _a !== void 0 ? _a : 0);
            if (requests >= RATE_LIMIT_PER_DAY) {
                return { allowed: false, remaining: 0 };
            }
            tx.set(ref, {
                date: today,
                requests: requests + 1,
                appId,
                clientId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return { allowed: true, remaining: RATE_LIMIT_PER_DAY - requests - 1 };
        });
    }
    catch (_a) {
        // Allow when Firestore is unavailable — never break the app
        return { allowed: true, remaining: -1 };
    }
}
//# sourceMappingURL=rate-limiter.js.map