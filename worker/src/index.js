// ── Alphie API on Cloudflare Workers ─────────────────────────────────────────
// Same endpoints as backend/server.js, sharing backend/lib/core.js.
// Audio is cached in the Cloudflare Cache API instead of on disk.
import {
    HttpError,
    evaluateAnswer,
    generateQuiz,
    getTtsAudio,
    hasOpenAiKey,
    parseExam,
    readLimits,
    readTtsConfig,
    splitSentences,
    validateTtsRequest,
} from '../../backend/lib/core.js';

const CACHE_ORIGIN = 'https://alphie-tts-cache.internal';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Cache adapter for getTtsAudio backed by caches.default. */
function createEdgeCache(ctx) {
    const cache = caches.default;
    return {
        async get(key) {
            const hit = await cache.match(`${CACHE_ORIGIN}/${key}`);
            return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
        },
        async put(key, bytes) {
            const response = new Response(bytes, {
                headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
            });
            // Don't make the listener wait for the cache write.
            ctx.waitUntil(cache.put(`${CACHE_ORIGIN}/${key}`, response));
        },
    };
}

function allowedOrigins(env) {
    return (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function readJsonBody(request) {
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    try {
        return await request.json();
    } catch {
        throw new HttpError(400, 'Invalid JSON body');
    }
}

/**
 * Applies a Workers rate limiting binding when configured.
 * Missing bindings (e.g. local dev without them) never block requests.
 */
async function isRateLimited(limiter, request) {
    if (!limiter) return false;
    const key = request.headers.get('CF-Connecting-IP') || 'anonymous';
    try {
        const { success } = await limiter.limit({ key });
        return !success;
    } catch (error) {
        console.error('[RateLimit] binding failed, allowing request:', error);
        return false;
    }
}

function isAuthorized(request, env) {
    if (!env.API_SECRET) return true;
    const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
    return token === env.API_SECRET;
}

function audioResponse(bytes, request) {
    const size = bytes.length;
    const range = request.headers.get('Range');
    const match = range?.match(/bytes=(\d*)-(\d*)/);
    if (match && match[1] !== '') {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        return new Response(bytes.subarray(start, end + 1), {
            status: 206,
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Content-Length': String(end - start + 1),
                'Accept-Ranges': 'bytes',
            },
        });
    }
    return new Response(bytes, {
        headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=86400',
        },
    });
}

const AI_ROUTES = {
    '/api/quiz': { label: 'Quiz Generation', publicError: 'Failed to generate quiz', run: (config, _limits, body) => generateQuiz(config, body) },
    '/api/questions': { label: 'Quiz Generation', publicError: 'Failed to generate quiz', run: (config, _limits, body) => generateQuiz(config, body) },
    '/api/parse-exam': { label: 'ParseExam', publicError: 'Failed to parse exam questions.', run: (config, limits, body) => parseExam(config, limits, body) },
    '/api/evaluate': { label: 'Evaluate', publicError: 'Failed to evaluate answer', run: (config, _limits, body) => evaluateAnswer(config, body) },
};

async function route(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const config = readTtsConfig(env);
    const limits = readLimits(env);

    if (pathname === '/api/health' && request.method === 'GET') {
        return json({ status: 'ok', openaiKeyLoaded: hasOpenAiKey(config), azureVoicesAvailable: Boolean(config.azure) });
    }

    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (!isAuthorized(request, env)) return json({ error: 'Unauthorized' }, 401);

    if (pathname === '/api/tts') {
        if (await isRateLimited(env.TTS_LIMITER, request)) {
            return json({ error: 'Too many TTS requests, please try again later.' }, 429);
        }
        try {
            const ttsRequest = validateTtsRequest(await readJsonBody(request), limits);
            if (!hasOpenAiKey(config)) return json({ error: 'OpenAI API key missing on the server' }, 500);
            const audio = await getTtsAudio(config, createEdgeCache(ctx), ttsRequest);
            if (!audio) return new Response(null, { status: 204 });
            return audioResponse(audio, request);
        } catch (error) {
            if (error instanceof HttpError) return json({ error: error.message }, error.status);
            console.error('TTS Error:', error);
            return json({ error: 'Failed to generate audio' }, 500);
        }
    }

    if (pathname === '/api/sentences') {
        try {
            const { text } = await readJsonBody(request);
            if (!text) return json({ error: 'Text required' }, 400);
            return json({ sentences: splitSentences(text) });
        } catch (error) {
            if (error instanceof HttpError) return json({ error: error.message }, error.status);
            return json({ error: 'Failed to split sentences' }, 500);
        }
    }

    const aiRoute = AI_ROUTES[pathname];
    if (aiRoute) {
        if (await isRateLimited(env.AI_LIMITER, request)) {
            return json({ error: 'Too many AI requests, please try again later.' }, 429);
        }
        try {
            if (!hasOpenAiKey(config)) return json({ error: 'OpenAI API key missing on the server' }, 500);
            return json(await aiRoute.run(config, limits, await readJsonBody(request)));
        } catch (error) {
            if (error instanceof HttpError) return json({ error: error.message }, error.status);
            console.error(`${aiRoute.label} Error:`, error);
            return json({ error: aiRoute.publicError }, 500);
        }
    }

    return json({ error: 'Not found' }, 404);
}

export default {
    async fetch(request, env, ctx) {
        const cors = corsHeaders(request, env);
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        const response = await route(request, env, ctx);
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(cors)) headers.set(name, value);
        return new Response(response.body, { status: response.status, headers });
    },
};
