import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { CheckCircle2, XCircle, Loader2, Paperclip } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import { splitSentences } from '../hooks/useSentenceSplitter';
import './InputView.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface InputViewProps {
    onStart: (text: string, mode: 'read' | 'learn', language: 'english' | 'french') => void;
    onArena?: () => void;
    onPrewarm?: (sentence0: string, voice: string, lang: string) => void;
}

type TestStatus = 'idle' | 'running' | 'pass' | 'fail';
type AppTheme = 'night' | 'light' | 'sepia' | 'forest';

const TTS_VOICES = [
    { id: 'onyx', name: 'Onyx', desc: 'Deep · Authoritative' },
    { id: 'echo', name: 'Echo', desc: 'Calm · Precise' },
    { id: 'fable', name: 'Fable', desc: 'Warm · Storytelling' },
    { id: 'nova', name: 'Nova', desc: 'Clear · Friendly' },
    { id: 'shimmer', name: 'Shimmer', desc: 'Soft · Gentle' },
    { id: 'alloy', name: 'Alloy', desc: 'Neutral · Balanced' },
] as const;

type TTSVoice = typeof TTS_VOICES[number]['id'];

const THEMES: { id: AppTheme; label: string; dot: string }[] = [
    { id: 'night', label: 'Night', dot: '#0D0D1A' },
    { id: 'light', label: 'Light', dot: '#F2F0EC' },
    { id: 'sepia', label: 'Sepia', dot: '#E8DDD0' },
    { id: 'forest', label: 'Forest', dot: '#0A110D' },
];

function applyTheme(theme: AppTheme) {
    if (theme === 'night') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
}

interface SystemTestState {
    backend: { status: TestStatus; error?: string; fix?: string };
    openai: { status: TestStatus; error?: string; fix?: string };
    tts: { status: TestStatus; bytes?: number; error?: string; fix?: string };
    playback: { status: TestStatus; error?: string; fix?: string };
    logMessage: string | null;
}

const initialTestState: SystemTestState = {
    backend: { status: 'idle' },
    openai: { status: 'idle' },
    tts: { status: 'idle' },
    playback: { status: 'idle' },
    logMessage: null,
};

// Removed local extractFirstSentence — we now use useSentenceSplitter directly

export default function InputView({ onStart, onArena, onPrewarm }: InputViewProps) {
    const [text, setText] = useState('');
    const [isExtracting, setIsExtracting] = useState(false);
    const [readingLanguage, setReadingLanguage] = useState<'english' | 'french'>('english');
    const [voiceOpen, setVoiceOpen] = useState(false);

    const [mode, setMode] = useState<'read' | 'learn'>(() =>
        (localStorage.getItem('playlearn_mode') as 'read' | 'learn') || 'read'
    );

    const [selectedVoice, setSelectedVoice] = useState<TTSVoice>(() =>
        (localStorage.getItem('playlearn_voice') as TTSVoice) || 'echo'
    );

    const [theme, setThemeState] = useState<AppTheme>(() => {
        const saved = localStorage.getItem('playlearn_theme') as AppTheme | null;
        const valid = saved && THEMES.some(t => t.id === saved) ? saved : 'night';
        applyTheme(valid);
        return valid;
    });

    const handleTheme = (t: AppTheme) => {
        setThemeState(t);
        localStorage.setItem('playlearn_theme', t);
        applyTheme(t);
    };

    // Language slider
    const langEnRef = useRef<HTMLButtonElement>(null);
    const langFrRef = useRef<HTMLButtonElement>(null);
    const [sliderStyle, setSliderStyle] = useState<{ left: string; width: string }>({ left: '3px', width: '0px' });

    const fileInputRef = useRef<HTMLInputElement>(null);
    const audioTestRef = useRef<HTMLAudioElement | null>(null);
    const voiceDropRef = useRef<HTMLDivElement>(null);
    const [testState, setTestState] = useState<SystemTestState>(initialTestState);
    const [showTests, setShowTests] = useState(false);

    useLayoutEffect(() => {
        const ref = readingLanguage === 'english' ? langEnRef : langFrRef;
        if (!ref.current) return;
        const { offsetLeft, offsetWidth } = ref.current;
        setSliderStyle({ left: `${offsetLeft}px`, width: `${offsetWidth}px` });
    }, [readingLanguage]);

    // Close voice dropdown on outside click
    const handleOutsideClick = useCallback((e: MouseEvent) => {
        if (voiceDropRef.current && !voiceDropRef.current.contains(e.target as Node)) {
            setVoiceOpen(false);
        }
    }, []);

    useEffect(() => {
        document.addEventListener('mousedown', handleOutsideClick);
        return () => document.removeEventListener('mousedown', handleOutsideClick);
    }, [handleOutsideClick]);

    // --- Pre-warm TTS: fire 1500ms after user stops typing / changes voice / lang ---
    const prewarmLang = readingLanguage === 'french' ? 'fr' : 'en';
    // Stable ref so the timeout callback always reads fresh values
    const prewarmRef = useRef({ voice: selectedVoice, lang: prewarmLang, text });
    prewarmRef.current = { voice: selectedVoice, lang: prewarmLang, text };
    // Dedup: track the last key we actually fired so we don't repeat for same sentence
    const lastPrewarmKeyRef = useRef('');

    const { spoken } = splitSentences(text);
    const sentence0 = useMemo(() => spoken[0] || '', [spoken]);

    useEffect(() => {
        if (!onPrewarm || !sentence0) return;
        const timer = setTimeout(() => {
            const { voice, lang } = prewarmRef.current;
            const key = `${sentence0}|${voice}|${lang}`;
            if (key === lastPrewarmKeyRef.current) return; // already sent
            lastPrewarmKeyRef.current = key;
            onPrewarm(sentence0, voice, lang);
        }, 1500);
        return () => clearTimeout(timer);
    }, [sentence0, selectedVoice, prewarmLang, onPrewarm]);

    const handleModeSelect = (newMode: 'read' | 'learn') => {
        setMode(newMode);
        localStorage.setItem('playlearn_mode', newMode);
    };

    const handleVoiceSelect = (voiceId: TTSVoice) => {
        setSelectedVoice(voiceId);
        localStorage.setItem('playlearn_voice', voiceId);
        setVoiceOpen(false);
    };

    const handlePlay = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (!text.trim()) return;
        // ripple
        const btn = e.currentTarget;
        const rect = btn.getBoundingClientRect();
        const ripple = document.createElement('span');
        ripple.className = 'iv-ripple';
        const size = Math.max(btn.offsetWidth, btn.offsetHeight);
        ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
        btn.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
        onStart(text, mode, readingLanguage);
    };

    // Fire prewarm immediately on mousedown — ~150ms before click event fires.
    // This gives the TTS request a head start even if user clicks before the debounce.
    const handlePlayMouseDown = () => {
        if (!onPrewarm || !text.trim()) return;
        const { spoken } = splitSentences(text);
        const s0 = spoken[0];
        if (!s0) return;
        const lang = readingLanguage === 'french' ? 'fr' : 'en';
        const key = `${s0}|${selectedVoice}|${lang}`;
        if (key !== lastPrewarmKeyRef.current) {
            lastPrewarmKeyRef.current = key;
            onPrewarm(s0, selectedVoice, lang);
        }
    };

    // Fire prewarm instantly on paste — text is fully formed, no debounce needed.
    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const pasted = e.clipboardData.getData('text');
        if (!onPrewarm || !pasted.trim()) return;
        const { spoken } = splitSentences(pasted);
        const s0 = spoken[0];
        if (!s0) return;
        const lang = readingLanguage === 'french' ? 'fr' : 'en';
        const key = `${s0}|${selectedVoice}|${lang}`;
        if (key !== lastPrewarmKeyRef.current) {
            lastPrewarmKeyRef.current = key;
            onPrewarm(s0, selectedVoice, lang);
        }
    };

    const extractTextFromPdf = async (file: File) => {
        try {
            setIsExtracting(true);
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items
                    .map((item) => ('str' in item ? (item as { str: string }).str : ''))
                    .join(' ');
                fullText += pageText + '\n\n';
            }
            setText(fullText.trim());
        } catch (error) {
            console.error('Error extracting PDF:', error);
            alert('Failed to extract text from PDF.');
        } finally {
            setIsExtracting(false);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type === 'application/pdf') {
            extractTextFromPdf(file);
        } else if (file.type === 'text/plain') {
            const t = await file.text();
            setText(t);
        } else {
            alert('Please upload a PDF or TXT file.');
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // @ts-expect-error — kept for future diagnostics UI
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runSystemCheck = async () => {
        setShowTests(true);
        setTestState({ ...initialTestState, backend: { status: 'running' } });
        try {
            const res = await fetch(`${import.meta.env.VITE_API_URL}/api/health`);
            if (!res.ok) throw new Error('Bad response');
            const data = await res.json();
            setTestState(prev => ({ ...prev, backend: { status: 'pass' }, openai: { status: 'running' } }));
            if (!data.keyLoaded) {
                setTestState(prev => ({ ...prev, openai: { status: 'fail', error: 'No API Key found.', fix: 'Add your OpenAI API key to backend/.env and restart server.js' }, logMessage: 'keyLoaded: false' }));
                return;
            }
            setTestState(prev => ({ ...prev, openai: { status: 'pass' }, tts: { status: 'running' } }));
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({ ...prev, backend: { status: 'fail', error: errorMessage, fix: 'Run `node server.js` in the backend folder.' }, logMessage: errorMessage }));
            return;
        }
        let audioBlobUrl = '';
        try {
            const ttsRes = await fetch(`${import.meta.env.VITE_API_URL}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Test one two', voice: 'alloy', lang: 'en' }) });
            if (!ttsRes.ok) { const e = await ttsRes.json().catch(() => ({})); throw new Error(e.error || `HTTP ${ttsRes.status}`); }
            const blob = await ttsRes.blob();
            if (blob.size === 0) throw new Error('Empty audio buffer');
            audioBlobUrl = URL.createObjectURL(blob);
            setTestState(prev => ({ ...prev, tts: { status: 'pass', bytes: blob.size }, playback: { status: 'running' } }));
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({ ...prev, tts: { status: 'fail', error: errorMessage, fix: 'Check your OpenAI billing.' }, logMessage: `POST /api/tts failed: ${errorMessage}` }));
            return;
        }
        try {
            if (!audioTestRef.current) audioTestRef.current = new Audio();
            audioTestRef.current.src = audioBlobUrl;
            await audioTestRef.current.play();
            setTestState(prev => ({ ...prev, playback: { status: 'pass' }, logMessage: 'All systems green!' }));
        } catch (err: unknown) {
            const errorName = err instanceof Error ? err.name : 'Error';
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({ ...prev, playback: { status: 'fail', error: errorName, fix: 'Click the page first to allow browser audio autoplay.' }, logMessage: `Playback blocked: ${errorName} - ${errorMessage}` }));
        }
    };

    const StatusIcon = ({ status }: { status: TestStatus }) => {
        if (status === 'running') return <Loader2 size={18} className="spin-icon text-blue" />;
        if (status === 'pass') return <CheckCircle2 size={18} className="text-green" />;
        if (status === 'fail') return <XCircle size={18} className="text-red" />;
        return <div className="empty-circle"></div>;
    };

    const wordCount = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
    const hasText = text.trim().length > 0;
    const ctaLabel = hasText ? (mode === 'read' ? 'Start Reading' : 'Play & Learn') : 'Paste text to begin';
    const currentVoice = TTS_VOICES.find(v => v.id === selectedVoice)!;

    return (
        <div className="iv-page">

            {/* ── Fixed theme switcher top-right ── */}
            <nav className="iv-theme-switcher" aria-label="Theme switcher">
                {THEMES.map(t => (
                    <button
                        key={t.id}
                        className={`iv-th-btn ${theme === t.id ? 'active' : ''}`}
                        style={{ backgroundColor: t.dot }}
                        data-tip={t.label}
                        onClick={() => handleTheme(t.id)}
                        aria-label={`${t.label} theme`}
                        title={t.label}
                    />
                ))}
            </nav>

            {/* ── Ambient glow background ── */}
            <div className="iv-ambient" aria-hidden="true">
                <div className="iv-glow iv-glow-1" />
                <div className="iv-glow iv-glow-2" />
            </div>

            <div className="iv-screen">

                {/* ── Logo ── */}
                <div className="iv-logo">
                    <div className="iv-logo-mark">✦</div>
                    <span className="iv-logo-name">Alphie</span>
                    <span className="iv-logo-sub">Read deeply. Learn fully.</span>
                </div>

                {/* ── Textarea ── */}
                <div className="iv-input-wrap">
                    <div className="iv-input-border" aria-hidden="true" />
                    <div className="iv-input-inner">
                        <textarea
                            className="iv-textarea"
                            placeholder={isExtracting ? 'Extracting text…' : 'Paste anything you want to understand…'}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            onPaste={handlePaste}
                            disabled={isExtracting}
                            aria-label="Paste your text here"
                        />
                        <div className="iv-input-footer">
                            <button
                                className="iv-upload-pill"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isExtracting}
                                aria-label="Upload PDF or TXT"
                            >
                                {isExtracting
                                    ? <Loader2 size={13} className="spin-icon" />
                                    : <Paperclip size={13} />}
                                <span>Upload file</span>
                            </button>
                            <span className={`iv-word-count ${wordCount > 0 ? 'show' : ''}`}>
                                {wordCount} {wordCount === 1 ? 'word' : 'words'}
                            </span>
                        </div>
                    </div>
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept=".txt,.pdf"
                        aria-label="Upload file"
                        style={{ display: 'none' }}
                    />
                </div>

                {/* ── Controls row: Mode | Voice | Lang ── */}
                <div className="iv-controls">

                    {/* Mode */}
                    <div className="iv-mode-toggle" role="group" aria-label="Reading mode">
                        <button
                            className={`iv-mode-btn ${mode === 'read' ? 'active' : ''}`}
                            onClick={() => handleModeSelect('read')}
                        >Read</button>
                        <button
                            className={`iv-mode-btn ${mode === 'learn' ? 'active' : ''}`}
                            onClick={() => handleModeSelect('learn')}
                        >Learn</button>
                    </div>

                    {/* Voice dropdown pill */}
                    <div
                        className={`iv-voice-pill ${voiceOpen ? 'open' : ''}`}
                        ref={voiceDropRef}
                        onClick={() => setVoiceOpen(o => !o)}
                        role="button"
                        aria-haspopup="listbox"
                        aria-expanded={voiceOpen ? 'true' : 'false'}
                        aria-label={`Voice: ${currentVoice.name}`}
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && setVoiceOpen(o => !o)}
                    >
                        <div className="iv-wave-mini" aria-hidden="true">
                            <div className="iv-wbar" /><div className="iv-wbar" /><div className="iv-wbar" /><div className="iv-wbar" />
                        </div>
                        <span className="iv-voice-label">{currentVoice.name}</span>
                        <span className="iv-chevron" aria-hidden="true">▾</span>

                        {/* Floating dropdown */}
                        <div className={`iv-voice-dropdown ${voiceOpen ? 'open' : ''}`} role="listbox">
                            {TTS_VOICES.map(v => (
                                <button
                                    key={v.id}
                                    className={`iv-vopt ${selectedVoice === v.id ? 'sel' : ''}`}
                                    role="option"
                                    aria-selected={selectedVoice === v.id ? 'true' : 'false'}
                                    onClick={(e) => { e.stopPropagation(); handleVoiceSelect(v.id); }}
                                >
                                    <div className="iv-vopt-wave" aria-hidden="true">
                                        <div className="iv-vbar" /><div className="iv-vbar" /><div className="iv-vbar" /><div className="iv-vbar" />
                                    </div>
                                    <div className="iv-vopt-info">
                                        <div className="iv-vopt-name">{v.name}</div>
                                        <div className="iv-vopt-desc">{v.desc}</div>
                                    </div>
                                    <div className="iv-vopt-check" aria-hidden="true">✓</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Language */}
                    <div className="iv-lang-toggle">
                        <div
                            className="iv-lang-track"
                            style={{
                                left: sliderStyle.left,
                                width: sliderStyle.width,
                            } as React.CSSProperties}
                            aria-hidden="true"
                        />
                        <button
                            ref={langEnRef}
                            className={`iv-lang-btn ${readingLanguage === 'english' ? 'active' : ''}`}
                            onClick={() => setReadingLanguage('english')}
                        >EN</button>
                        <button
                            ref={langFrRef}
                            className={`iv-lang-btn ${readingLanguage === 'french' ? 'active' : ''}`}
                            onClick={() => setReadingLanguage('french')}
                        >FR</button>
                    </div>

                </div>

                {/* ── CTA ── */}
                <div className="iv-cta-wrap">
                    <button
                        className={`iv-cta-btn ${hasText ? 'ready' : 'waiting'}`}
                        onClick={hasText ? handlePlay : undefined}
                        onMouseDown={hasText ? handlePlayMouseDown : undefined}
                        disabled={isExtracting}
                        aria-label={ctaLabel}
                    >
                        <span className="iv-cta-icon">{hasText ? '▶' : '✦'}</span>
                        <span>{ctaLabel}</span>
                    </button>
                </div>

                {/* ── Hint ── */}
                <p className={`iv-hint ${mode === 'learn' ? 'show' : ''}`}>
                    Learn mode runs a quiz and Feynman Test after reading
                </p>

            </div>

            {/* ── Theme label ── */}
            <div className="iv-theme-label" aria-hidden="true">
                {THEMES.find(t => t.id === theme)?.label ?? 'Night'}
            </div>

            {/* ── Arena shortcut ── */}
            {onArena && (
                <button className="iv-arena-btn" onClick={onArena} aria-label="Go to Arena">
                    🏆 Arena
                </button>
            )}

            {/* ── Diagnostics (hidden) ── */}
            {showTests && (
                <div className="diagnostics-panel">
                    <h3>Diagnostic Pipeline</h3>
                    <ul className="test-list">
                        {[
                            { label: 'Backend Connectivity', key: 'backend' as const },
                            { label: 'OpenAI Key Loaded', key: 'openai' as const },
                            { label: 'TTS API Voice Check', key: 'tts' as const },
                            { label: 'Audio Playback', key: 'playback' as const },
                        ].map(({ label, key }) => (
                            <li key={key} className="test-row">
                                <StatusIcon status={testState[key].status} />
                                <span>{label}</span>
                                {testState[key].status === 'fail' && testState[key].error && (
                                    <span className="test-error">— {testState[key].error}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                    {testState.logMessage && <p className="test-log">{testState.logMessage}</p>}
                </div>
            )}
        </div>
    );
}
