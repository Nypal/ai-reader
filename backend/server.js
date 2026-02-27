import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { rateLimit } from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Setup cache directory — override with TTS_CACHE_DIR env var in production
// to point at a persistent volume (e.g. /data/tts-cache on Railway/Render).
const CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(__dirname, 'tts-cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!process.env.TTS_CACHE_DIR && process.env.NODE_ENV === 'production') {
    console.warn('[TTS Cache] WARNING: TTS_CACHE_DIR is not set. Cache will be lost on redeploy. Set TTS_CACHE_DIR to a persistent volume path.');
}

// LRU disk cache eviction — keep at most MAX_CACHE_FILES MP3s.
// mtime is used as the LRU timestamp; cache hits touch the file to keep it fresh.
const MAX_CACHE_FILES = parseInt(process.env.TTS_CACHE_MAX_FILES || '500', 10);

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

// Global Rate Limiter
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

// Strict Rate Limiter for TTS
const ttsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    message: { error: 'Too many TTS requests, please try again later.' },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

// Rate Limiter for AI endpoints (quiz / feynman)
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    message: { error: 'Too many AI requests, please try again later.' },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));
app.use(globalLimiter);

// Initialize Clients
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy_key',
});

// TTS Semaphores
const MAX_CONCURRENT_TTS = 5;
let currentTtsJobs = 0;

function waitForTtsSlot() {
    return new Promise(resolve => {
        const check = () => {
            if (currentTtsJobs < MAX_CONCURRENT_TTS) {
                currentTtsJobs++;
                resolve(null);
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

function normalizeText(text, lang) {
    let clean = text;

    // Remove URLs, Markdown, and Emails
    clean = clean.replace(/https?:\/\/[^\s]+/g, '');
    clean = clean.replace(/www\.[^\s]+/g, '');
    clean = clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '');
    clean = clean.replace(/[*_#>]/g, '');

    if (lang === 'fr') {
        clean = clean.replace(/\b1er\b/g, "premier");
        clean = clean.replace(/\b([2-9]|\d{2,})e\b/g, "$1ième"); // very basic expansion
        clean = clean.replace(/\bM\.\b/g, "Monsieur");
        clean = clean.replace(/\bMme\b/g, "Madame");
        clean = clean.replace(/\betc\.\b/g, "et cetera");
    } else {
        // English
        clean = clean.replace(/\bU\.S\.\b/g, "United States");
        clean = clean.replace(/\bU\.K\.\b/g, "United Kingdom");
        clean = clean.replace(/\bDr\.\b/g, "Doctor");
        clean = clean.replace(/\bMr\.\b/g, "Mister");
        clean = clean.replace(/\bMrs\.\b/g, "Missus");
        clean = clean.replace(/\bMs\.\b/g, "Miss");
        clean = clean.replace(/\bvs\.\b/g, "versus");
        clean = clean.replace(/\betc\.\b/g, "et cetera");
        clean = clean.replace(/\be\.g\.\b/g, "for example");
        clean = clean.replace(/\bi\.e\.\b/g, "that is");
        clean = clean.replace(/\bCorp\.\b/g, "Corporation");
        clean = clean.replace(/\bInc\.\b/g, "Incorporated");

        // Ordinals & Numbers
        clean = clean.replace(/\b1st\b/g, "first");
        clean = clean.replace(/\b2nd\b/g, "second");
        clean = clean.replace(/\b3rd\b/g, "third");
        clean = clean.replace(/\$(\d+)[kK]\b/g, "$1 thousand dollars");
        clean = clean.replace(/\$(\d+)\b/g, "$1 dollars");
    }

    // SSML Pauses (Simulated using commas/periods since OpenAI TTS respects them)
    // Replace period+capital with period+space to ensure a hard pause
    clean = clean.replace(/\.([A-Z])/g, '. $1');

    return clean;
}

app.get('/api/health', (req, res) => {
    const hasOpenAI = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key';
    res.json({ status: 'ok', openaiKeyLoaded: hasOpenAI });
});

// The Sentence Splitter Endpoint
app.post('/api/sentences', (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: 'Text required' });

        const abbrevMap = [];
        const protect = (m) => {
            const k = `\uE000${abbrevMap.length}\uE001`;
            abbrevMap.push(m);
            return k;
        };

        // Protect known abbreviations
        let processedText = text
            .replace(/\b(?:[A-Z]\.){2,}/g, protect)
            .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr)\./g, protect)
            .replace(/\b(?:vs|etc|approx|est|avg|dept|govt|ref|fig|vol|pp)\./g, protect)
            .replace(/\be\.g\./g, protect)
            .replace(/\bi\.e\./g, protect)
            .replace(/\bet al\./g, protect)
            .replace(/\b\d+(?:st|nd|rd|th)\./g, protect);

        // Split on standard boundaries followed by space+capital
        // Also capture just plain boundaries at the end
        const sentencesProtected = processedText.match(/[^.!?]+[.!?]+(?=\s*[A-Z]|$)/g) || processedText.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [];

        const restoreAbbrevs = (s) => s.replace(/\uE000(\d+)\uE001/g, (_, i) => abbrevMap[parseInt(i)]);

        const finalSentences = sentencesProtected
            .map(s => restoreAbbrevs(s).trim())
            // Filter fragments under 3 words
            .filter(s => s.split(/\s+/).length >= 3);

        res.json({ sentences: finalSentences.length > 0 ? finalSentences : [text.trim()] });
    } catch (e) {
        res.status(500).json({ error: 'Failed to split sentences' });
    }
});

app.post('/api/tts', ttsLimiter, async (req, res) => {
    try {
        const { text, voice = 'alloy', lang = 'en' } = req.body;

        if (!text) return res.status(400).json({ error: 'Text is required' });
        if (text.length > 5000) return res.status(400).json({ error: 'Text exceeds 5000 characters. Please chunk it.' });

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });
        }

        let finalVoice = voice;
        if (lang === 'fr' && voice !== 'onyx' && voice !== 'echo') {
            finalVoice = 'onyx';
        }

        const normalizedText = normalizeText(text, lang);

        // Hash for cache key
        const hash = crypto.createHash('sha256').update(`${normalizedText}-${finalVoice}-${lang}`).digest('hex');
        const cachePath = path.join(CACHE_DIR, `${hash}.mp3`);

        let audioPath = cachePath;

        if (!fs.existsSync(cachePath)) {
            console.log(`[TTS] Cache MISS. Generating ${lang} audio for chunk (${normalizedText.length} chars) using voice ${finalVoice}...`);
            await waitForTtsSlot();
            try {
                const mp3 = await openai.audio.speech.create({
                    model: 'tts-1',
                    voice: finalVoice,
                    input: normalizedText,
                    response_format: 'mp3',
                });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                fs.writeFileSync(cachePath, buffer);
                evictCacheIfNeeded();
            } finally {
                currentTtsJobs--;
            }
        } else {
            console.log(`[TTS] Cache HIT for chunk (${normalizedText.length} chars)`);
            // Touch mtime so this file survives future LRU eviction
            const now = new Date();
            try { fs.utimesSync(cachePath, now, now); } catch { /* ignore */ }
        }

        // --- HTTP range request stream ---
        const stat = fs.statSync(audioPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(audioPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400',
            };
            res.writeHead(200, head);
            fs.createReadStream(audioPath).pipe(res);
        }

    } catch (error) {
        console.error('TTS Error:', error);
        res.status(500).json({ error: 'Failed to generate audio' });
    }
});

const generateQuiz = async (req, res) => {
    try {
        const { text, lang = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        console.log(`[Quiz] Generating questions for text (${text.length} chars) in lang: ${lang}...`);

        const systemPrompt = `Generate exactly 4 multiple choice questions based SOLELY on the user text. Output valid JSON only.
Schema: {"questions":[{"type":"main|detail|apply","question":"...","options":["...","...","...","..."],"correct":0,"explanation":"...","reference":"..."}]}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 1200,
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Language: ${lang}\n\nText:\n${text}` }
            ]
        });

        let content = completion.choices[0].message.content;
        const jsonMatch = content.match(/```json\n([\s\S]*)\n```/) || content.match(/{[\s\S]*}/);
        if (jsonMatch && jsonMatch[1]) content = jsonMatch[1];
        else if (jsonMatch && jsonMatch[0]) content = jsonMatch[0];

        res.json(JSON.parse(content));
    } catch (error) {
        console.error('Quiz Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate quiz' });
    }
};

app.post('/api/quiz', aiLimiter, generateQuiz);
app.post('/api/questions', aiLimiter, generateQuiz);

app.post('/api/feynman', aiLimiter, async (req, res) => {
    try {
        const { explanation, originalText } = req.body;
        if (!originalText || !explanation) return res.status(400).json({ error: 'originalText and explanation are required' });
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        console.log(`[Feynman] Evaluating explanation...`);

        const systemPrompt = `You are an expert educator acting as a supportive coach for a student taking a Feynman Test.
Evaluate how accurately and completely the student explained the main ideas of the original text. Maintain an encouraging tone.
You MUST return the output ONLY as valid JSON matching this exact structure, with these EXACT keys:
{
  "strong_points": "List specific things the student explained correctly.",
  "missing_concepts": "List specific concepts they missed that they should add next time.",
  "rewrite_suggestion": "Provide one concrete example sentence the student could use to improve their explanation.",
  "score": 85
}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 1000,
            temperature: 0.7,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Original Text: ${originalText}\n\nStudent's Explanation: ${explanation}\n\nPlease evaluate.` }
            ]
        });

        let content = completion.choices[0].message.content;
        const jsonMatch = content.match(/```json\n([\s\S]*)\n```/) || content.match(/{[\s\S]*}/);
        if (jsonMatch && jsonMatch[1]) content = jsonMatch[1];
        else if (jsonMatch && jsonMatch[0]) content = jsonMatch[0];

        res.json(JSON.parse(content));
    } catch (error) {
        console.error('Feynman Evaluation Error:', error);
        res.status(500).json({ error: 'Failed to evaluate explanation' });
    }
});

app.listen(port, () => {
    console.log(`Backend API running on http://localhost:${port}`);
});
