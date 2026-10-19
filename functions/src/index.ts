import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v2";
import {firestoreReachable} from "./ai/process";

admin.initializeApp();

export const health = functions.https.onRequest(
  {cors: true, invoker: "public"},
  async (req, res) => {
    const db = await firestoreReachable();
    res.json({
      status: "ok",
      version: "1.0.0",
      service: "ai-core-backend",
      firestore: db ? "ok" : "unreachable",
      ts: new Date().toISOString(),
    });
  },
);

// POST /processAi  — generic AI endpoint used by all apps
export {processAi} from "./ai/process";

// POST /transcribeSpeakers — speaker-labelled transcription (voicenote only)
export {transcribeSpeakers} from "./ai/speakers";

// POST /liveSession — live transcription credentials (voicenote only)
export {liveSession} from "./live/session";
