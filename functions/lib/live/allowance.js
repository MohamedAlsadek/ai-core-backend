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
exports.MONTHLY_ASSEMBLYAI_SECONDS = void 0;
exports.remainingAssemblyAiSeconds = remainingAssemblyAiSeconds;
exports.recordAssemblyAiSeconds = recordAssemblyAiSeconds;
const admin = __importStar(require("firebase-admin"));
/**
 * Monthly speaker-labelled live time per client. AssemblyAI bills the time a
 * session is open, so this counts session seconds, reported by the app when
 * each session ends.
 */
exports.MONTHLY_ASSEMBLYAI_SECONDS = 4 * 60 * 60;
function usageDoc(clientId) {
    const month = new Date().toISOString().slice(0, 7); // e.g. 2026-10
    const id = `voicenote_${clientId}_${month}`
        .replace(/[^a-zA-Z0-9-_]/g, "_")
        .slice(0, 128);
    return admin.firestore().collection("live_usage").doc(id);
}
/** Seconds left this month. Firestore errors grant the full allowance. */
async function remainingAssemblyAiSeconds(clientId) {
    try {
        const snap = await usageDoc(clientId).get();
        const used = snap.get("assemblyaiSeconds");
        return Math.max(0, exports.MONTHLY_ASSEMBLYAI_SECONDS - (typeof used === "number" ? used : 0));
    }
    catch (_a) {
        return exports.MONTHLY_ASSEMBLYAI_SECONDS;
    }
}
async function recordAssemblyAiSeconds(clientId, seconds) {
    const counted = Math.round(Math.min(Math.max(seconds, 0), exports.MONTHLY_ASSEMBLYAI_SECONDS));
    if (counted === 0)
        return;
    await usageDoc(clientId).set({
        clientId,
        assemblyaiSeconds: admin.firestore.FieldValue.increment(counted),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
}
//# sourceMappingURL=allowance.js.map