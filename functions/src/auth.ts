import * as admin from "firebase-admin";

export interface AuthResult {
  uid?: string;
  error?: string;
}

/**
 * Verifies Firebase ID token from Authorization header.
 * Returns uid on success, error string on failure.
 */
export async function verifyAuth(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<AuthResult> {
  const authHeader = req.headers["authorization"] ?? req.headers["Authorization"];
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  if (!token) return {error: "Missing Authorization header"};

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return {uid: decoded.uid};
  } catch (e) {
    return {error: (e as Error).message ?? "Invalid token"};
  }
}
