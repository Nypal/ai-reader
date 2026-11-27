# CLAUDE.md — Alphie / AI Reader

> This file is automatically loaded by Claude Code at startup. It provides persistent project memory.
> Keep it up-to-date as the project evolves.

---

## 🧭 Project Overview

**Alphie** is a two-process AI-powered reading and learning app.
- **Tagline:** "Read deeply. Learn fully."
- **Core loop:** Paste/upload text → Listen (TTS) → Take AI quiz → Feynman test
- **Target users:** Students, learners, professionals who want to retain what they read

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Vite + React 19 + TypeScript |
| Styling | Vanilla CSS with CSS custom properties (themes) |
| Backend | Cloudflare Worker in production (`worker/`), Node.js + Express for local dev (`backend/`); both share `backend/lib/core.js` |
| AI | OpenAI GPT-4o / GPT-4o-mini (quiz, evaluate, exam parsing) |
| TTS | Azure Neural voices (Vivienne, etc.) → OpenAI `gpt-4o-mini-tts` → `tts-1` fallback |
| PDF parsing | pdfjs-dist (client-side, no server upload) |
| Animations | Framer Motion |

---

## 🚀 Dev Commands

### Start Development (both must run simultaneously)
```bash
# Terminal 1 — Frontend
npm run dev                    # Vite HMR on http://localhost:5173

# Terminal 2 — Backend
cd backend && node server.js   # Express proxy on http://localhost:3001

# Optional — run the production Worker locally instead of Express
cd worker && npx wrangler dev --env-file ../backend/.env   # http://localhost:8787
```

### Other Frontend Commands
```bash
npm run build    # TypeScript check + Vite production build → dist/
npm run lint     # ESLint
npm run preview  # Serve dist/ locally
```

### Setup
```bash
cp backend/.env.example backend/.env
# Edit backend/.env and set OPENAI_API_KEY=sk-...
# Optional: AZURE_SPEECH_KEY + AZURE_SPEECH_REGION=francecentral for Azure voices
```

---

## 🏗️ Architecture

### Two-Process Structure
```
Dev:  Browser ──→ Frontend (Vite:5173) ──→ Backend (Express:3001) ──→ OpenAI / Azure
Prod: Browser ──→ Vercel ──→ Cloudflare Worker (alphie-api) ──→ OpenAI / Azure
```

The backend exists **solely** to keep the OpenAI and Azure keys server-side.
Never move API calls to the frontend. Never expose the keys.

**Business logic lives in `backend/lib/core.js`** (prompts, TTS engines, exam parsing).
It must stay runtime-agnostic — only `fetch`, `crypto.subtle`, `TextEncoder`; no Node-only
modules — because both `backend/server.js` and `worker/src/index.js` import it.
Change behaviour there, not in the two entry points.

| Concern | Express (`backend/server.js`) | Worker (`worker/src/index.js`) |
|---------|-------------------------------|--------------------------------|
| TTS audio cache | `backend/tts-cache/` on disk | Cloudflare Cache API |
| Rate limits | `express-rate-limit` | `[[ratelimits]]` in `worker/wrangler.toml` |
| CORS | localhost / `FRONTEND_URL` | `ALLOWED_ORIGINS` in `wrangler.toml` |
| Secrets | `backend/.env` | `wrangler secret put` |

### App State Machine (`src/App.tsx`)
```
'landing' → 'input'
'input'   → 'reading' → 'quiz' → 'input'   (learn mode)
'input'   → 'reading' → 'input'             (read mode)
'input'   → 'arena'   → 'input'
```
State flows via props only — no router, no global state manager.

### Backend API Endpoints (same on Express and Worker)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | `{ status, openaiKeyLoaded, azureVoicesAvailable }` |
| POST | `/api/tts` | Text-to-speech for one sentence (audio/mpeg, supports Range) |
| POST | `/api/quiz` (alias `/api/questions`) | 4 MCQ + 1 open question from text |
| POST | `/api/evaluate` | Coach feedback on the open-question answer |
| POST | `/api/parse-exam` | Parse exam-format text into quiz questions |
| POST | `/api/sentences` | Server-side sentence splitter (unused by the frontend) |

The full-reading MP3 download is assembled **in the browser** (`src/lib/audioDownload.ts`)
from `/api/tts` calls — there are no server-side download jobs.

### Voices
- Voice ids prefixed `azure:` use Azure; others are OpenAI voices (`src/lib/voices.ts`)
- Azure voices are only listed when `/api/health` reports `azureVoicesAvailable`, and only
  those native to the reading language (French → Vivienne, Rémy, Denise, Henri)
- French defaults to Vivienne when Azure is available; English defaults to Echo
- The allowed Azure voice list must match `AZURE_ALLOWED_VOICES` in `backend/lib/core.js`

---

## 📁 Source Structure

```
src/
├── App.tsx              # Root state machine + view router
├── App.css              # App-level layout styles
├── index.css            # Global CSS vars, themes, reset
├── main.tsx             # React entry point
├── components/
│   └── Header.tsx       # Top nav (shown only in reading/quiz states)
├── views/
│   ├── LandingView.tsx  # Marketing landing page
│   ├── InputView.tsx    # Text/PDF input + mode/voice/language selection
│   ├── ReaderView.tsx   # TTS audio player + sentence highlighting
│   ├── QuizView.tsx     # MCQ + Feynman test
│   └── ArenaView.tsx    # Gamification dashboard (UI demo)
├── hooks/
│   ├── useSentenceSplitter.ts  # Sentence tokenizer with TTS normalization
│   └── useAzureVoices.ts       # Whether the backend offers Azure voices
├── lib/
│   ├── api.ts           # apiFetch() wrapper — always uses VITE_API_URL
│   ├── voices.ts        # Voice catalogue (Azure + OpenAI) and default-voice rules
│   └── audioDownload.ts # Builds the full-reading MP3 from /api/tts calls
├── services/
│   └── AuditService.ts  # localStorage persistence for reading/quiz sessions
└── store/
    └── gameStore.ts     # Observer-pattern store for XP/badges/quests
```

---

## 🔑 Key Patterns & Gotchas

### TTS Engine (ReaderView) — Most Complex Part
```
runIdRef        → Increments on every stop/seek; cancels stale async chains
isStoppedRef    → Gates all audio callbacks
abortRef        → AbortController for in-flight fetch calls
cacheRef (Map)  → Pre-fetched audio as object URLs; evicts oldest when >MAX_CACHE(4)
```
- **Never** call `audioEl.play()` without checking `runIdRef` and `isStoppedRef` first
- Audio cleanup is `setTimeout(..., 0)` — prevents browser extension errors on unmount
- Lookahead: fetches up to 2 sentences ahead

### Sentence Splitter (`useSentenceSplitter`)
- Returns `{ original, spoken }` pairs
- `spoken`: replaces emails (`user@example.com` → `user at example dot com`), converts bullets to sentence boundaries
- Always use `spoken` for TTS, `original` for display

### Theming System
```css
/* Night theme = NO data-theme attribute */
/* Other themes = data-theme="light|sepia|forest" */
document.documentElement.setAttribute('data-theme', theme)
document.documentElement.removeAttribute('data-theme') // for night
```
All CSS vars defined in `src/index.css`. Never use hardcoded colors — always use CSS vars.

### API Calls
```typescript
import { apiFetch } from './lib/api';
// Always use apiFetch — never fetch() directly
// It prepends VITE_API_URL automatically
const res = await apiFetch('/api/quiz', { method: 'POST', ... });
```

### localStorage Keys
```
playlearn_voice    → selected TTS voice
playlearn_theme    → 'night' | 'light' | 'sepia' | 'forest'
playlearn_mode     → 'read' | 'learn'
ai_reader_audit_*  → AuditService session data
```

### PDF Handling
- Parsed client-side via `pdfjs-dist` — no file upload to server
- `pdfPageTexts: string[]` passed through App state
- `InputView` manages the PDF file object and extracted text

---

## 🎨 Design Principles

- **Cinematic motion**: Use Framer Motion with easing curves, not instant transitions
- **CSS-first**: Prefer CSS animations for simple effects, Framer Motion for page transitions
- **Theme-aware**: Every new element must work across all 4 themes
- **Mobile-first**: Test at 375px width — audio player must not overlap text
- **No UI libraries**: Pure CSS only — no Tailwind, no shadcn, no MUI

---

## ✅ Code Standards

- **TypeScript strict mode** — no `any`, no `@ts-ignore` without comment
- **Functional components** — no class components
- **Named exports** for components (except `default export` at file bottom)
- **Descriptive variable names** — `handleStartReading`, not `handle1`
- **Error boundaries** — wrap async operations in try/catch
- **No dead code** — remove commented-out code before committing

---

## 🚫 Do NOT

- ❌ Call OpenAI API from the frontend
- ❌ Commit `.env` files
- ❌ Use `any` type in TypeScript
- ❌ Add inline styles (use CSS classes)
- ❌ Break the `runIdRef` guard in ReaderView
- ❌ Add new npm packages without checking bundle size impact
- ❌ Use `localStorage` directly — use `AuditService` or the established keys

---

## 📦 Deployment

- **Frontend**: Vercel, auto-deploys from `master` — https://ai-reader-phi.vercel.app
  - `VITE_API_URL` = `https://alphie-api.nyobelipot.workers.dev` (Production + Preview)
  - Vite inlines it at build time: after changing it, redeploy the frontend
- **Backend**: Cloudflare Worker `alphie-api` — deploy with `cd worker && npx wrangler deploy`
  (not automatic: redeploy the Worker after changing `backend/lib/core.js` or `worker/`)
  - Secrets: `OPENAI_API_KEY`, `AZURE_SPEECH_KEY` (`npx wrangler secret put <NAME>`)
  - Vars in `worker/wrangler.toml`: `AZURE_SPEECH_REGION=francecentral`, `ALLOWED_ORIGINS`
  - A new frontend domain must be added to `ALLOWED_ORIGINS`, or the browser blocks calls
  - Full guide: `worker/README.md`
- **Azure Speech**: resource `alphie-speech-tts` (group `alphie-rg`, France Central), Free F0 tier
- **Railway**: no longer used (trial ended); the Worker replaced it

---

## 🧠 Decisions & Context

Decisions made with the owner that are not obvious from the code. Keep this list current.

- **Voice quality target = TTSReader.com.** Its quality comes from Azure Neural voices plus
  light text prep. Hence: Azure voices first, and OpenAI `gpt-4o-mini-tts` with narrator
  `instructions` (native French accent) instead of `tts-1`.
- **Vivienne is the French default.** The owner compared Vivienne, Denise and Henri by ear
  and preferred Vivienne. Don't change the default voice without asking.
- **Azure stays on the Free F0 tier** (0.5M neural characters/month). The owner wants no
  surprise costs: never upgrade the tier or add paid Azure services without asking.
  Region is France Central because West Europe refused new customers.
- **Cloudflare Workers replaced Railway** because Railway's trial ended and the owner already
  uses Cloudflare. Keep the backend free-tier friendly (≤50 subrequests per request, no
  long-running jobs, no in-memory state between requests).
- **MP3 download is built in the browser** for the same reason: Workers can't hold
  download jobs in memory.
- **Merging to `master`:** the "Protect master" ruleset requires 1 approving review. The
  owner is the only maintainer and merges with the admin bypass ("Bypass rules and merge").
  Claude opens the PR; the owner clicks merge.
- **Secrets are handled by the owner only.** Claude never reads, prints or types API keys;
  the owner pastes them (e.g. into `wrangler secret put`).

## 📝 To Do

- [ ] **Rotate the OpenAI API key** (part of it appeared in a screenshot). Create a new key at
      platform.openai.com/api-keys, put it in `backend/.env`, then
      `cd worker && npx wrangler secret put OPENAI_API_KEY`, and revoke the old key.
- [ ] Delete the Railway projects (`fulfilling-joy`, `giving-passion`) — no longer used.
- [ ] `backend/CLAUDE.md` is outdated (mentions `/api/feynman`, `westeurope`, old response
      shapes) and is not committed. Update it or delete it.
- [ ] There is no `/api/feynman` endpoint: the open question in the quiz uses `/api/evaluate`.
      The "Feynman test" wording above refers to that flow.
- [ ] Worker deploys are manual. Optional: a GitHub Action running `wrangler deploy` on
      pushes to `master` that touch `worker/` or `backend/lib/`.
- [ ] Delete merged remote branches (`feature/azure-tts-voices`,
      `feature/cloudflare-worker-backend`, `docs/update-claude-md`).
