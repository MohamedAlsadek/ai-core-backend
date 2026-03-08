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

/** Approximate cost per 1K tokens (input/output) for GPT-4o-mini */
const COST_PER_1K = {
  "gpt-4o-mini": {input: 0.00015, output: 0.0006},
  "gpt-4o": {input: 0.005, output: 0.015},
};

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rates =
    COST_PER_1K[model as keyof typeof COST_PER_1K] ??
    COST_PER_1K["gpt-4o-mini"];
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

  // Store per-request log under: usage/{appId}/requests/{auto-id}
  await db
    .collection("usage")
    .doc(appId)
    .collection("requests")
    .add(record);

  // Update running totals (atomic increment) under: usage/{appId}/totals/all-time
  await db
    .collection("usage")
    .doc(appId)
    .collection("totals")
    .doc("all-time")
    .set(
      {
        totalRequests: admin.firestore.FieldValue.increment(1),
        totalTokens: admin.firestore.FieldValue.increment(totalTokens),
        totalCostUsd: admin.firestore.FieldValue.increment(costUsd),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
}
