import * as admin from "firebase-admin";

interface UsageRecord {
  appId: string;
  userId: string;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: admin.firestore.FieldValue;
}

/** Approximate cost per 1K tokens (input/output) */
const COST_PER_1K: Record<string, {input: number; output: number}> = {
  "gpt-4o-mini": {input: 0.00015, output: 0.0006},
  "gpt-4o": {input: 0.005, output: 0.015},
  "text-embedding-3-small": {input: 0.00002, output: 0},
  "text-embedding-3-large": {input: 0.00013, output: 0},
  // Transcription is billed per audio minute, not per token, so the values
  // below are placeholders — the actual calls track 0/0 tokens. We keep the
  // entry so a future "track audio seconds → cost" upgrade has a hook.
  "gpt-4o-mini-transcribe": {input: 0.003, output: 0},
};

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rates = COST_PER_1K[model] ?? COST_PER_1K["gpt-4o-mini"];
  return (
    (promptTokens / 1000) * rates.input +
    (completionTokens / 1000) * rates.output
  );
}

export async function trackUsage(opts: {
  appId: string;
  userId: string;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<void> {
  const db = admin.firestore();
  const {appId, userId, feature, model, promptTokens, completionTokens} = opts;
  const totalTokens = promptTokens + completionTokens;
  const costUsd = estimateCost(model, promptTokens, completionTokens);

  const record: UsageRecord = {
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
  batch.set(
    totalsRef,
    {
      totalRequests: admin.firestore.FieldValue.increment(1),
      totalTokens: admin.firestore.FieldValue.increment(totalTokens),
      totalCostUsd: admin.firestore.FieldValue.increment(costUsd),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );

  await batch.commit();
}
