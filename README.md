# AI Core Backend

A shared AI backend powered by Firebase Cloud Functions, designed to serve multiple mobile apps.

## Architecture

```
Apps (Flutter)
  └── Voice Notes AI
  └── Future apps (fitness, journaling, etc.)
        │
        ▼
Shared AI Core Backend (Firebase Cloud Functions)
  ├── POST /ai/process   ← generic AI endpoint
  ├── OpenAI integration
  ├── Prompt management
  ├── Rate limiting
  ├── Usage tracking
  └── Cost monitoring
        │
        ▼
OpenAI API
```

## Apps Supported

| App | Status |
|-----|--------|
| Voice Notes AI | 🔄 Migrating |
| Future apps | 📋 Planned |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /ai/process` | Generic AI processing (transcription, summarization, etc.) |

## Usage Tracking

Each request tracks:
- `appId` — which app made the request
- `userId` — anonymous device ID
- `feature` — which feature was used (e.g. `enhance`, `tags`, `chat`)
- `model` — OpenAI model used
- `tokensUsed` — prompt + completion tokens
- `costUsd` — estimated cost

## Tech Stack

- **Runtime**: Node.js 20 (Firebase Cloud Functions)
- **Database**: Firestore (usage tracking)
- **Secrets**: Firebase Secret Manager (OpenAI key)
- **Auth**: Firebase Anonymous Auth (per-app verification)

## Setup

See `docs/SETUP.md` for step-by-step setup instructions.
