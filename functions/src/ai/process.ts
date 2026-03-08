import * as functions from "firebase-functions/v2";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import {defineSecret} from "firebase-functions/params";
import {buildMessages, TaskPayload, TaskType} from "./prompts";
import {trackUsage} from "../usage/tracker";
import {verifyAuth} from "../auth";
import {checkRateLimit, getClientId} from "../rate-limiter";

const openaiKey = defineSecret("OPENAI_API_KEY");
const MODEL = "gpt-4o-mini";
const EMBED_MODEL = "text-embedding-3-small";

// Tasks that return structured JSON from OpenAI
const JSON_TASKS = new Set<TaskType>(["enhanceAll", "actions", "tags"]);
// Tasks that don't go through the chat completions path
const NON_CHAT_TASKS = new Set<TaskType>(["embed"]);

// Allowed app IDs — add new apps here when onboarding them
const ALLOWED_APP_IDS = new Set([
  "voicenote",
  "fitness",
  "journal",
  "default",
]);

export const processAi = functions.https.onRequest(
  {
    secrets: [openaiKey],
    timeoutSeconds: 60,
    memory: "256MiB",
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    // ── Method ─────────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    let body: TaskPayload & {appId?: string};
    try {
      body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    } catch {
      res.status(400).json({error: "Invalid JSON body"});
      return;
    }

    const {task, appId = "default"} = body;

    if (!task) {
      res.status(400).json({error: "Missing required field: task"});
      return;
    }

    if (!ALLOWED_APP_IDS.has(appId)) {
      res.status(400).json({error: `Unknown appId: ${appId}`});
      return;
    }

    // ── Auth ───────────────────────────────────────────────────────────────
    const auth = await verifyAuth(req as Parameters<typeof verifyAuth>[0]);
    if (!auth.uid) {
      res
        .status(401)
        .json({error: auth.error ?? "Unauthorized", code: "UNAUTHORIZED"});
      return;
    }

    // ── Rate limit ─────────────────────────────────────────────────────────
    const clientId = getClientId(
      req as Parameters<typeof getClientId>[0],
      auth.uid,
    );
    const {allowed, remaining} = await checkRateLimit(clientId, appId);
    if (!allowed) {
      res.status(429).json({
        error: "Rate limit exceeded. Try again tomorrow.",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    // Expose remaining requests in headers
    if (remaining >= 0) {
      res.setHeader("X-RateLimit-Remaining", remaining);
    }

    // ── Validate API key ───────────────────────────────────────────────────
    const apiKey = openaiKey.value().trim();
    if (!apiKey) {
      res.status(500).json({error: "OPENAI_API_KEY not configured"});
      return;
    }

    const openai = new OpenAI({apiKey});

    // ── Embed task (separate path) ─────────────────────────────────────────
    if (NON_CHAT_TASKS.has(task)) {
      if (task === "embed") {
        const texts = body.texts ?? [];
        if (!Array.isArray(texts) || texts.length === 0) {
          res.status(400).json({error: "embed task requires a non-empty texts array"});
          return;
        }
        if (texts.length > 2048) {
          res.status(400).json({error: "Max 2048 texts per embed request"});
          return;
        }
        try {
          const response = await openai.embeddings.create({
            model: EMBED_MODEL,
            input: texts,
          });
          const ordered = Array<unknown>(texts.length).fill(null);
          for (const item of response.data ?? []) {
            if (item.index >= 0 && item.index < texts.length) {
              ordered[item.index] = item.embedding;
            }
          }
          const embeddings = ordered.filter((e) => e !== null);
          const totalTokens = response.usage?.total_tokens ?? 0;
          trackUsage({appId, userId: clientId, feature: "embed", model: EMBED_MODEL, promptTokens: totalTokens, completionTokens: 0}).catch(() => {});
          res.json({result: embeddings, tokensUsed: totalTokens});
        } catch (e) {
          const err = e as Error;
          functions.logger.error("[processAi] embed error", {msg: err.message, appId});
          res.status(502).json({error: err.message ?? "Embed error"});
        }
        return;
      }
    }

    // ── Build messages ─────────────────────────────────────────────────────
    let messages: {role: "user" | "assistant" | "system"; content: string}[];
    try {
      messages = buildMessages(body);
    } catch (e) {
      res.status(400).json({error: (e as Error).message});
      return;
    }

    // ── Chat completion ────────────────────────────────────────────────────
    try {
      const isJson = JSON_TASKS.has(task);
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages,
        temperature: 0.3,
        max_tokens: task === "chat" ? 1024 : 512,
        ...(isJson ? {response_format: {type: "json_object"}} : {}),
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const totalTokens = promptTokens + completionTokens;

      // ── Parse result ────────────────────────────────────────────────────
      let result: unknown;

      if (task === "enhanceAll") {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          result = {
            title: ((parsed["title"] as string | undefined) ?? "").trim(),
            summary: ((parsed["summary"] as string | undefined) ?? "").trim(),
            actions: Array.isArray(parsed["actions"])
              ? (parsed["actions"] as unknown[]).map(String)
              : [],
            tags: Array.isArray(parsed["tags"])
              ? (parsed["tags"] as unknown[]).map(String)
              : [],
          };
        } catch {
          result = {title: "", summary: raw.trim(), actions: [], tags: []};
        }
      } else if (task === "actions" || task === "tags") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          result = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          result = [];
        }
      } else {
        result = raw.trim();
      }

      // ── Track usage (fire-and-forget) ────────────────────────────────────
      trackUsage({
        appId,
        userId: clientId,
        feature: task,
        model: MODEL,
        promptTokens,
        completionTokens,
      }).catch(() => {/* non-fatal */});

      res.json({result, tokensUsed: totalTokens});
    } catch (e) {
      const err = e as Error & {
        status?: number;
        code?: string;
        cause?: unknown;
      };
      functions.logger.error("[processAi] OpenAI error", {
        msg: err.message,
        cause: String(err.cause ?? ""),
        status: err.status,
        code: err.code,
        task,
        appId,
      });
      res.status(502).json({error: err.message ?? "OpenAI error"});
    }
  },
);

// ── Helper: verify Firestore is reachable (called by health check) ────────────
export async function firestoreReachable(): Promise<boolean> {
  try {
    await admin.firestore().collection("_health").limit(1).get();
    return true;
  } catch {
    return false;
  }
}
