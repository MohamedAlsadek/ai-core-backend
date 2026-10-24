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
exports.transcribeFile = exports.liveSession = exports.transcribeSpeakers = exports.processAi = exports.health = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions/v2"));
const process_1 = require("./ai/process");
admin.initializeApp();
exports.health = functions.https.onRequest({ cors: true, invoker: "public" }, async (req, res) => {
    const db = await (0, process_1.firestoreReachable)();
    res.json({
        status: "ok",
        version: "1.0.0",
        service: "ai-core-backend",
        firestore: db ? "ok" : "unreachable",
        ts: new Date().toISOString(),
    });
});
// POST /processAi  — generic AI endpoint used by all apps
var process_2 = require("./ai/process");
Object.defineProperty(exports, "processAi", { enumerable: true, get: function () { return process_2.processAi; } });
// POST /transcribeSpeakers — speaker-labelled transcription (voicenote only)
var speakers_1 = require("./ai/speakers");
Object.defineProperty(exports, "transcribeSpeakers", { enumerable: true, get: function () { return speakers_1.transcribeSpeakers; } });
// POST /liveSession — live transcription credentials (voicenote only)
var session_1 = require("./live/session");
Object.defineProperty(exports, "liveSession", { enumerable: true, get: function () { return session_1.liveSession; } });
// POST /transcribeFile — AssemblyAI file transcription (voicenote only)
var file_1 = require("./transcription/file");
Object.defineProperty(exports, "transcribeFile", { enumerable: true, get: function () { return file_1.transcribeFile; } });
//# sourceMappingURL=index.js.map