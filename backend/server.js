// Local / Node backend. Production runs the same logic on Cloudflare Workers
// (worker/src/index.js); both share backend/lib/core.js.
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    HttpError,
    evaluateAnswer,
    generateQuiz,
    getTtsAudio,
    hasOpenAiKey,
    parseExam,
    readLimits,
    readPositiveInt,
    readTtsConfig,
    splitSentences,
    validateTtsRequest,
} from './lib/core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const config = readTtsConfig(process.env);
const limits = readLimits(process.env);

// ── Disk cache for TTS audio ─────────────────────────────────────────────────
// Override with TTS_CACHE_DIR to point at a persistent volume.
const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(__dirname, 'tts-cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// LRU eviction — keep at most MAX_CACHE_FILES MP3s. mtime is the LRU timestamp;
// cache hits touch the file to keep it fresh.
const MAX_CACHE_FILES = readPositiveInt(process.env, 'TTS_CACHE_MAX_FILES', 500);

function evictCacheIfNeeded() {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.mp3'));
    if (files.length <= MAX_CACHE_FILES) return;

    const entries = files.map(f => {
        const p = path.join(CACHE_DIR, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
    });
    entries.sort((a, b) => a.mtime - b.mtime); // oldest first

    const toDelete = entries.slice(0, files.length - MAX_CACHE_FILES);
    for (const { p } of toDelete) {
        try { fs.unlinkSync(p); } catch { /* ignore race */ }
    }
    console.log(`[TTS Cache] Evicted ${toDelete.length} file(s), ${files.length - toDelete.length} remaining.`);
}

const diskCache = {
    async get(key) {
        const cachePath = path.join(CACHE_DIR, `${key}.mp3`);
        if (!fs.existsSync(cachePath)) return null;
        const stat = fs.statSync(cachePath);
        if (stat.size < 1000) {
            console.log(`[TTS] Deleting corrupted cache file (size ${stat.size}): ${cachePath}`);
            try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
            return null;
        }
        const now = new Date();
        try { fs.utimesSync(cachePath, now, now); } catch { /* ignore */ }
        return new Uint8Array(fs.readFileSync(cachePath));
    },
    async put(key, bytes) {
        fs.writeFileSync(path.join(CACHE_DIR, `${key}.mp3`), bytes);
        evictCacheIfNeeded();
    },
};

// ── Concurrency guard for TTS synthesis ──────────────────────────────────────
const MAX_CONCURRENT_TTS = 5;
let currentTtsJobs = 0;

async function withTtsSlot(task) {
    while (currentTtsJobs >= MAX_CONCURRENT_TTS) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    currentTtsJobs++;
    try {
        return await task();
    } finally {
        currentTtsJobs--;
    }
}

// ── Middleware ───────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false });
const ttsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 200,
    message: { error: 'Too many TTS requests, please try again later.' },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    message: { error: 'Too many AI requests, please try again later.' },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? (process.env.FRONTEND_URL || false) : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(globalLimiter);

// API key auth — enforced only when API_SECRET env var is set (skipped in local dev)
app.use((req, res, next) => {
    const secret = process.env.API_SECRET;
    if (!secret || req.path === '/api/health') return next();
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (token !== secret) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

/** Wraps a JSON AI handler: key check, HttpError → status, other errors → 500. */
function aiRoute(label, publicError, handler) {
    return async (req, res) => {
        try {
            if (!hasOpenAiKey(config)) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });
            res.json(await handler(req.body));
        } catch (error) {
            if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
            console.error(`${label} Error:`, error);
            res.status(500).json({ error: publicError });
        }
    };
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', openaiKeyLoaded: hasOpenAiKey(config), azureVoicesAvailable: Boolean(config.azure) });
});

app.post('/api/sentences', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    res.json({ sentences: splitSentences(text) });
});

app.post('/api/tts', ttsLimiter, async (req, res) => {
    try {
        const request = validateTtsRequest(req.body, limits);
        if (!hasOpenAiKey(config)) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        const audio = await withTtsSlot(() => getTtsAudio(config, diskCache, request));
        if (!audio) return res.status(204).send(); // nothing left to read after normalisation

        const buffer = Buffer.from(audio);
        const fileSize = buffer.length;
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': 'audio/mpeg',
            });
            res.end(buffer.subarray(start, end + 1));
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(buffer);
        }
    } catch (error) {
        if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
        console.error('TTS Error:', error);
        res.status(500).json({ error: 'Failed to generate audio' });
    }
});

const quizRoute = aiRoute('Quiz Generation', 'Failed to generate quiz', body => generateQuiz(config, body));
app.post('/api/quiz', aiLimiter, quizRoute);
app.post('/api/questions', aiLimiter, quizRoute);
app.post('/api/parse-exam', aiLimiter, aiRoute('ParseExam', 'Failed to parse exam questions.', body => parseExam(config, limits, body)));
app.post('/api/evaluate', aiLimiter, aiRoute('Evaluate', 'Failed to evaluate answer', body => evaluateAnswer(config, body)));

app.listen(port, '0.0.0.0', () => {
    console.log(`Backend API running on http://0.0.0.0:${port}`);
});
