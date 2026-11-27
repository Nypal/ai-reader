import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { CheckCircle2, XCircle, Loader2, Paperclip, Download } from 'lucide-react';
import { splitSentences } from '../hooks/useSentenceSplitter';
import { useAzureVoices } from '../hooks/useAzureVoices';
import { apiFetch } from '../lib/api';
import { OPENAI_VOICES, findVoice, getEffectiveVoiceId, getVoiceOptions } from '../lib/voices';
import './InputView.css';

interface InputViewProps {
    onStart: (text: string, mode: 'read' | 'learn', language: 'english' | 'french') => void;
    onExam?: (text: string) => void;
    onArena?: () => void;
    onPrewarm?: (sentence0: string, voice: string, lang: string) => void;
    onPdfReady?: (file: File | null, pageTexts: string[]) => void;
    initialContent?: string;
}

type TestStatus = 'idle' | 'running' | 'pass' | 'fail';
type AppTheme = 'night' | 'light' | 'sepia' | 'forest';

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

export default function InputView({ onStart, onExam, onArena, onPrewarm, onPdfReady, initialContent }: InputViewProps) {
    const [text, setText] = useState(initialContent ?? '');
    const [isExtracting, setIsExtracting] = useState(false);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [pdfPageCount, setPdfPageCount] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [readingLanguage, setReadingLanguage] = useState<'english' | 'french'>('english');
    const [voiceOpen, setVoiceOpen] = useState(false);

    const [mode, setMode] = useState<'read' | 'learn' | 'exam'>(() => {
        const saved = localStorage.getItem('playlearn_mode');
        if (saved === 'read' || saved === 'learn' || saved === 'exam') return saved;
        return 'read';
    });

    const isAzureAvailable = useAzureVoices();
    // null = the reader never picked a voice, so the language default applies (Vivienne in French).
    const [storedVoice, setSelectedVoice] = useState<string | null>(() =>
        localStorage.getItem('playlearn_voice')
    );
    const voiceLang = readingLanguage === 'french' ? 'fr' : 'en';
    const selectedVoice = getEffectiveVoiceId(storedVoice, voiceLang, isAzureAvailable);
    const voiceOptions = getVoiceOptions(isAzureAvailable === true, voiceLang);

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

    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadTotal, setDownloadTotal] = useState(0);

    const handleDownloadMp3 = async () => {
        if (!text.trim() || isDownloading) return;
        setIsDownloading(true);
        setDownloadError(null);
        setDownloadProgress(0);
        setDownloadTotal(0);
        try {
            const lang = readingLanguage === 'french' ? 'fr' : 'en';
            const { spoken } = splitSentences(text);
            const res = await apiFetch('/api/download-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sentences: spoken, voice: selectedVoice, lang }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                throw new Error(err.error ?? `HTTP ${res.status}`);
            }

            const { jobId } = await res.json();

            while (true) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const statusRes = await apiFetch(`/api/download-audio/${jobId}/status`);
                if (!statusRes.ok) throw new Error('Failed to fetch job status');
                const statusData = await statusRes.json();

                if (statusData.status === 'error') {
                    throw new Error(statusData.error || 'Compilation failed');
                }

                setDownloadProgress(statusData.progress || 0);
                setDownloadTotal(statusData.total || 0);

                if (statusData.status === 'completed') {
                    const downloadUrl = `${import.meta.env.VITE_API_URL || ''}/api/download-audio/${jobId}/file`;
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = 'alphie-reading.mp3';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    break;
                }
            }
        } catch (e: unknown) {
            setDownloadError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsDownloading(false);
            setTimeout(() => {
                setDownloadProgress(0);
                setDownloadTotal(0);
            }, 1000);
        }
    };

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
        if (!onPrewarm || !sentence0 || mode === 'exam') return;
        const timer = setTimeout(() => {
            const { voice, lang } = prewarmRef.current;
            const key = `${sentence0}|${voice}|${lang}`;
            if (key === lastPrewarmKeyRef.current) return; // already sent
            lastPrewarmKeyRef.current = key;
            onPrewarm(sentence0, voice, lang);
        }, 1500);
        return () => clearTimeout(timer);
    }, [sentence0, selectedVoice, prewarmLang, onPrewarm, mode]);

    const handleModeSelect = (newMode: 'read' | 'learn' | 'exam') => {
        setMode(newMode);
        localStorage.setItem('playlearn_mode', newMode);
    };

    const handleVoiceSelect = (voiceId: string) => {
        setSelectedVoice(voiceId);
        localStorage.setItem('playlearn_voice', voiceId);
        setVoiceOpen(false);
    };

    const handlePlay = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (!text.trim()) return;
        if (mode === 'exam') {
            onExam?.(text);
            return;
        }
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
            const pdfjsLib = await import('pdfjs-dist');
            const pdfWorker = await import('pdfjs-dist/build/pdf.worker.min?url');
            pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;

            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            const pageTexts: string[] = [];

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items
                    .map((item) => ('str' in item ? (item as { str: string }).str : ''))
                    .join(' ');
                pageTexts.push(pageText);
            }

            const fullText = pageTexts.join('\n\n').trim();
            setText(fullText);
            setPdfFile(file);
            setPdfPageCount(pdf.numPages);
            onPdfReady?.(file, pageTexts);
        } catch (error) {
            console.error('Error extracting PDF:', error);
            alert('Failed to extract text from PDF.');
        } finally {
            setIsExtracting(false);
        }
    };

    const extractTextFromDocx = async (file: File) => {
        try {
            setIsExtracting(true);
            const arrayBuffer = await file.arrayBuffer();
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ arrayBuffer });
            setText(result.value);
            // Hide the PDF view if it was active
            setPdfFile(null);
            setPdfPageCount(0);
            onPdfReady?.(null, []);
        } catch (error) {
            console.error('Error extracting Word doc:', error);
            alert('Failed to extract text from Word document.');
        } finally {
            setIsExtracting(false);
        }
    };

    const removePdf = () => {
        setPdfFile(null);
        setPdfPageCount(0);
        setText('');
        onPdfReady?.(null, []);
    };

    const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        if (file.type === 'application/pdf') {
            extractTextFromPdf(file);
        } else if (file.name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            extractTextFromDocx(file);
        } else if (file.type === 'text/plain') {
            file.text().then(setText);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.type === 'application/pdf') {
            extractTextFromPdf(file);
        } else if (file.name.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            extractTextFromDocx(file);
        } else if (file.type === 'text/plain') {
            const t = await file.text();
            setText(t);
        } else {
            alert('Please upload a PDF, Word (.docx), or TXT file.');
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // @ts-expect-error — kept for future diagnostics UI
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runSystemCheck = async () => {
        setShowTests(true);
        setTestState({ ...initialTestState, backend: { status: 'running' } });
        try {
            const res = await apiFetch('/api/health');
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
        let audioBlobUrl: string;
        try {
            const ttsRes = await apiFetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Test one two', voice: 'alloy', lang: 'en' }) });
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
    const ctaLabel = hasText
        ? (mode === 'exam' ? 'Practice Test' : mode === 'read' ? 'Start Reading' : 'Play & Learn')
        : (mode === 'exam' ? 'Paste exam questions to begin' : 'Paste text to begin');
    const currentVoice = findVoice(selectedVoice) ?? OPENAI_VOICES[1];

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
                                aria-label="Upload PDF, Word, or TXT"
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
                        accept=".txt,.pdf,.docx"
                        aria-label="Upload file"
                        style={{ display: 'none' }}
                    />
                </div>

                {/* ── PDF Zone ── */}
                {!pdfFile ? (
                    <div
                        className={`iv-pdf-zone ${isDragging ? 'dragging' : ''} ${isExtracting ? 'loading' : ''}`}
                        onClick={() => !isExtracting && fileInputRef.current?.click()}
                        onDragEnter={handleDragEnter}
                        onDragLeave={handleDragLeave}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        role="button"
                        tabIndex={0}
                        aria-label="Upload PDF"
                        onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                    >
                        <span className="iv-pdf-zone-icon">
                            {isExtracting ? '⏳' : isDragging ? '📥' : '📄'}
                        </span>
                        <div className="iv-pdf-zone-text">
                            <span className="iv-pdf-zone-title">
                                {isExtracting ? 'Extracting text…' : isDragging ? 'Drop your file' : 'Upload a file'}
                            </span>
                            <span className="iv-pdf-zone-sub">
                                {isExtracting ? 'Please wait' : mode === 'exam' ? 'All questions parsed automatically' : 'PDF or Word (.docx)'}
                            </span>
                        </div>
                    </div>
                ) : (
                    <div className="iv-pdf-loaded">
                        <span className="iv-pdf-loaded-icon">📄</span>
                        <div className="iv-pdf-loaded-info">
                            <span className="iv-pdf-loaded-name">{pdfFile.name}</span>
                            <span className="iv-pdf-loaded-pages">{pdfPageCount} pages · PDF view enabled</span>
                        </div>
                        <button className="iv-pdf-remove" onClick={removePdf} aria-label="Remove PDF" title="Remove PDF">✕</button>
                    </div>
                )}

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
                        <button
                            className={`iv-mode-btn ${mode === 'exam' ? 'active' : ''}`}
                            onClick={() => handleModeSelect('exam')}
                        >Exam</button>
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
                            {voiceOptions.map(v => (
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
                    {hasText && mode !== 'exam' && (
                        <div className="iv-download-wrap">
                            <button
                                className={`iv-download-btn ${isDownloading ? 'loading' : ''}`}
                                onClick={handleDownloadMp3}
                                disabled={isDownloading || isExtracting}
                                aria-label="Download MP3"
                                title="Download reading as MP3"
                                style={isDownloading && downloadTotal > 0 ? {
                                    background: `linear-gradient(90deg, var(--accent-glow) ${(downloadProgress / downloadTotal) * 100}%, var(--surface) ${(downloadProgress / downloadTotal) * 100}%)`
                                } : {}}
                            >
                                {isDownloading ? (
                                    <>
                                        <Loader2 size={16} className="spin-icon" style={{ marginRight: '6px' }} />
                                        <span style={{ fontSize: '13px', fontWeight: 600 }}>
                                            {downloadTotal > 0 ? `${Math.round((downloadProgress / downloadTotal) * 100)}%` : 'Wait...'}
                                        </span>
                                    </>
                                ) : (
                                    <Download size={18} />
                                )}
                            </button>
                            {downloadError && <span className="iv-download-error" title={downloadError}>⚠️</span>}
                        </div>
                    )}
                </div>

                {/* ── Hint ── */}
                <p className={`iv-hint ${mode !== 'read' ? 'show' : ''}`}>
                    {mode === 'exam'
                        ? 'Paste questions or upload a PDF — answer key optional, AI knows CompTIA answers'
                        : 'Learn mode runs a quiz and open question after reading'}
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
