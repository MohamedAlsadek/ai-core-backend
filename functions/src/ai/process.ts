import * as functions from "firebase-functions/v2";

// Placeholder — full implementation added in Step 5
export const processAi = functions.https.onRequest(async (req, res) => {
  res.status(501).json({error: "Not implemented yet — coming in Step 5"});
});
