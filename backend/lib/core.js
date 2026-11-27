// ── Alphie backend core ──────────────────────────────────────────────────────
// Runtime-agnostic logic shared by the Node/Express server (backend/server.js)
// and the Cloudflare Worker (worker/src/index.js). Uses only web-standard APIs
// (fetch, crypto.subtle, TextEncoder) — never Node-only modules.

// ── Limits ───────────────────────────────────────────────────────────────────
export const DEFAULT_LIMITS = {
    maxTtsTextChars: 5000,
    maxExamTextChars: 75000,
    maxExamChunks: 8,
    maxExamConcurrentChunks: 2,
};

/** Reads a positive integer from an env-like object, falling back when absent/invalid. */
export function readPositiveInt(env, name, fallback) {
    const value = Number.parseInt(env?.[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Builds the limits object from env vars (same names on Node and Workers). */
export function readLimits(env) {
    return {
        maxTtsTextChars: readPositiveInt(env, 'TTS_MAX_TEXT_CHARS', DEFAULT_LIMITS.maxTtsTextChars),
        maxExamTextChars: readPositiveInt(env, 'EXAM_PARSE_MAX_TEXT_CHARS', DEFAULT_LIMITS.maxExamTextChars),
        maxExamChunks: readPositiveInt(env, 'EXAM_PARSE_MAX_CHUNKS', DEFAULT_LIMITS.maxExamChunks),
        maxExamConcurrentChunks: readPositiveInt(env, 'EXAM_PARSE_CONCURRENCY', DEFAULT_LIMITS.maxExamConcurrentChunks),
    };
}

/** Error carrying an HTTP status for the caller to return. */
export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Hex SHA-256 of a string (works in Node 18+ and Workers). */
export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Text normalisation for TTS ───────────────────────────────────────────────
export function normalizeText(text, lang) {
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

    // Period+capital → period+space so the voice takes a full pause
    clean = clean.replace(/\.([A-Z])/g, '. $1');

    return clean;
}

/** Splits text into sentences, protecting common abbreviations. */
export function splitSentences(text) {
    const abbrevMap = [];
    const protect = (m) => {
        const k = `${abbrevMap.length}`;
        abbrevMap.push(m);
        return k;
    };

    const processedText = text
        .replace(/\b(?:[A-Z]\.){2,}/g, protect)
        .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr)\./g, protect)
        .replace(/\b(?:vs|etc|approx|est|avg|dept|govt|ref|fig|vol|pp)\./g, protect)
        .replace(/\be\.g\./g, protect)
        .replace(/\bi\.e\./g, protect)
        .replace(/\bet al\./g, protect)
        .replace(/\b\d+(?:st|nd|rd|th)\./g, protect);

    const sentencesProtected = processedText.match(/[^.!?]+[.!?]+(?=\s*[A-Z]|$)/g)
        || processedText.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g)
        || [];

    const restoreAbbrevs = (s) => s.replace(/(\d+)/g, (_, i) => abbrevMap[parseInt(i, 10)]);

    const finalSentences = sentencesProtected
        .map(s => restoreAbbrevs(s).trim())
        .filter(s => s.split(/\s+/).length >= 3); // drop fragments under 3 words

    return finalSentences.length > 0 ? finalSentences : [text.trim()];
}

// ── OpenAI (REST via fetch) ──────────────────────────────────────────────────
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

async function openaiError(res, label) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`${label} ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    error.status = res.status;
    return error;
}

/** Chat completion that returns parsed JSON (response_format json_object). */
export async function openaiChatJson(apiKey, { model, messages, maxTokens, temperature }) {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            response_format: { type: 'json_object' },
        }),
    });
    if (!res.ok) throw await openaiError(res, 'OpenAI chat');
    const data = await res.json();
    return extractJson(data?.choices?.[0]?.message?.content ?? '');
}

/** Parses JSON from a model reply, tolerating ```json fences or surrounding text. */
export function extractJson(content) {
    const jsonMatch = content.match(/```json\n([\s\S]*)\n```/) || content.match(/{[\s\S]*}/);
    const raw = jsonMatch?.[1] ?? jsonMatch?.[0] ?? content;
    return JSON.parse(raw);
}

async function openaiSpeech(apiKey, { model, voice, input, instructions }) {
    const res = await fetch(`${OPENAI_BASE_URL}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            voice,
            input,
            response_format: 'mp3',
            ...(instructions ? { instructions } : {}),
        }),
    });
    if (!res.ok) throw await openaiError(res, 'OpenAI speech');
    return new Uint8Array(await res.arrayBuffer());
}

// ── TTS engines ──────────────────────────────────────────────────────────────
// gpt-4o-mini-tts sounds far more natural than tts-1 and accepts style
// instructions. Override with TTS_MODEL=tts-1 (or tts-1-hd) if needed.
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
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

// Azure Neural voices (same engine TTSReader uses). The frontend sends voice
// ids prefixed with "azure:" (e.g. "azure:fr-FR-DeniseNeural").
const AZURE_VOICE_PREFIX = 'azure:';
const AZURE_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';
const AZURE_LOCALES = { en: 'en-US', fr: 'fr-FR' };
// Default voice per reading language when the chosen voice can't read it natively.
const AZURE_DEFAULT_VOICES = {
    en: 'en-US-AvaMultilingualNeural',
    fr: 'fr-FR-VivienneMultilingualNeural',
};
// Only these voices are accepted from the client. Keep in sync with src/lib/voices.ts.
const AZURE_ALLOWED_VOICES = new Set([
    'fr-FR-VivienneMultilingualNeural',
    'fr-FR-RemyMultilingualNeural',
    'fr-FR-DeniseNeural',
    'fr-FR-HenriNeural',
    'en-US-AvaMultilingualNeural',
    'en-US-AndrewMultilingualNeural',
]);
const OPENAI_FALLBACK_VOICE = 'nova';

/**
 * Reads TTS configuration from an env-like object (process.env or Worker env).
 * @returns {{ openaiApiKey: string, ttsModel: string, azure: { key: string, region: string } | null }}
 */
export function readTtsConfig(env) {
    const azureKey = env?.AZURE_SPEECH_KEY || '';
    const azureRegion = env?.AZURE_SPEECH_REGION || '';
    return {
        openaiApiKey: env?.OPENAI_API_KEY || '',
        ttsModel: env?.TTS_MODEL || DEFAULT_TTS_MODEL,
        azure: azureKey && azureRegion ? { key: azureKey, region: azureRegion } : null,
    };
}

export function hasOpenAiKey(config) {
    return Boolean(config.openaiApiKey) && config.openaiApiKey !== 'dummy_key';
}

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

/** Calls the Azure Speech REST API and returns MP3 bytes. */
async function synthesizeWithAzure(azure, text, voiceName, lang) {
    const locale = AZURE_LOCALES[lang] ?? AZURE_LOCALES.en;
    // <lang> forces native pronunciation when a multilingual voice reads another language.
    const body = voiceName.includes('Multilingual')
        ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceName}"><lang xml:lang="${locale}">${escapeXml(text)}</lang></voice></speak>`
        : `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceName}">${escapeXml(text)}</voice></speak>`;

    const res = await fetch(`https://${azure.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': azure.key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
            'User-Agent': 'alphie-backend',
        },
        body,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const error = new Error(`Azure TTS ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        error.status = res.status;
        throw error;
    }
    return new Uint8Array(await res.arrayBuffer());
}

/** Synthesis plan for an OpenAI voice + model (cache key + synth fn). */
function openaiPlan(config, normalizedText, voice, lang, model) {
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
        synthesize: () => openaiSpeech(config.openaiApiKey, { model, voice: finalVoice, input: normalizedText, instructions }),
    };
}

/**
 * Ordered list of engines to try: the requested one first, then fallbacks
 * (Azure → OpenAI TTS_MODEL → tts-1). Each plan has its own cache key so
 * fallback audio never hides the preferred engine.
 */
export function buildTtsPlans(config, normalizedText, voice, lang) {
    const plans = [];
    let openaiVoice = voice;
    if (typeof voice === 'string' && voice.startsWith(AZURE_VOICE_PREFIX)) {
        openaiVoice = OPENAI_FALLBACK_VOICE;
        if (config.azure) {
            const azureVoice = resolveAzureVoice(voice.slice(AZURE_VOICE_PREFIX.length), lang);
            plans.push({
                label: `azure voice=${azureVoice}`,
                cacheKey: `${normalizedText}-${azureVoice}-${lang}-azure-`,
                synthesize: () => synthesizeWithAzure(config.azure, normalizedText, azureVoice, lang),
            });
        } else {
            console.warn('[TTS] Azure voice requested but AZURE_SPEECH_KEY/AZURE_SPEECH_REGION are not set — using OpenAI.');
        }
    }
    plans.push(openaiPlan(config, normalizedText, openaiVoice, lang, config.ttsModel));
    if (config.ttsModel !== TTS_FALLBACK_MODEL) {
        plans.push(openaiPlan(config, normalizedText, openaiVoice, lang, TTS_FALLBACK_MODEL));
    }
    return plans;
}

/**
 * Returns MP3 bytes for one sentence, trying each engine in order.
 * `cache` abstracts the storage: `{ get(key) => Uint8Array|null, put(key, bytes) }`.
 * Returns null when the text normalises to nothing.
 */
export async function getTtsAudio(config, cache, { text, voice, lang }) {
    const normalizedText = normalizeText(text, lang);
    if (!normalizedText || normalizedText.trim().length === 0) return null;

    let lastError = null;
    for (const plan of buildTtsPlans(config, normalizedText, voice, lang)) {
        const key = await sha256Hex(plan.cacheKey);
        const cached = await cache.get(key);
        if (cached) {
            console.log(`[TTS] Cache HIT (${normalizedText.length} chars) ${plan.label}`);
            return cached;
        }
        console.log(`[TTS] Cache MISS. Generating ${lang} audio (${normalizedText.length} chars) ${plan.label}...`);
        try {
            const bytes = await plan.synthesize();
            await cache.put(key, bytes);
            return bytes;
        } catch (error) {
            lastError = error;
            console.error(`[TTS] ${plan.label} failed (${error?.status ?? ''} ${error?.message}). Trying next engine.`);
        }
    }
    throw lastError ?? new Error('No TTS engine available');
}

/** Validates a /api/tts body; throws HttpError on bad input. */
export function validateTtsRequest(body, limits) {
    const { text, voice = 'alloy', lang = 'en' } = body ?? {};
    if (!text || typeof text !== 'string') throw new HttpError(400, 'Text is required');
    if (text.length > limits.maxTtsTextChars) {
        throw new HttpError(400, `Text exceeds ${limits.maxTtsTextChars} characters. Please chunk it.`);
    }
    return { text, voice: String(voice), lang: lang === 'fr' ? 'fr' : 'en' };
}

// ── Quiz ─────────────────────────────────────────────────────────────────────
const QUIZ_SYSTEM_PROMPT = `Generate exactly 4 multiple choice questions AND 1 open question based SOLELY on the user text. Output valid JSON only.

CRITICAL RULES for MCQ:
- The "correct" field is a 0-based index into the "options" array.
- Spread the correct index across 0 (A), 1 (B), 2 (C), and 3 (D) — do NOT place the correct answer at the same index for every question.
- All 4 options must be plausible.

Schema: {"questions":[{"type":"main|detail|apply","question":"...","options":["option_A","option_B","option_C","option_D"],"correct":2,"explanation":"...","reference":"..."}],"openQuestion":"A single open-ended question that requires a short written answer to test understanding of a key idea in the text."}`;

export async function generateQuiz(config, body) {
    const { text, lang = 'en' } = body ?? {};
    if (!text) throw new HttpError(400, 'Text is required');
    console.log(`[Quiz] Generating questions for text (${text.length} chars) in lang: ${lang}...`);
    return openaiChatJson(config.openaiApiKey, {
        model: 'gpt-4o-mini',
        maxTokens: 1200,
        temperature: 0.7,
        messages: [
            { role: 'system', content: QUIZ_SYSTEM_PROMPT },
            { role: 'user', content: `Language: ${lang}\n\nText:\n${text}` },
        ],
    });
}

// ── Exam parsing ─────────────────────────────────────────────────────────────
// Split large exam text into chunks at question boundaries to stay within max_tokens.
export function splitExamText(text) {
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

async function parseExamChunk(config, chunkText) {
    const parsed = await openaiChatJson(config.openaiApiKey, {
        model: 'gpt-4o',
        maxTokens: 8000,
        temperature: 0.2,
        messages: [
            { role: 'system', content: EXAM_CHUNK_SYSTEM_PROMPT },
            { role: 'user', content: chunkText },
        ],
    });
    return Array.isArray(parsed.questions) ? parsed.questions : [];
}

export async function parseExam(config, limits, body) {
    const { text } = body ?? {};
    if (!text?.trim()) throw new HttpError(400, 'text is required');
    if (text.length > limits.maxExamTextChars) {
        throw new HttpError(400, `Exam text exceeds ${limits.maxExamTextChars} characters.`);
    }

    const chunks = splitExamText(text);
    if (chunks.length > limits.maxExamChunks) {
        throw new HttpError(400, `Exam parse is limited to ${limits.maxExamChunks} chunks per request.`);
    }
    console.log(`[ParseExam] Parsing ${text.length} chars across ${chunks.length} chunk(s)...`);

    const chunkResults = [];
    for (let i = 0; i < chunks.length; i += limits.maxExamConcurrentChunks) {
        const batch = chunks.slice(i, i + limits.maxExamConcurrentChunks);
        chunkResults.push(...await Promise.all(batch.map(chunk => parseExamChunk(config, chunk))));
    }
    const allQuestions = chunkResults.flat();

    if (allQuestions.length === 0) {
        throw new HttpError(422, 'No multiple-choice questions found. Make sure to include answer choices (A, B, C, D) with your questions.');
    }
    console.log(`[ParseExam] Extracted ${allQuestions.length} questions from ${chunks.length} chunk(s).`);
    return { questions: allQuestions };
}

// ── Open-answer evaluation ───────────────────────────────────────────────────
const EVALUATE_SYSTEM_PROMPT = `You are a supportive learning coach evaluating a student's written answer to an open question about a text they read.

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

export async function evaluateAnswer(config, body) {
    const { question, answer, originalText } = body ?? {};
    if (!question || !answer || !originalText) {
        throw new HttpError(400, 'question, answer, and originalText are required');
    }
    console.log('[Evaluate] Checking answer...');
    return openaiChatJson(config.openaiApiKey, {
        model: 'gpt-4o-mini',
        maxTokens: 400,
        temperature: 0.4,
        messages: [
            { role: 'system', content: EVALUATE_SYSTEM_PROMPT },
            { role: 'user', content: `Original Text:\n${originalText}\n\nQuestion: ${question}\n\nStudent's Answer: ${answer}` },
        ],
    });
}
