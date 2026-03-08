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
exports.verifyAuth = verifyAuth;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions/v2"));
/**
 * Verifies a Firebase ID token from the Authorization header.
 *
 * Multi-app design: apps (voicenote, fitness, etc.) each have their own Firebase
 * project and send tokens signed for that project. We cannot verify cross-project
 * tokens with Admin SDK, so if verification fails we fall back to device-ID-based
 * rate limiting (still secure — no anonymous free-for-all).
 *
 * Returns:
 *   { uid }              — verified token, use uid for rate limiting
 *   { tokenRejected }   — token present but unverifiable (cross-project), fall back to device ID
 *   {}                  — no token, fall back to device ID
 */
async function verifyAuth(req) {
    var _a, _b;
    const authHeader = (_a = req.headers["authorization"]) !== null && _a !== void 0 ? _a : req.headers["Authorization"];
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
    if (!token)
        return {};
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return { uid: decoded.uid };
    }
    catch (e) {
        // Expected when apps send tokens from their own Firebase project.
        // Fall back to device-ID rate limiting — don't block the request.
        functions.logger.debug("[auth] Cross-project token, falling back to device ID", {
            msg: (_b = e.message) === null || _b === void 0 ? void 0 : _b.slice(0, 120),
        });
        return { tokenRejected: true };
    }
}
//# sourceMappingURL=auth.js.map