import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v2";

export interface AuthResult {
  /** Firebase UID if token verified successfully. */
  uid?: string;
  /** True if a token was present but couldn't be verified (wrong project, expired, etc.). */
  tokenRejected?: boolean;
}

/**
 * Verifies a Firebase ID token from the Authorization header.
 *
 * Multi-app design: apps (voicenote, fitness, etc.) each have their own Firebase
 * project and send tokens signed for that project. We cannot verify cross-project
 * tokens with Admin SDK, so if verification fails we fall back to device-ID-based
 * rate limiting (still secure — no anonymous free-for-all).
 *
 * Returns:
 *   { uid }              — verified token, use uid for rate limiting
 *   { tokenRejected }   — token present but unverifiable (cross-project), fall back to device ID
 *   {}                  — no token, fall back to device ID
 */
export async function verifyAuth(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<AuthResult> {
  const authHeader =
    req.headers["authorization"] ?? req.headers["Authorization"];
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!token) return {};

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {uid: decoded.uid};
  } catch (e) {
    // Expected when apps send tokens from their own Firebase project.
    // Fall back to device-ID rate limiting — don't block the request.
    functions.logger.debug("[auth] Cross-project token, falling back to device ID", {
      msg: (e as Error).message?.slice(0, 120),
    });
    return {tokenRejected: true};
  }
}
