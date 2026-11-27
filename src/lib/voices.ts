import { apiFetch } from './api';

export type VoiceEngine = 'openai' | 'azure';
export type VoiceLang = 'en' | 'fr';

export interface VoiceOption {
    /** Value sent to /api/tts. Azure ids are prefixed with "azure:". */
    id: string;
    name: string;
    desc: string;
    engine: VoiceEngine;
    /** Native language of an Azure voice; OpenAI voices read every language. */
    lang?: VoiceLang;
}

export const DEFAULT_VOICE_ID = 'echo';

export const OPENAI_VOICES: VoiceOption[] = [
    { id: 'onyx', name: 'Onyx', desc: 'Deep · Authoritative', engine: 'openai' },
    { id: 'echo', name: 'Echo', desc: 'Calm · Precise', engine: 'openai' },
    { id: 'fable', name: 'Fable', desc: 'Warm · Storytelling', engine: 'openai' },
    { id: 'nova', name: 'Nova', desc: 'Clear · Friendly', engine: 'openai' },
    { id: 'shimmer', name: 'Shimmer', desc: 'Soft · Gentle', engine: 'openai' },
    { id: 'alloy', name: 'Alloy', desc: 'Neutral · Balanced', engine: 'openai' },
];

// Must stay in sync with AZURE_ALLOWED_VOICES in backend/server.js.
export const AZURE_VOICES: VoiceOption[] = [
    { id: 'azure:fr-FR-VivienneMultilingualNeural', name: 'Vivienne', desc: 'Française native · Naturelle', engine: 'azure', lang: 'fr' },
    { id: 'azure:fr-FR-RemyMultilingualNeural', name: 'Rémy', desc: 'Français natif · Posé', engine: 'azure', lang: 'fr' },
    { id: 'azure:fr-FR-DeniseNeural', name: 'Denise', desc: 'Française native · Claire', engine: 'azure', lang: 'fr' },
    { id: 'azure:fr-FR-HenriNeural', name: 'Henri', desc: 'Français natif · Grave', engine: 'azure', lang: 'fr' },
    { id: 'azure:en-US-AvaMultilingualNeural', name: 'Ava', desc: 'Native English · Expressive', engine: 'azure', lang: 'en' },
    { id: 'azure:en-US-AndrewMultilingualNeural', name: 'Andrew', desc: 'Native English · Warm', engine: 'azure', lang: 'en' },
];

const ALL_VOICES: VoiceOption[] = [...AZURE_VOICES, ...OPENAI_VOICES];

/** Finds a voice by id across every engine. */
export function findVoice(id: string): VoiceOption | undefined {
    return ALL_VOICES.find(v => v.id === id);
}

/** Voices to offer for a reading language: native Azure voices first (when enabled), then OpenAI. */
export function getVoiceOptions(isAzureAvailable: boolean, lang: VoiceLang): VoiceOption[] {
    const azure = isAzureAvailable ? AZURE_VOICES.filter(v => v.lang === lang) : [];
    return [...azure, ...OPENAI_VOICES];
}

/** Returns a voice id the backend can serve: Azure ids fall back to the default when Azure is off. */
export function resolveSelectableVoice(id: string, isAzureAvailable: boolean | null): string {
    const voice = findVoice(id);
    if (!voice) return DEFAULT_VOICE_ID;
    if (voice.engine === 'azure' && isAzureAvailable === false) return DEFAULT_VOICE_ID;
    return id;
}

let azureAvailabilityPromise: Promise<boolean> | null = null;

/** Asks the backend once per page load whether Azure voices are configured. */
export function fetchAzureAvailability(): Promise<boolean> {
    if (!azureAvailabilityPromise) {
        azureAvailabilityPromise = (async () => {
            try {
                const res = await apiFetch('/api/health');
                if (!res.ok) throw new Error(`Health API ${res.status}`);
                const data: unknown = await res.json();
                return typeof data === 'object' && data !== null
                    && (data as { azureVoicesAvailable?: unknown }).azureVoicesAvailable === true;
            } catch (err) {
                console.error('[voices] Could not check Azure availability:', err);
                azureAvailabilityPromise = null; // retry on next call
                return false;
            }
        })();
    }
    return azureAvailabilityPromise;
}
