import { apiFetch } from './api';

/** Same caps the old server-side download job enforced, to bound TTS cost. */
export const MAX_DOWNLOAD_SENTENCES = 120;
export const MAX_DOWNLOAD_TOTAL_CHARS = 30000;
const DOWNLOAD_CONCURRENCY = 3;

interface DownloadReadingOptions {
    sentences: string[];
    voice: string;
    lang: 'en' | 'fr';
    onProgress: (done: number, total: number) => void;
}

/**
 * Fetches /api/tts for every sentence (a few at a time) and joins the MP3
 * frames, in order, into one Blob. MP3 frames can be concatenated as-is.
 * Sentences reused from the reader are served from the backend cache.
 */
export async function buildReadingMp3({ sentences, voice, lang, onProgress }: DownloadReadingOptions): Promise<Blob> {
    const cleanSentences = sentences.map(s => s.trim()).filter(Boolean);
    if (cleanSentences.length === 0) throw new Error('Nothing to read.');
    if (cleanSentences.length > MAX_DOWNLOAD_SENTENCES) {
        throw new Error(`Download is limited to ${MAX_DOWNLOAD_SENTENCES} sentences.`);
    }
    const totalChars = cleanSentences.reduce((sum, s) => sum + s.length, 0);
    if (totalChars > MAX_DOWNLOAD_TOTAL_CHARS) {
        throw new Error(`Download is limited to ${MAX_DOWNLOAD_TOTAL_CHARS} characters.`);
    }

    const parts: (ArrayBuffer | null)[] = new Array<ArrayBuffer | null>(cleanSentences.length).fill(null);
    let nextIndex = 0;
    let done = 0;
    onProgress(0, cleanSentences.length);

    const worker = async (): Promise<void> => {
        while (nextIndex < cleanSentences.length) {
            const index = nextIndex++;
            const res = await apiFetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: cleanSentences[index], voice, lang }),
            });
            if (res.status !== 204) {
                if (!res.ok) throw new Error(`TTS API ${res.status}`);
                parts[index] = await res.arrayBuffer();
            }
            done++;
            onProgress(done, cleanSentences.length);
        }
    };

    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, cleanSentences.length) }, worker));

    const audioParts = parts.filter((part): part is ArrayBuffer => part !== null);
    if (audioParts.length === 0) throw new Error('No valid sentences to compile.');
    return new Blob(audioParts, { type: 'audio/mpeg' });
}
