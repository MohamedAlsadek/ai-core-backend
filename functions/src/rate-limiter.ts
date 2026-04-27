import * as admin from "firebase-admin";

// Daily request cap per (appId, clientId).
//
// Sized for real-user workloads, not power abuse. A heavy day for a single
// person on a voice-notes app is ~10–25 ops (transcribe + enhanceAll + a
// few chat turns). 30 leaves comfortable headroom while keeping the
// per-bucket cost bounded if a client bypasses auth.
//
// Note: this alone does NOT stop abuse from rotating x-device-id values —
// for that, enforce App Check + mandatory verified UID.
const RATE_LIMIT_PER_DAY = 30;

/** Derive a stable client ID from token, device header, or IP. */
export function getClientId(
  req: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
  },
  uid?: string,
): string {
  if (uid) return `uid_${uid}`;

  const deviceId =
    req.headers["x-device-id"] ?? req.headers["X-Device-ID"];
  if (deviceId && typeof deviceId === "string" && deviceId.length > 0) {
    return `d_${deviceId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 64)}`;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(",")[0]
        .trim()
    : req.ip ?? "unknown";
  return `ip_${ip.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
}

function docId(clientId: string, appId: string): string {
  return `${appId}_${clientId}`.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 128);
}

/**
 * Atomically checks and increments the daily request count.
 * Returns {allowed: true} or {allowed: false}.
 * On Firestore error, allows the request so the app never breaks.
 */
export async function checkRateLimit(
  clientId: string,
  appId: string,
): Promise<{allowed: boolean; remaining: number}> {
  const db = admin.firestore();
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection("rate_limits").doc(docId(clientId, appId));

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
      const isNewDay = !data || data["date"] !== today;
      const requests = isNewDay ? 0 : ((data?.["requests"] as number) ?? 0);

      if (requests >= RATE_LIMIT_PER_DAY) {
        return {allowed: false, remaining: 0};
      }

      tx.set(ref, {
        date: today,
        requests: requests + 1,
        appId,
        clientId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {allowed: true, remaining: RATE_LIMIT_PER_DAY - requests - 1};
    });
  } catch {
    // Allow when Firestore is unavailable — never break the app
    return {allowed: true, remaining: -1};
  }
}
