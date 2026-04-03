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
exports.trackUsage = trackUsage;
const admin = __importStar(require("firebase-admin"));
/** Approximate cost per 1K tokens (input/output) */
const COST_PER_1K = {
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
    "gpt-4o": { input: 0.005, output: 0.015 },
    "text-embedding-3-small": { input: 0.00002, output: 0 },
    "text-embedding-3-large": { input: 0.00013, output: 0 },
    "whisper-1": { input: 0.006, output: 0 },
};
function estimateCost(model, promptTokens, completionTokens) {
    var _a;
    const rates = (_a = COST_PER_1K[model]) !== null && _a !== void 0 ? _a : COST_PER_1K["gpt-4o-mini"];
    return ((promptTokens / 1000) * rates.input +
        (completionTokens / 1000) * rates.output);
}
async function trackUsage(opts) {
    const db = admin.firestore();
    const { appId, userId, feature, model, promptTokens, completionTokens } = opts;
    const totalTokens = promptTokens + completionTokens;
    const costUsd = estimateCost(model, promptTokens, completionTokens);
    const record = {
        appId,
        userId,
        feature,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    const batch = db.batch();
    const requestRef = db
        .collection("usage")
        .doc(appId)
        .collection("requests")
        .doc();
    batch.set(requestRef, record);
    const totalsRef = db
        .collection("usage")
        .doc(appId)
        .collection("totals")
        .doc("all-time");
    batch.set(totalsRef, {
        totalRequests: admin.firestore.FieldValue.increment(1),
        totalTokens: admin.firestore.FieldValue.increment(totalTokens),
        totalCostUsd: admin.firestore.FieldValue.increment(costUsd),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await batch.commit();
}
//# sourceMappingURL=tracker.js.map