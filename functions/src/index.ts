import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v2";

admin.initializeApp();

// Health check
export const health = functions.https.onRequest(
  {cors: true},
  async (req, res) => {
    res.json({status: "ok", version: "1.0.0", service: "ai-core-backend"});
  },
);

// POST /processAi  ← generic AI endpoint used by all apps
export {processAi} from "./ai/process";
