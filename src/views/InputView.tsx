import { useState, useRef, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, Sun, Moon, Coffee, FileDown, BookOpen } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
// Setting up the worker for pdf.js in Vite
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import './InputView.css';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface InputViewProps {
    onStart: (text: string, mode: 'read' | 'learn', language: 'english' | 'french') => void;
}

type TestStatus = 'idle' | 'running' | 'pass' | 'fail';

const TTS_VOICES = [
    { id: 'onyx', name: 'Onyx', desc: '👨 Deep authoritative male' },
    { id: 'echo', name: 'Echo', desc: '👨 Calm clear male' },
    { id: 'fable', name: 'Fable', desc: '👨 Warm storytelling male' },
    { id: 'nova', name: 'Nova', desc: '👩 Clear friendly female' },
    { id: 'shimmer', name: 'Shimmer', desc: '👩 Soft gentle female' },
    { id: 'alloy', name: 'Alloy', desc: '🧑 Neutral balanced' }
] as const;

type TTSVoice = typeof TTS_VOICES[number]['id'];

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
    logMessage: null
};

export default function InputView({ onStart }: InputViewProps) {
    const [text, setText] = useState('');
    const [isExtracting, setIsExtracting] = useState(false);
    const [readingLanguage, setReadingLanguage] = useState<'english' | 'french'>('english');

    const [mode, setMode] = useState<'read' | 'learn'>(() => {
        return (localStorage.getItem('playlearn_mode') as 'read' | 'learn') || 'learn';
    });

    const fileInputRef = useRef<HTMLInputElement>(null);
    const audioTestRef = useRef<HTMLAudioElement | null>(null);

    const [testState, setTestState] = useState<SystemTestState>(initialTestState);
    const [showTests, setShowTests] = useState(false);

    const [selectedVoice, setSelectedVoice] = useState<TTSVoice>(() => {
        return (localStorage.getItem('playlearn_voice') as TTSVoice) || 'echo';
    });

    const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>(() => {
        const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | 'sepia' | null;
        if (savedTheme) return savedTheme;
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        return prefersDark ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);
    const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    const handlePlay = async () => {
        if (!text.trim()) return;
        onStart(text, mode, readingLanguage);
    };

    const handleModeSelect = (newMode: 'read' | 'learn') => {
        setMode(newMode);
        localStorage.setItem('playlearn_mode', newMode);
    };

    const handleVoiceSelect = (voiceId: TTSVoice) => {
        setSelectedVoice(voiceId);
        localStorage.setItem('playlearn_voice', voiceId);
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handlePreview = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (previewingVoice === selectedVoice) return;

        try {
            setPreviewingVoice(selectedVoice);
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current.removeAttribute("src");
            }

            const textToSpeak = `Hi, I am ${selectedVoice}. This is my voice.`;
            const res = await fetch('http://localhost:3001/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToSpeak, voice: selectedVoice, format: 'mp3' })
            });

            if (!res.ok) throw new Error('Preview failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);

            const audio = new Audio(url);
            previewAudioRef.current = audio;

            audio.onended = () => {
                setPreviewingVoice(null);
                URL.revokeObjectURL(url);
            };
            audio.onerror = () => {
                setPreviewingVoice(null);
                URL.revokeObjectURL(url);
            };

            await audio.play();

        } catch (err) {
            console.error("Preview error", err);
            setPreviewingVoice(null);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const runSystemCheck = async () => {
        setShowTests(true);
        setTestState({ ...initialTestState, backend: { status: 'running' } });

        // 1. Backend Health Check
        try {
            const res = await fetch('http://localhost:3001/api/health');
            if (!res.ok) throw new Error('Bad response');
            const data = await res.json();

            // Update Backend PASS, start OpenAI Check
            setTestState(prev => ({
                ...prev,
                backend: { status: 'pass' },
                openai: { status: 'running' }
            }));

            // 2. OpenAI Key Check
            if (!data.keyLoaded) {
                setTestState(prev => ({
                    ...prev,
                    openai: { status: 'fail', error: 'No API Key found.', fix: 'Add your OpenAI API key to backend/.env and restart server.js' },
                    logMessage: 'GET /api/health returned keyLoaded: false'
                }));
                return;
            }

            setTestState(prev => ({
                ...prev,
                openai: { status: 'pass' },
                tts: { status: 'running' }
            }));

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({
                ...prev,
                backend: { status: 'fail', error: errorMessage, fix: 'Make sure you run `node server.js` in the backend folder.' },
                logMessage: errorMessage
            }));
            return;
        }

        // 3. TTS Generation Check
        let audioBlobUrl = '';
        try {
            const ttsRes = await fetch('http://localhost:3001/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'Test one two', voice: 'alloy' })
            });

            if (!ttsRes.ok) {
                const errorData = await ttsRes.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${ttsRes.status}`);
            }

            const blob = await ttsRes.blob();
            if (blob.size === 0) throw new Error('Received empty audio buffer');

            audioBlobUrl = URL.createObjectURL(blob);

            setTestState(prev => ({
                ...prev,
                tts: { status: 'pass', bytes: blob.size },
                playback: { status: 'running' }
            }));

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({
                ...prev,
                tts: { status: 'fail', error: errorMessage, fix: 'Check your OpenAI account billing or API key validity.' },
                logMessage: `POST /api/tts failed: ${errorMessage}`
            }));
            return;
        }

        // 4. Playback Check
        try {
            if (!audioTestRef.current) audioTestRef.current = new Audio();
            audioTestRef.current.src = audioBlobUrl;

            await audioTestRef.current.play();

            setTestState(prev => ({
                ...prev,
                playback: { status: 'pass' },
                logMessage: 'All systems green! Application is ready.'
            }));
        } catch (err: unknown) {
            const errorName = err instanceof Error ? err.name : 'Error';
            const errorMessage = err instanceof Error ? err.message : String(err);
            setTestState(prev => ({
                ...prev,
                playback: { status: 'fail', error: errorName, fix: 'You must interact with the page first (click anywhere) to allow browser audio AutoPlay.' },
                logMessage: `Browser blocked playback: ${errorName} - ${errorMessage}`
            }));
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
                const pageText = textContent.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' ');
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
            const text = await file.text();
            setText(text);
        } else {
            alert('Please upload a PDF or TXT file.');
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const StatusIcon = ({ status }: { status: TestStatus }) => {
        if (status === 'running') return <Loader2 size={18} className="spin-icon text-blue" />;
        if (status === 'pass') return <CheckCircle2 size={18} className="text-green" />;
        if (status === 'fail') return <XCircle size={18} className="text-red" />;
        return <div className="empty-circle"></div>;
    };

    return (
        <div className="view-container input-view fade-in flex flex-col justify-center">

            <div className="input-box flex flex-col w-full h-full">
                <div className="input-header">
                    <div className="header-title-row">
                        <BookOpen size={24} style={{ color: 'var(--primary)' }} />
                        <h2>NeuralReader</h2>
                    </div>
                    <p>Your AI powered reading companion</p>
                </div>
                <div className="top-control-bar">
                    <div className="mode-segmented-control-wrapper">
                        <div className={`mode-segmented-control mode-${mode}`}>
                            <div className="mode-slider"></div>
                            <button
                                className={`mode-segment ${mode === 'read' ? 'active' : ''}`}
                                onClick={() => handleModeSelect('read')}
                            >
                                <span className="mode-text">Read</span>
                            </button>
                            <button
                                className={`mode-segment ${mode === 'learn' ? 'active' : ''}`}
                                onClick={() => handleModeSelect('learn')}
                            >
                                <span className="mode-text">Learn</span>
                            </button>
                        </div>
                    </div>

                    <div className="theme-triple-pill" role="group" aria-label="Theme Selection">
                        <button
                            className={`theme-pill ${theme === 'light' ? 'active' : ''}`}
                            onClick={() => { setTheme('light'); document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('theme', 'light'); }}
                            aria-label="Light Mode"
                            title="Light Mode"
                        >
                            <Sun size={14} /> Light
                        </button>
                        <button
                            className={`theme-pill ${theme === 'dark' ? 'active' : ''}`}
                            onClick={() => { setTheme('dark'); document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('theme', 'dark'); }}
                            aria-label="Dark Mode"
                            title="Dark Mode"
                        >
                            <Moon size={14} /> Dark
                        </button>
                        <button
                            className={`theme-pill ${theme === 'sepia' ? 'active' : ''}`}
                            onClick={() => { setTheme('sepia'); document.documentElement.setAttribute('data-theme', 'sepia'); localStorage.setItem('theme', 'sepia'); }}
                            aria-label="Sepia Mode"
                            title="Sepia Mode"
                        >
                            <Coffee size={14} /> Sepia
                        </button>
                    </div>
                </div>
                <div className="input-area-wrapper">
                    {!text && !isExtracting && (
                        <div className="empty-state-overlay">
                            <FileDown size={32} opacity={0.4} strokeWidth={1.5} />
                            <p>Paste text or drop file</p>
                        </div>
                    )}
                    <textarea
                        className="main-textarea"
                        placeholder={isExtracting ? "Extracting text... Please wait." : ""}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        disabled={isExtracting}
                    />
                    <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".txt,.pdf" style={{ display: 'none' }} />
                </div>

                <div className="bottom-control-bar">
                    <div className="voice-grid">
                        {TTS_VOICES.map(v => (
                            <button
                                key={v.id}
                                className={`voice-chip ${selectedVoice === v.id ? 'active' : ''}`}
                                onClick={() => handleVoiceSelect(v.id)}
                            >
                                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="waveform-icon">
                                    <path d="M4 12v.01" />
                                    <path d="M8 8v8" />
                                    <path d="M12 4v16" />
                                    <path d="M16 9v6" />
                                    <path d="M20 12v.01" />
                                </svg>
                                <span>{v.name}</span>
                            </button>
                        ))}
                    </div>
                    <div className="action-buttons-right" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.4rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <div className="language-selector" style={{ display: 'flex', backgroundColor: 'var(--surface-hover)', borderRadius: '20px', padding: '4px' }}>
                                <button
                                    className={`lang-btn ${readingLanguage === 'english' ? 'active' : ''}`}
                                    onClick={() => setReadingLanguage('english')}
                                    style={{ padding: '6px 12px', border: 'none', background: readingLanguage === 'english' ? 'var(--bg)' : 'transparent', borderRadius: '16px', fontSize: '0.85rem', fontWeight: readingLanguage === 'english' ? '500' : '400', color: readingLanguage === 'english' ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.2s ease' }}
                                >
                                    English
                                </button>
                                <button
                                    className={`lang-btn ${readingLanguage === 'french' ? 'active' : ''}`}
                                    onClick={() => setReadingLanguage('french')}
                                    style={{ padding: '6px 12px', border: 'none', background: readingLanguage === 'french' ? 'var(--bg)' : 'transparent', borderRadius: '16px', fontSize: '0.85rem', fontWeight: readingLanguage === 'french' ? '500' : '400', color: readingLanguage === 'french' ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.2s ease' }}
                                >
                                    French
                                </button>
                            </div>
                            <button className="play-btn primary-btn" onClick={handlePlay} disabled={!text.trim() || isExtracting}>
                                <span>Start Reading</span>
                            </button>
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', opacity: 0.8 }}>Paste text already written in the selected language.</span>
                    </div>
                </div>
            </div>

            {showTests && (
                <div className="diagnostics-panel">
                    <h3>Diagnostic Pipeline</h3>
                    <ul className="test-list">
                        <li>
                            <div className="test-row">
                                <StatusIcon status={testState.backend.status} />
                                <strong>Backend Connectivity:</strong>
                                <span>{testState.backend.status.toUpperCase()}</span>
                            </div>
                            {testState.backend.fix && <div className="fix-hint">Fix: {testState.backend.fix}</div>}
                        </li>
                        <li>
                            <div className="test-row">
                                <StatusIcon status={testState.openai.status} />
                                <strong>OpenAI Key Loaded:</strong>
                                <span>{testState.openai.status.toUpperCase()}</span>
                            </div>
                            {testState.openai.fix && <div className="fix-hint">Fix: {testState.openai.fix}</div>}
                        </li>
                        <li>
                            <div className="test-row">
                                <StatusIcon status={testState.tts.status} />
                                <strong>TTS API Voice Check:</strong>
                                <span>{testState.tts.status === 'pass' ? `PASS (${testState.tts.bytes} bytes)` : testState.tts.status.toUpperCase()}</span>
                            </div>
                            {testState.tts.fix && <div className="fix-hint">Fix: {testState.tts.fix}</div>}
                        </li>
                        <li>
                            <div className="test-row">
                                <StatusIcon status={testState.playback.status} />
                                <strong>Browser Audio Playback:</strong>
                                <span>{testState.playback.status === 'fail' ? `FAIL (${testState.playback.error})` : testState.playback.status.toUpperCase()}</span>
                            </div>
                            {testState.playback.fix && <div className="fix-hint">Fix: {testState.playback.fix}</div>}
                        </li>
                    </ul>

                    {testState.logMessage && (
                        <div className="log-panel">
                            <strong>Latest Log:</strong> {testState.logMessage}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
