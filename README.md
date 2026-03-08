# AI Core Backend

A shared AI backend powered by Firebase Cloud Functions (Gen 2), designed to serve multiple mobile apps. All OpenAI API calls are centralized here — apps never touch the API key.

## Architecture

```
Apps (Flutter / Web / etc.)
  ├── Voice Notes AI (voicenote)
  ├── Fitness app (fitness)
  ├── Journal app (journal)
  └── Future apps...
        │
        ▼
Shared AI Core Backend (Firebase Cloud Functions)
  ├── POST /processAi   ← generic AI endpoint
  ├── GET  /health     ← health check
  ├── OpenAI integration (gpt-4o-mini, text-embedding-3-small)
  ├── Rate limiting (100 req/day per user per app)
  ├── Usage tracking (Firestore)
  └── Cross-project auth (Firebase token or device-ID fallback)
        │
        ▼
OpenAI API
```

## Live URLs

| Endpoint | URL |
|----------|-----|
| AI processing | `https://processai-juzovy6pna-uc.a.run.app` |
| Health check | `https://health-juzovy6pna-uc.a.run.app` |

---

## Onboarding New Apps

### Step 1: Add your app ID

Edit `functions/src/ai/process.ts` and add your app ID to `ALLOWED_APP_IDS`:

```ts
const ALLOWED_APP_IDS = new Set([
  "voicenote",
  "fitness",
  "journal",
  "mynewapp",  // ← add your app
  "default",
]);
```

### Step 2: Deploy the backend

From the `ai-core-backend` project root:

```bash
cd /path/to/ai-core-backend
firebase deploy --only functions
```

### Step 3: Integrate in your app

1. **Base URL** — Use the process endpoint: `https://processai-juzovy6pna-uc.a.run.app`
2. **Request body** — Always include `appId` and `task` (see API reference below)
3. **Headers** (recommended):
   - `Authorization: Bearer <firebase-id-token>` — if your app uses Firebase Auth
   - `X-Device-ID: <stable-device-id>` — for rate limiting when token can't be verified (e.g. cross-project)

**Auth behavior:**
- If the token is from the **same** Firebase project as the core backend → verified, rate limit by `uid`
- If the token is from a **different** project (e.g. your app's Firebase) → falls back to device-ID rate limiting (no 401)
- If no token → uses `X-Device-ID` or IP for rate limiting

---

## API Reference

### POST /processAi

Generic AI endpoint. All requests must be `POST` with `Content-Type: application/json`.

#### Request body (required fields)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | ✅ | One of: `summarize`, `title`, `actions`, `tags`, `chat`, `enhanceAll`, `custom`, `embed` |
| `appId` | string | ✅ | Your app ID (must be in `ALLOWED_APP_IDS`). Default: `"default"` |

#### Tasks and payloads

| Task | Extra fields | Response |
|------|--------------|----------|
| `summarize` | `note: { transcription, title?, ... }` | `{ result: string }` |
| `title` | `note: { transcription, ... }` | `{ result: string }` |
| `actions` | `note: { transcription, ... }` | `{ result: string[] }` |
| `tags` | `note`, `existingTags?: string[]` | `{ result: string[] }` |
| `enhanceAll` | `note`, `existingTags?: string[]` | `{ result: { title, summary, actions, tags } }` |
| `chat` | `messages: [{ role, content }]`, `contextNotes?`, `contextChunks?` | `{ result: string }` |
| `custom` | `systemPrompt`, `userPrompt` | `{ result: string }` |
| `embed` | `texts: string[]` (max 2048) | `{ result: number[][] }` |

#### Note object shape

```json
{
  "id": 1,
  "title": "Optional",
  "userTitle": "Optional",
  "aiTitle": "Optional",
  "summary": "Optional",
  "aiSummary": "Optional",
  "transcription": "Required for note-based tasks",
  "createdAt": "ISO8601 string"
}
```

#### Response

Success: `{ result: <task-specific>, tokensUsed: number }`  
Error: `{ error: string, code?: string }` (e.g. `RATE_LIMIT_EXCEEDED`)

#### Rate limit header

`X-RateLimit-Remaining` — remaining requests for today (when available).

---

## Flutter integration example

```dart
// 1. Constants
static const String processAiUrl = 'https://processai-juzovy6pna-uc.a.run.app';
static const String appId = 'mynewapp';

// 2. POST with headers
final response = await dio.post(
  processAiUrl,
  data: {
    'appId': appId,
    'task': 'summarize',
    'note': {
      'transcription': 'Meeting notes...',
      'title': 'Optional title',
    },
  },
  options: Options(
    headers: {
      if (idToken != null) 'Authorization': 'Bearer $idToken',
      if (deviceId != null) 'X-Device-ID': deviceId,
    },
  ),
);

// 3. Handle response
final result = response.data['result'];
final tokensUsed = response.data['tokensUsed'];
```

**Embeddings:**

```dart
final response = await dio.post(
  processAiUrl,
  data: {
    'appId': appId,
    'task': 'embed',
    'texts': ['First text', 'Second text'],
  },
  options: Options(headers: {...}),
);
final embeddings = response.data['result'] as List; // List<List<double>>
```

---

## Rate limiting

- **Limit:** 100 requests per day per user (or device) per app
- **Scope:** Per `appId` + `clientId` (uid, device ID, or IP)
- **429 response:** `{ error: "Rate limit exceeded. Try again tomorrow.", code: "RATE_LIMIT_EXCEEDED" }`

---

## Usage tracking

Each request is logged in Firestore:

- **Collection:** `usage/{appId}/requests/`
- **Fields:** `userId`, `feature` (task), `model`, `promptTokens`, `completionTokens`, `costUsd`, `timestamp`

---

## Tech stack

- **Runtime:** Node.js 20 (Firebase Cloud Functions Gen 2)
- **Database:** Firestore (usage, rate limits)
- **Secrets:** Firebase Secret Manager (`OPENAI_API_KEY`)
- **Models:** gpt-4o-mini (chat), text-embedding-3-small (embeddings)

---

## Setup (first-time)

See `docs/SETUP.md` for:

- Firebase project creation
- Secret Manager configuration
- Deploying functions

---

## Apps supported

| App ID | Status |
|--------|--------|
| voicenote | ✅ Live |
| fitness | 📋 Pre-registered |
| journal | 📋 Pre-registered |
| default | Fallback for testing |
