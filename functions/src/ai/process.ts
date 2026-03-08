import * as functions from "firebase-functions/v2";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import {buildMessages, TaskPayload} from "./prompts";
import {trackUsage} from "../usage/tracker";

const MODEL = "gpt-4o-mini";

// Supported app IDs — add new apps here
const ALLOWED_APP_IDS = new Set(["voicenote", "fitness", "journal", "default"]);

// Tasks that return structured JSON
const JSON_TASKS = new Set(["enhanceAll", "actions", "tags"]);

export const processAi = functions.https.onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    timeoutSeconds: 60,
    memory: "256MiB",
    cors: true,
  },
  async (req, res) => {
    // ── Method check ────────────────────────────────────────────────────────
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    // ── Auth: verify Firebase ID token ──────────────────────────────────────
    const authHeader = req.headers["authorization"] ?? "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    let userId = "anonymous";
    if (idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        userId = decoded.uid;
      } catch {
        res.status(401).json({error: "Invalid auth token"});
        return;
      }
    }

    // ── Parse body ──────────────────────────────────────────────────────────
    const body = req.body as TaskPayload & {appId?: string};
    const {task, appId = "default"} = body;

    if (!task) {
      res.status(400).json({error: "Missing required field: task"});
      return;
    }

    if (!ALLOWED_APP_IDS.has(appId)) {
      res.status(400).json({error: `Unknown appId: ${appId}`});
      return;
    }

    // ── Device ID (for rate limiting later) ─────────────────────────────────
    const deviceId = (req.headers["x-device-id"] as string) ?? "unknown";

    // ── Build messages ──────────────────────────────────────────────────────
    let messages: {role: "user" | "assistant" | "system"; content: string}[];
    try {
      messages = buildMessages(body);
    } catch (e) {
      res.status(400).json({error: (e as Error).message});
      return;
    }

    // ── Call OpenAI ─────────────────────────────────────────────────────────
    const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

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

      // ── Parse result ────────────────────────────────────────────────────
      let result: unknown;

      if (task === "enhanceAll") {
        try {
          const parsed = JSON.parse(raw);
          result = {
            title: (parsed.title as string | undefined ?? "").trim(),
            summary: (parsed.summary as string | undefined ?? "").trim(),
            actions: Array.isArray(parsed.actions)
              ? parsed.actions.map(String)
              : [],
            tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
          };
        } catch {
          result = {title: "", summary: raw, actions: [], tags: []};
        }
      } else if (task === "actions" || task === "tags") {
        try {
          const parsed = JSON.parse(raw);
          result = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          result = [];
        }
      } else {
        result = raw.trim();
      }

      // ── Track usage (fire-and-forget, don't block response) ─────────────
      trackUsage({
        appId,
        userId: userId === "anonymous" ? deviceId : userId,
        feature: task,
        model: MODEL,
        promptTokens,
        completionTokens,
      }).catch(() => {/* non-fatal */});

      res.json({result, tokensUsed: promptTokens + completionTokens});
    } catch (e) {
      const msg = (e as Error).message ?? "OpenAI error";
      functions.logger.error("[processAi] OpenAI error", {msg, task, appId});
      res.status(502).json({error: msg});
    }
  },
);
