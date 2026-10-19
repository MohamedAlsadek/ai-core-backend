import * as admin from "firebase-admin";

/**
 * Monthly speaker-labelled live time per client. AssemblyAI bills the time a
 * session is open, so this counts session seconds, reported by the app when
 * each session ends.
 */
export const MONTHLY_ASSEMBLYAI_SECONDS = 4 * 60 * 60;

function usageDoc(clientId: string) {
  const month = new Date().toISOString().slice(0, 7); // e.g. 2026-10
  const id = `voicenote_${clientId}_${month}`
    .replace(/[^a-zA-Z0-9-_]/g, "_")
    .slice(0, 128);
  return admin.firestore().collection("live_usage").doc(id);
}

/** Seconds left this month. Firestore errors grant the full allowance. */
export async function remainingAssemblyAiSeconds(clientId: string): Promise<number> {
  try {
    const snap = await usageDoc(clientId).get();
    const used = snap.get("assemblyaiSeconds");
    return Math.max(0, MONTHLY_ASSEMBLYAI_SECONDS - (typeof used === "number" ? used : 0));
  } catch {
    return MONTHLY_ASSEMBLYAI_SECONDS;
  }
}

export async function recordAssemblyAiSeconds(
  clientId: string,
  seconds: number,
): Promise<void> {
  const counted = Math.round(Math.min(Math.max(seconds, 0), MONTHLY_ASSEMBLYAI_SECONDS));
  if (counted === 0) return;
  await usageDoc(clientId).set(
    {
      clientId,
      assemblyaiSeconds: admin.firestore.FieldValue.increment(counted),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );
}
