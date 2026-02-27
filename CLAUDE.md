# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Alphie** is a two-process AI-powered reading and learning app ("Read deeply. Learn fully."). Users paste or upload text, listen to it read aloud via OpenAI TTS, then optionally take an AI-generated quiz and Feynman test.

## Commands

### Frontend (root directory)
```bash
npm run dev       # Start Vite dev server (HMR)
npm run build     # Type-check + build to dist/
npm run lint      # ESLint
npm run preview   # Serve the dist/ build locally
```

### Backend (backend/ directory)
```bash
cd backend && node server.js   # Start Express proxy on port 3001
```

Both processes must run simultaneously during development. The frontend always expects the backend at `http://localhost:3001`.

### Setup
Copy `backend/.env` and set `OPENAI_API_KEY`. The backend will refuse TTS/quiz/feynman requests if the key is missing or still the placeholder value.

## Architecture

### Two-Process Structure
- **Frontend**: Vite + React 19 + TypeScript, runs on the default Vite port (5173)
- **Backend** (`backend/server.js`): Express proxy that holds the OpenAI API key and exposes 5 endpoints (`/api/health`, `/api/tts`, `/api/quiz`, `/api/evaluate`, `/api/feynman`)

The backend exists solely to keep the OpenAI key server-side. All AI work happens there (TTS via `openai.audio.speech`, quiz/evaluate/feynman via `gpt-4o` with `response_format: { type: "json_object" }`).

### App State Machine (`src/App.tsx`)
The entire app is a single-page state machine with four states held in `App.tsx`:
```
'input' → 'reading' → 'quiz' → 'input'  (learn mode)
'input' → 'reading' → 'input'           (read mode)
'input' → 'arena'   → 'input'
```
State is passed down as props; there is no router. `content`, `readingMode`, and `readingLanguage` are the only cross-view props.

### Views (`src/views/`)
- **InputView**: Text/PDF input, mode (read/learn), voice, language (EN/FR), theme selection. PDF parsing uses `pdfjs-dist` entirely client-side.
- **ReaderView**: The core TTS engine. Splits text into sentences via `useSentenceSplitter`, streams audio sentence-by-sentence with a lookahead cache of 2 sentences (max 4 cached). Uses `runIdRef` to guard stale async callbacks across seeks/stops. Auto-starts playback on mount.
- **QuizView**: Fetches AI-generated MCQ questions from `/api/quiz`, then offers a Feynman free-response test via `/api/feynman` and `/api/evaluate`.
- **ArenaView**: Gamification dashboard (XP, levels, badges, daily quests, leaderboard). Entirely UI demo — no persistence beyond the in-memory `gameStore`.

### Key Patterns
- **`useSentenceSplitter`** (`src/hooks/`): Splits text into `{ original, spoken }` arrays — `spoken` replaces email addresses with pronounceable forms (e.g. `user@example.com` → `user at example dot com`) and bullet points become sentence boundaries.
- **`gameStore`** (`src/store/gameStore.ts`): Custom observer pattern (no Redux/Zustand). Exposes `subscribe`, `getSnapshot`, `earnXP`, `completeQuest`, `unlockBadge`. ArenaView subscribes on mount.
- **`AuditService`** (`src/services/AuditService.ts`): Persists reading sessions, quiz concept performance, and Feynman scores to `localStorage` under `ai_reader_audit_*` keys.
- **User preferences** (`localStorage`): `playlearn_voice`, `playlearn_theme`, `playlearn_mode` — read on mount in InputView and ReaderView.
- **Themes**: Applied by toggling `data-theme` attribute on `document.documentElement` (`night` = no attribute, others = `data-theme="light|sepia|forest"`). CSS vars defined in `src/index.css`.

### ReaderView TTS Engine Details
The TTS playback pipeline is the most complex part of the codebase:
- `runIdRef` increments on every stop/seek to cancel in-flight async chains
- `isStoppedRef` gates all audio callbacks
- `abortRef` (`AbortController`) cancels in-flight `fetch` calls
- `cacheRef` (Map) stores pre-fetched audio as object URLs; evicts oldest when over `MAX_CACHE=4`
- Audio element cleanup is deferred via `setTimeout(..., 0)` to avoid browser extension promise errors on unmount
