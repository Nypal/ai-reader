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

function readPositiveIntEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

// LRU disk cache eviction — keep at most MAX_CACHE_FILES MP3s.
// mtime is used as the LRU timestamp; cache hits touch the file to keep it fresh.
const MAX_CACHE_FILES = readPositiveIntEnv('TTS_CACHE_MAX_FILES', 500);
const MAX_TTS_TEXT_CHARS = readPositiveIntEnv('TTS_MAX_TEXT_CHARS', 5000);
const MAX_DOWNLOAD_SENTENCES = readPositiveIntEnv('TTS_DOWNLOAD_MAX_SENTENCES', 120);
const MAX_DOWNLOAD_TOTAL_CHARS = readPositiveIntEnv('TTS_DOWNLOAD_MAX_TOTAL_CHARS', 30000);
const MAX_DOWNLOAD_JOBS = readPositiveIntEnv('TTS_DOWNLOAD_MAX_JOBS', 3);
const MAX_EXAM_TEXT_CHARS = readPositiveIntEnv('EXAM_PARSE_MAX_TEXT_CHARS', 75000);
const MAX_EXAM_CHUNKS = readPositiveIntEnv('EXAM_PARSE_MAX_CHUNKS', 8);
const MAX_EXAM_CONCURRENT_CHUNKS = readPositiveIntEnv('EXAM_PARSE_CONCURRENCY', 2);

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
    limit: 200,
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
    origin: process.env.NODE_ENV === 'production' ? (process.env.FRONTEND_URL || false) : ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
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

// ── Shared TTS helper ─────────────────────────────────────────────────────────
// Resolves (or synthesises) the MP3 for a single sentence and returns the path
// to the local cache file.  Used by both /api/tts and /api/download-audio.
async function getOrCreateTtsFile(text, voice, lang) {
    let finalVoice = voice;
    if (lang === 'fr' && voice !== 'onyx' && voice !== 'echo') {
        finalVoice = 'onyx';
    }

    const normalizedText = normalizeText(text, lang);

    // Guard: normalizeText may strip all content (e.g. punctuation-only input)
    if (!normalizedText || normalizedText.trim().length === 0) {
        console.log('[TTS] Normalised text is empty — returning null');
        return null;
    }

    const hash = crypto.createHash('sha256').update(`${normalizedText}-${finalVoice}-${lang}`).digest('hex');
    const cachePath = path.join(CACHE_DIR, `${hash}.mp3`);

    // Remove corrupted files
    if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        if (stat.size < 1000) {
            console.log(`[TTS] Deleting corrupted cache file (size ${stat.size}): ${cachePath}`);
            try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
        }
    }

    if (!fs.existsSync(cachePath)) {
        console.log(`[TTS] Cache MISS. Generating ${lang} audio (${normalizedText.length} chars) voice=${finalVoice}...`);
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
        console.log(`[TTS] Cache HIT (${normalizedText.length} chars)`);
        const now = new Date();
        try { fs.utimesSync(cachePath, now, now); } catch { /* ignore */ }
    }

    return cachePath;
}

app.post('/api/tts', ttsLimiter, async (req, res) => {
    try {
        const { text, voice = 'alloy', lang = 'en' } = req.body;

        if (!text) return res.status(400).json({ error: 'Text is required' });
        if (text.length > MAX_TTS_TEXT_CHARS) return res.status(400).json({ error: `Text exceeds ${MAX_TTS_TEXT_CHARS} characters. Please chunk it.` });

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });
        }

        const audioPath = await getOrCreateTtsFile(text, voice, lang);
        if (!audioPath) {
            return res.status(204).send(); // No content for empty strings
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

const downloadJobs = new Map();

// ── Download full reading as MP3 ──────────────────────────────────────────────
// POST /api/download-audio
// Body: { sentences: string[], voice: string, lang: 'en' | 'fr' }
// Returns: { jobId: string }
app.post('/api/download-audio', ttsLimiter, (req, res) => {
    const { sentences, voice = 'echo', lang = 'en' } = req.body;

    if (!Array.isArray(sentences) || sentences.length === 0) {
        return res.status(400).json({ error: 'sentences[] array is required.' });
    }
    const normalizedSentences = sentences
        .map(sentence => String(sentence || '').trim())
        .filter(Boolean);
    if (normalizedSentences.length === 0) {
        return res.status(400).json({ error: 'At least one non-empty sentence is required.' });
    }
    if (normalizedSentences.length > MAX_DOWNLOAD_SENTENCES) {
        return res.status(400).json({ error: `Download is limited to ${MAX_DOWNLOAD_SENTENCES} sentences per request.` });
    }
    if (normalizedSentences.some(sentence => sentence.length > MAX_TTS_TEXT_CHARS)) {
        return res.status(400).json({ error: `Each sentence must be ${MAX_TTS_TEXT_CHARS} characters or fewer.` });
    }
    const totalChars = normalizedSentences.reduce((sum, sentence) => sum + sentence.length, 0);
    if (totalChars > MAX_DOWNLOAD_TOTAL_CHARS) {
        return res.status(400).json({ error: `Download text exceeds ${MAX_DOWNLOAD_TOTAL_CHARS} total characters.` });
    }
    const activeDownloadJobs = Array.from(downloadJobs.values()).filter(job => job.status === 'processing').length;
    if (activeDownloadJobs >= MAX_DOWNLOAD_JOBS) {
        return res.status(429).json({ error: 'Too many audio downloads are already processing. Please try again shortly.' });
    }
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });
    }

    const jobId = crypto.randomUUID();
    downloadJobs.set(jobId, { status: 'processing', progress: 0, total: normalizedSentences.length, buffer: null, error: null });
    setTimeout(() => downloadJobs.delete(jobId), 3600000);

    // Start background job
    (async () => {
        try {
            console.log(`[Download Job ${jobId}] Compiling ${normalizedSentences.length} sentences into MP3 (voice=${voice}, lang=${lang})...`);
            const buffers = [];
            for (let i = 0; i < normalizedSentences.length; i++) {
                const text = normalizedSentences[i];
                const filePath = await getOrCreateTtsFile(text, voice, lang);
                if (filePath) {
                    buffers.push(fs.readFileSync(filePath));
                }
                const job = downloadJobs.get(jobId);
                if (job) job.progress = i + 1;
            }

            const job = downloadJobs.get(jobId);
            if (!job) return;

            if (buffers.length === 0) {
                job.status = 'error';
                job.error = 'No valid sentences to compile.';
                return;
            }

            job.buffer = Buffer.concat(buffers);
            job.status = 'completed';
            console.log(`[Download Job ${jobId}] Done — merged ${job.buffer.length} bytes.`);
        } catch (error) {
            console.error(`[Download Job ${jobId}] Error:`, error);
            const job = downloadJobs.get(jobId);
            if (job) {
                job.status = 'error';
                job.error = 'Failed to compile audio download.';
            }
        }
    })();

    res.json({ jobId });
});

// GET /api/download-audio/:jobId/status
app.get('/api/download-audio/:jobId/status', (req, res) => {
    const job = downloadJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ status: job.status, progress: job.progress, total: job.total, error: job.error });
});

// GET /api/download-audio/:jobId/file
app.get('/api/download-audio/:jobId/file', (req, res) => {
    const job = downloadJobs.get(req.params.jobId);
    if (!job || job.status !== 'completed' || !job.buffer) {
        return res.status(404).json({ error: 'File not ready or job not found' });
    }
    res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': job.buffer.length,
        'Content-Disposition': 'attachment; filename="alphie-reading.mp3"',
        'Cache-Control': 'no-store',
    });
    res.send(job.buffer);
    // Delete job after downloading to save memory
    downloadJobs.delete(req.params.jobId);
});

const generateQuiz = async (req, res) => {
    try {
        const { text, lang = 'en' } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        console.log(`[Quiz] Generating questions for text (${text.length} chars) in lang: ${lang}...`);

        const systemPrompt = `Generate exactly 4 multiple choice questions AND 1 open question based SOLELY on the user text. Output valid JSON only.

CRITICAL RULES for MCQ:
- The "correct" field is a 0-based index into the "options" array.
- Spread the correct index across 0 (A), 1 (B), 2 (C), and 3 (D) — do NOT place the correct answer at the same index for every question.
- All 4 options must be plausible.

Schema: {"questions":[{"type":"main|detail|apply","question":"...","options":["option_A","option_B","option_C","option_D"],"correct":2,"explanation":"...","reference":"..."}],"openQuestion":"A single open-ended question that requires a short written answer to test understanding of a key idea in the text."}`;

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

// Split large exam text into chunks at question boundaries to stay within max_tokens.
function splitExamText(text) {
    const MAX_CHUNK = 12000; // characters per chunk
    if (text.length <= MAX_CHUNK) return [text];

    const chunks = [];
    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + MAX_CHUNK, text.length);

        if (end < text.length) {
            // Look back up to 2500 chars for a question number boundary
            const lookbackStart = Math.max(start, end - 2500);
            const segment = text.slice(lookbackStart, end);
            // Match patterns: "A6. ", "A7. ", "12. A", "Q12. " etc.
            const matches = [...segment.matchAll(/[A-Z]\d+\.\s|(?<!\d)\d{1,3}\.\s+[A-Z]/g)];
            if (matches.length > 0) {
                end = lookbackStart + matches[matches.length - 1].index;
            }
        }

        const chunk = text.slice(start, end).trim();
        if (chunk.length > 50) chunks.push(chunk);
        start = end;
    }

    return chunks;
}

const EXAM_CHUNK_SYSTEM_PROMPT = `You are an exam parser. Extract EVERY multiple-choice question from the provided text — do not skip any.

Rules:
- Include only questions that have explicit answer choices (A/B/C/D or labeled options).
- Strip letter prefixes (A., B., C., etc.) from option text — keep only the content.
- correctAnswerIndex is 0-based (0=A, 1=B, 2=C, 3=D, 4=E, 5=F).
- If an answer key is present in the text (e.g. "A6: B" or "1. B  2. C  3. A..."), use it.
- If NO answer key appears, use your training knowledge (especially for CompTIA, Cisco, Microsoft exams).
- explanation: one short sentence (max 12 words) saying why the answer is correct.
- type: always "exam".

MULTI-SELECT questions (those with "Pick TWO", "Select TWO", "Choose TWO", "(Select TWO)", etc.):
- Set requiredSelections to the stated count (usually 2).
- Set correctAnswerIndices to an array of ALL correct 0-based option indices, e.g. [0, 2].
- Set correctAnswerIndex to the first correct index (backward compat).
- Set examExplanation fields to empty strings "".

SINGLE-SELECT questions (all others):
- Set requiredSelections: 1.
- Set correctAnswerIndices: [correctAnswerIndex].
- examExplanation — identify the most tempting wrong answer:
  - bestNow: max 12 words — why the symptom points to the correct answer; avoid "resolves the issue"
  - notLabel: 1-3 words for the most tempting wrong option (no letter prefix)
  - notReason: max 12 words — why that wrong answer fits less given the symptom

Return ONLY valid JSON:
{"questions":[{"type":"exam","question":"...","options":["...","...","...","..."],"correctAnswerIndex":2,"correctAnswerIndices":[2],"requiredSelections":1,"explanation":"...","examExplanation":{"bestNow":"...","notLabel":"...","notReason":"..."}}]}`;

async function parseExamChunk(chunkText, openai) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 8000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: EXAM_CHUNK_SYSTEM_PROMPT },
            { role: 'user', content: chunkText },
        ],
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
}

app.post('/api/parse-exam', aiLimiter, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
        if (text.length > MAX_EXAM_TEXT_CHARS) {
            return res.status(400).json({ error: `Exam text exceeds ${MAX_EXAM_TEXT_CHARS} characters.` });
        }
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        const chunks = splitExamText(text);
        if (chunks.length > MAX_EXAM_CHUNKS) {
            return res.status(400).json({ error: `Exam parse is limited to ${MAX_EXAM_CHUNKS} chunks per request.` });
        }
        console.log(`[ParseExam] Parsing ${text.length} chars across ${chunks.length} chunk(s)...`);

        const chunkResults = [];
        for (let i = 0; i < chunks.length; i += MAX_EXAM_CONCURRENT_CHUNKS) {
            const batch = chunks.slice(i, i + MAX_EXAM_CONCURRENT_CHUNKS);
            const batchResults = await Promise.all(batch.map(chunk => parseExamChunk(chunk, openai)));
            chunkResults.push(...batchResults);
        }
        const allQuestions = chunkResults.flat();

        if (allQuestions.length === 0) {
            return res.status(422).json({ error: 'No multiple-choice questions found. Make sure to include answer choices (A, B, C, D) with your questions.' });
        }

        console.log(`[ParseExam] Extracted ${allQuestions.length} questions from ${chunks.length} chunk(s).`);
        res.json({ questions: allQuestions });
    } catch (error) {
        console.error('ParseExam Error:', error);
        res.status(500).json({ error: 'Failed to parse exam questions.' });
    }
});

app.post('/api/evaluate', aiLimiter, async (req, res) => {
    try {
        const { question, answer, originalText } = req.body;
        if (!question || !answer || !originalText) return res.status(400).json({ error: 'question, answer, and originalText are required' });
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        console.log(`[Evaluate] Checking answer...`);

        const systemPrompt = `You are a supportive learning coach evaluating a student's written answer to an open question about a text they read.

Evaluate semantically — based on meaning, not exact wording. Accept imperfect or broken English if the core idea is present.
Always return useful, encouraging feedback even for weak or incomplete answers.
Keep all feedback short, simple, and easy to understand for non-native English speakers.

Return valid JSON with EXACTLY this structure:
{
  "understandingScore": 7,
  "expressionScore": 6,
  "didWell": "One short sentence about what the student got right.",
  "missing": "One short sentence about what is missing, unclear, or could be improved in terms of content.",
  "improved": "A rewritten version of the student's answer in clear, natural, correct English — same meaning, better form."
}

Scoring rules:
- understandingScore (0-10): how well the student grasped the core idea, based on the original text
- expressionScore (0-10): grammar, clarity, sentence structure, and overall written English quality`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 400,
            temperature: 0.4,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Original Text:\n${originalText}\n\nQuestion: ${question}\n\nStudent's Answer: ${answer}` }
            ]
        });

        let content = completion.choices[0].message.content;
        const jsonMatch = content.match(/```json\n([\s\S]*)\n```/) || content.match(/{[\s\S]*}/);
        if (jsonMatch && jsonMatch[1]) content = jsonMatch[1];
        else if (jsonMatch && jsonMatch[0]) content = jsonMatch[0];

        res.json(JSON.parse(content));
    } catch (error) {
        console.error('Evaluate Error:', error);
        res.status(500).json({ error: 'Failed to evaluate answer' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Backend API running on http://0.0.0.0:${port}`);
});
