# Alphie — Read deeply. Learn fully.

**Live at [ai-reader-phi.vercel.app](https://ai-reader-phi.vercel.app)**

An AI-powered reading app that reads your text aloud sentence by sentence, then tests your understanding with a quiz and Feynman test.

## Features

- **TTS Playback** — sentence-by-sentence audio via OpenAI, with lookahead caching, speed control (0.75×–2×), and 6 voice options
- **Read mode** — just listen, no quiz
- **Learn mode** — listen, then take an AI-generated multiple-choice quiz followed by a Feynman free-response test
- **PDF & TXT upload** — drag in a file or paste text directly
- **French support** — switch between English and French TTS
- **4 themes** — Night, Light, Sepia, Forest
- **Learning Arena** — XP system, levels, badges, daily quests, and leaderboard

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Nypal/ai-reader.git
cd ai-reader
npm install
cd backend && npm install
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and add your OpenAI API key:

```
OPENAI_API_KEY=your_openai_api_key_here
PORT=3001
```

### 3. Run

In two separate terminals:

```bash
# Terminal 1 — frontend
npm run dev

# Terminal 2 — backend
cd backend && node server.js
```

Then open `http://localhost:5173`.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Framer Motion
- **Backend**: Node.js, Express, OpenAI API (`tts-1`, `gpt-4o`)
- **PDF parsing**: pdfjs-dist (client-side)
