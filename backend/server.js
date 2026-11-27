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

// ── TTS model & narration style ──────────────────────────────────────────────
// gpt-4o-mini-tts sounds far more natural than tts-1 and accepts style
// instructions. Override with TTS_MODEL=tts-1 (or tts-1-hd) if needed.
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_FALLBACK_MODEL = 'tts-1';

const TTS_INSTRUCTIONS = {
    en: 'You are a professional audiobook narrator. Read in clear, natural American English '
        + 'with warm, engaged intonation and a calm, steady pace. Respect punctuation: brief '
        + 'pauses at commas, full pauses at periods. Pronounce acronyms and numbers correctly. '
        + 'Never add, skip or comment on words.',
    fr: 'Tu es un narrateur professionnel de livres audio. Lis en français de France standard, '
        + 'avec un accent français natif et une prononciation parfaitement française '
        + '(aucun accent anglais), une intonation chaleureuse et naturelle et un rythme posé. '
        + 'Respecte la ponctuation : courtes pauses aux virgules, vraies pauses aux points. '
        + 'Fais les liaisons correctement. N\'ajoute, ne saute et ne commente aucun mot.',
};

// ── Azure Neural voices (same engine TTSReader uses) ─────────────────────────
// Enabled when AZURE_SPEECH_KEY + AZURE_SPEECH_REGION are set. The frontend
// sends voice ids prefixed with "azure:" (e.g. "azure:fr-FR-DeniseNeural").
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
const AZURE_ENABLED = Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION);
const AZURE_VOICE_PREFIX = 'azure:';
const AZURE_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
const AZURE_LOCALES = { en: 'en-US', fr: 'fr-FR' };
// Default voice per reading language when the chosen voice can't read it natively.
const AZURE_DEFAULT_VOICES = {
    en: 'en-US-AvaMultilingualNeural',
    fr: 'fr-FR-VivienneMultilingualNeural',
};
// Only these voices are accepted from the client.
const AZURE_ALLOWED_VOICES = new Set([
    'fr-FR-VivienneMultilingualNeural',
    'fr-FR-RemyMultilingualNeural',
    'fr-FR-DeniseNeural',
    'fr-FR-HenriNeural',
    'en-US-AvaMultilingualNeural',
    'en-US-AndrewMultilingualNeural',
]);
const OPENAI_FALLBACK_VOICE = 'nova';

function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** Picks the Azure voice that will read `lang` natively. */
function resolveAzureVoice(requestedVoice, lang) {
    const locale = AZURE_LOCALES[lang] ?? AZURE_LOCALES.en;
    if (!AZURE_ALLOWED_VOICES.has(requestedVoice)) return AZURE_DEFAULT_VOICES[lang] ?? AZURE_DEFAULT_VOICES.en;
    // Multilingual voices can read any language; others only their own locale.
    if (requestedVoice.startsWith(locale) || requestedVoice.includes('Multilingual')) return requestedVoice;
    return AZURE_DEFAULT_VOICES[lang] ?? AZURE_DEFAULT_VOICES.en;
}

/** Calls the Azure Speech REST API and returns an MP3 buffer. */
async function synthesizeWithAzure(text, voiceName, lang) {
    const locale = AZURE_LOCALES[lang] ?? AZURE_LOCALES.en;
    // <lang> forces native pronunciation when a multilingual voice reads another language.
    const body = voiceName.includes('Multilingual')
        ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceName}"><lang xml:lang="${locale}">${escapeXml(text)}</lang></voice></speak>`
        : `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceName}">${escapeXml(text)}</voice></speak>`;

    const res = await fetch(`https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
            'User-Agent': 'alphie-backend',
        },
        body,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Azure TTS ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

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
    res.json({ status: 'ok', openaiKeyLoaded: hasOpenAI, azureVoicesAvailable: AZURE_ENABLED });
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
/** Builds a synthesis plan for an OpenAI voice + model (cache key + synth fn). */
function openaiPlan(normalizedText, voice, lang, model) {
    const supportsInstructions = model === 'gpt-4o-mini-tts';
    let finalVoice = voice;
    // tts-1 voices have a strong English accent in French; only onyx/echo were
    // acceptable. gpt-4o-mini-tts follows the French instructions with any voice.
    if (!supportsInstructions && lang === 'fr' && voice !== 'onyx' && voice !== 'echo') {
        finalVoice = 'onyx';
    }
    const instructions = supportsInstructions ? (TTS_INSTRUCTIONS[lang] ?? TTS_INSTRUCTIONS.en) : '';
    return {
        label: `openai model=${model} voice=${finalVoice}`,
        // Model + instructions are part of the key so changing either never serves stale audio.
        cacheKey: `${normalizedText}-${finalVoice}-${lang}-${model}-${instructions}`,
        synthesize: async () => {
            const mp3 = await openai.audio.speech.create({
                model,
                voice: finalVoice,
                input: normalizedText,
                response_format: 'mp3',
                ...(instructions ? { instructions } : {}),
            });
            return Buffer.from(await mp3.arrayBuffer());
        },
    };
}

/** Ordered list of engines to try: the requested one first, then fallbacks. */
function buildTtsPlans(normalizedText, voice, lang) {
    const plans = [];
    let openaiVoice = voice;
    if (typeof voice === 'string' && voice.startsWith(AZURE_VOICE_PREFIX)) {
        openaiVoice = OPENAI_FALLBACK_VOICE;
        if (AZURE_ENABLED) {
            const azureVoice = resolveAzureVoice(voice.slice(AZURE_VOICE_PREFIX.length), lang);
            plans.push({
                label: `azure voice=${azureVoice}`,
                cacheKey: `${normalizedText}-${azureVoice}-${lang}-azure-`,
                synthesize: () => synthesizeWithAzure(normalizedText, azureVoice, lang),
            });
        } else {
            console.warn('[TTS] Azure voice requested but AZURE_SPEECH_KEY/AZURE_SPEECH_REGION are not set — using OpenAI.');
        }
    }
    plans.push(openaiPlan(normalizedText, openaiVoice, lang, TTS_MODEL));
    if (TTS_MODEL !== TTS_FALLBACK_MODEL) {
        plans.push(openaiPlan(normalizedText, openaiVoice, lang, TTS_FALLBACK_MODEL));
    }
    return plans;
}

function cachePathFor(cacheKey) {
    const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
    return path.join(CACHE_DIR, `${hash}.mp3`);
}

/** Returns true if a usable cached file exists (and refreshes its LRU timestamp). */
function useCachedFile(cachePath) {
    if (!fs.existsSync(cachePath)) return false;
    const stat = fs.statSync(cachePath);
    if (stat.size < 1000) {
        console.log(`[TTS] Deleting corrupted cache file (size ${stat.size}): ${cachePath}`);
        try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
        return false;
    }
    const now = new Date();
    try { fs.utimesSync(cachePath, now, now); } catch { /* ignore */ }
    return true;
}

async function getOrCreateTtsFile(text, voice, lang) {
    const normalizedText = normalizeText(text, lang);

    // Guard: normalizeText may strip all content (e.g. punctuation-only input)
    if (!normalizedText || normalizedText.trim().length === 0) {
        console.log('[TTS] Normalised text is empty — returning null');
        return null;
    }

    // Each plan caches under its own key, so fallback audio never hides the
    // preferred engine: it is retried on the next request.
    let lastError = null;
    for (const plan of buildTtsPlans(normalizedText, voice, lang)) {
        const cachePath = cachePathFor(plan.cacheKey);
        if (useCachedFile(cachePath)) {
            console.log(`[TTS] Cache HIT (${normalizedText.length} chars) ${plan.label}`);
            return cachePath;
        }
        console.log(`[TTS] Cache MISS. Generating ${lang} audio (${normalizedText.length} chars) ${plan.label}...`);
        await waitForTtsSlot();
        try {
            const buffer = await plan.synthesize();
            fs.writeFileSync(cachePath, buffer);
            evictCacheIfNeeded();
            return cachePath;
        } catch (error) {
            lastError = error;
            console.error(`[TTS] ${plan.label} failed (${error?.status ?? ''} ${error?.message}). Trying next engine.`);
        } finally {
            currentTtsJobs--;
        }
    }
    throw lastError ?? new Error('No TTS engine available');
}

app.post('/api/tts', ttsLimiter, async (req, res) => {
    try {
        const { text, voice = 'alloy', lang = 'en' } = req.body;

        if (!text) return res.status(400).json({ error: 'Text is required' });
        if (text.length > 5000) return res.status(400).json({ error: 'Text exceeds 5000 characters. Please chunk it.' });

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
    if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });
    }

    const jobId = crypto.randomUUID();
    downloadJobs.set(jobId, { status: 'processing', progress: 0, total: sentences.length, buffer: null, error: null });

    // Start background job
    (async () => {
        try {
            console.log(`[Download Job ${jobId}] Compiling ${sentences.length} sentences into MP3 (voice=${voice}, lang=${lang})...`);
            const buffers = [];
            for (let i = 0; i < sentences.length; i++) {
                const text = (sentences[i] || '').trim();
                if (text) {
                    const filePath = await getOrCreateTtsFile(text, voice, lang);
                    if (filePath) {
                        buffers.push(fs.readFileSync(filePath));
                    }
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

            // Clean up old jobs after 1 hour
            setTimeout(() => downloadJobs.delete(jobId), 3600000);
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
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OpenAI API key missing in backend/.env' });

        const chunks = splitExamText(text);
        console.log(`[ParseExam] Parsing ${text.length} chars across ${chunks.length} chunk(s)...`);

        const chunkResults = await Promise.all(chunks.map(chunk => parseExamChunk(chunk, openai)));
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
