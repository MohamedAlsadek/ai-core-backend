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
/**
 * Verifies Firebase ID token from Authorization header.
 * Returns uid on success, error string on failure.
 */
async function verifyAuth(req) {
    var _a, _b;
    const authHeader = (_a = req.headers["authorization"]) !== null && _a !== void 0 ? _a : req.headers["Authorization"];
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
    if (!token)
        return { error: "Missing Authorization header" };
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return { uid: decoded.uid };
    }
    catch (e) {
        return { error: (_b = e.message) !== null && _b !== void 0 ? _b : "Invalid token" };
    }
}
//# sourceMappingURL=auth.js.map