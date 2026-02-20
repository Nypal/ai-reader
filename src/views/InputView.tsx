import { useState, useRef } from 'react';
import { Play, Upload, Activity, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
// Setting up the worker for pdf.js in Vite
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import './InputView.css';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface InputViewProps {
    onStart: (text: string) => void;
}

type TestStatus = 'idle' | 'running' | 'pass' | 'fail';

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
    const fileInputRef = useRef<HTMLInputElement>(null);
    const audioTestRef = useRef<HTMLAudioElement | null>(null);

    const [testState, setTestState] = useState<SystemTestState>(initialTestState);
    const [showTests, setShowTests] = useState(false);

    const handlePlay = () => onStart(text);

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
        <div className="view-container input-view">
            <div className="input-header">
                <h2>What do you want to learn today?</h2>
                <p>Paste text or drop a file to start listening and learning.</p>
            </div>

            <div className="input-area-wrapper">
                <textarea
                    className="main-textarea"
                    placeholder={isExtracting ? "Extracting text... Please wait." : "Paste your text here..."}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={isExtracting}
                />

                <div className="input-actions">
                    <div className="left-actions">
                        <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".txt,.pdf" style={{ display: 'none' }} />
                        <button className="icon-btn" title="Upload File" onClick={() => fileInputRef.current?.click()} disabled={isExtracting}>
                            <Upload size={20} />
                            <span className="hide-mobile">Upload File</span>
                        </button>

                        <button className="icon-btn diagnostics-btn" onClick={runSystemCheck} title="Run System Check">
                            <Activity size={20} />
                            <span className="hide-mobile">System Check</span>
                        </button>
                    </div>

                    <button className="play-btn primary-btn" onClick={handlePlay} disabled={!text.trim() || isExtracting}>
                        <Play size={20} fill="currentColor" />
                        <span>Play & Learn</span>
                    </button>
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
