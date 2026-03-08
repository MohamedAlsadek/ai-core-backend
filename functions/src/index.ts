import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v2";

admin.initializeApp();

// Health check — confirms the function is deployed and reachable
export const health = functions.https.onRequest(async (req, res) => {
  res.json({status: "ok", version: "1.0.0", service: "ai-core-backend"});
});

// /ai/process — main endpoint (implemented in Step 5)
export {processAi} from "./ai/process";
