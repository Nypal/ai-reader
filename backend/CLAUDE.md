# CLAUDE.md — Alphie Backend

> Backend-specific memory, loaded when Claude works in `backend/`.
> Project-wide rules, deployment and decisions live in the root `CLAUDE.md`.

---

## Overview

The backend exists only to keep the OpenAI and Azure keys server-side.
It runs in two forms that share the same logic:

| File | Role |
|------|------|
| `lib/core.js` | **All business logic**: prompts, TTS engines, text normalisation, exam parsing, input validation |
| `server.js` | Express entry point for local dev (port `3001`) |
| `../worker/src/index.js` | Cloudflare Worker entry point (`alphie-api`), used in production |

**Change behaviour in `lib/core.js`, not in the entry points.** It must stay
runtime-agnostic: only `fetch`, `crypto.subtle`, `TextEncoder` — no Node-only
modules, no OpenAI SDK (OpenAI and Azure are called over REST with `fetch`).

After changing `lib/core.js`, redeploy the Worker (`cd worker && npx wrangler deploy`).

---

## Environment Variables

Same names on Express (`backend/.env`) and the Worker (`wrangler.toml` vars or secrets).

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI key (Worker: secret) |
| `AZURE_SPEECH_KEY` | No | Enables Azure Neural voices (Worker: secret) |
| `AZURE_SPEECH_REGION` | No | `francecentral` (resource `alphie-speech-tts`) |
| `TTS_MODEL` | No | OpenAI TTS model, default `gpt-4o-mini-tts` |
| `API_SECRET` | No | If set, every route except `/api/health` needs `Authorization: Bearer <secret>`. **Keep it unset**: `src/lib/api.ts` sends no token, so setting it breaks the app |
| `TTS_MAX_TEXT_CHARS` | No | Max chars per `/api/tts` call (default 5000) |
| `EXAM_PARSE_MAX_TEXT_CHARS` | No | Max exam text (default 75000) |
| `EXAM_PARSE_MAX_CHUNKS` | No | Max 12k-char chunks per exam (default 8) |
| `EXAM_PARSE_CONCURRENCY` | No | Chunks parsed in parallel (default 2) |
| `PORT` | No | Express only, default `3001` |
| `TTS_CACHE_DIR`, `TTS_CACHE_MAX_FILES` | No | Express only: disk cache location / size (default 500 files) |
| `FRONTEND_URL` | No | Express only: allowed origin when `NODE_ENV=production` |
| `ALLOWED_ORIGINS` | No | Worker only: comma-separated CORS origins |

Missing or `dummy_key` OpenAI key → AI and TTS routes return 500
`OpenAI API key missing in backend/.env`.

---

## API Endpoints

Errors are always `{ error: string }`. Validation errors are `HttpError`s
(400/422) with a readable message; other failures return a generic 500 message
and are logged server-side — raw OpenAI/Azure errors never reach the client.

### `GET /api/health`
`{ status: 'ok', openaiKeyLoaded: boolean, azureVoicesAvailable: boolean }`.
The frontend lists Azure voices only when `azureVoicesAvailable` is true.

### `POST /api/tts`
```
Body:     { text: string, voice?: string = 'alloy', lang?: 'en' | 'fr' = 'en' }
Response: audio/mpeg (200, or 206 with a Range header) — 204 if text normalises to nothing
```
- `normalizeText` strips URLs, emails, Markdown and expands abbreviations (FR/EN)
- Engine order: Azure (only if voice starts with `azure:` and Azure is configured)
  → OpenAI `TTS_MODEL` → `tts-1`. The first engine that succeeds wins.
- `gpt-4o-mini-tts` gets per-language narrator instructions (`TTS_INSTRUCTIONS`);
  French gets a native-French-accent prompt
- `tts-1` in French forces `onyx` unless the voice is `onyx`/`echo` (other voices sound English)
- An `azure:` voice falls back to OpenAI `nova` when Azure is unavailable or fails
- Azure voices must be in `AZURE_ALLOWED_VOICES` (keep in sync with `src/lib/voices.ts`);
  a non-multilingual voice reading another language is swapped for that language's default
  (`fr-FR-VivienneMultilingualNeural`, `en-US-AvaMultilingualNeural`)
- Each engine has its own cache key = SHA-256 of `text + voice + lang + model + instructions`,
  so changing the model or instructions never serves stale audio
- Cache: Express → `tts-cache/*.mp3` on disk (LRU by mtime, files < 1 KB treated as corrupt);
  Worker → Cloudflare Cache API
- Express also caps concurrent syntheses at 5

### `POST /api/quiz` (alias `/api/questions`)
```
Body:     { text: string, lang?: string = 'en' }
Response: { questions: [{ type: 'main'|'detail'|'apply', question, options[4], correct, explanation, reference }],
            openQuestion: string }
```
`gpt-4o-mini`, 4 MCQ (`correct` = 0-based index) + 1 open question.

### `POST /api/evaluate`
```
Body:     { question: string, answer: string, originalText: string }
Response: { understandingScore: 0-10, expressionScore: 0-10, didWell, missing, improved }
```
`gpt-4o-mini` coach feedback on the open question. This is the "Feynman test" flow —
there is **no** `/api/feynman` endpoint.

### `POST /api/parse-exam`
```
Body:     { text: string }
Response: { questions: [{ type: 'exam', question, options, correctAnswerIndex, correctAnswerIndices,
                          requiredSelections, explanation, examExplanation: { bestNow, notLabel, notReason } }] }
```
`gpt-4o`. Text is split into ~12k-char chunks at question boundaries (`splitExamText`),
parsed in batches of `EXAM_PARSE_CONCURRENCY`. Returns 422 when no MCQ is found.
Handles multi-select ("Pick TWO") questions.

### `POST /api/sentences`
`{ text } → { sentences: string[] }`. Server-side splitter, unused by the frontend.

---

## Rate Limits (per IP, per minute)

| Scope | Express (`express-rate-limit`) | Worker (`[[ratelimits]]`) |
|-------|-------------------------------|---------------------------|
| All routes | 100 | — |
| `/api/tts` | 200 | `TTS_LIMITER` 200 |
| Quiz / evaluate / parse-exam | 10 | `AI_LIMITER` 10 |

---

## Running

```bash
cd backend && node server.js                              # Express on :3001
cd worker && npx wrangler dev --env-file ../backend/.env   # Worker on :8787
```
No hot reload on Express — restart after changes.

---

## Common Issues

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `EADDRINUSE :3001` | Port in use | Stop the other process or set `PORT` |
| `Failed to fetch` in frontend | Backend not running, or origin not allowed | Start the server; add the origin to `ALLOWED_ORIGINS` / `FRONTEND_URL` |
| 401 `Unauthorized` | `API_SECRET` is set, but the frontend sends no token | Unset `API_SECRET` |
| No Azure voices in the UI | `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` missing | Check `/api/health` → `azureVoicesAvailable` |
| French voice sounds English | Fell back to `tts-1` | Check logs for the `gpt-4o-mini-tts` / Azure error |
| Change in `core.js` not live in prod | Worker not redeployed | `cd worker && npx wrangler deploy` |
