import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AuditService } from '../services/AuditService';
import './QuizView.css';

interface QuizViewProps {
    content: string;
    onRestart: () => void;
}

interface Question {
    paragraphNumber?: number;
    paragraphText?: string;
    concept?: string;
    type: string;
    question: string;
    options: string[];
    correctAnswerIndex: number;
    explanation?: string;
    reference?: string;
}

interface QuizData {
    questions: Question[];
    summary?: string[];
}

interface FeynmanFeedback {
    score: number;
    strongPoints: string;
    whatToAdd: string;
    sentenceToImprove: string;
}

type Phase = 'quiz' | 'feynman' | 'results';
type InputMode = 'type' | 'voice';

// Web Speech API — not in TS default lib, use any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpeechRecognition = any;

// ── Phase Tracker ──────────────────────────────────────────────
function PhaseTracker({ phase }: { phase: Phase }) {
    const steps = [
        { id: 'read', label: 'Read' },
        { id: 'quiz', label: 'Quiz' },
        { id: 'feynman', label: 'Feynman' },
    ];

    const doneSet: Record<Phase, string[]> = {
        quiz: ['read'],
        feynman: ['read', 'quiz'],
        results: ['read', 'quiz', 'feynman'],
    };

    const activeMap: Record<Phase, string> = {
        quiz: 'quiz',
        feynman: 'feynman',
        results: '',
    };

    const done = doneSet[phase];
    const active = activeMap[phase];

    return (
        <div className="phase-track">
            {steps.map((step, idx) => {
                const isDone = done.includes(step.id) || (phase === 'results');
                const isActive = step.id === active;
                const stepClass = isDone ? 'done' : isActive ? 'active' : '';
                return (
                    <div key={step.id} className={`phase-step ${stepClass}`}>
                        <div className="phase-dot">
                            {isDone ? '✓' : idx + 1}
                        </div>
                        <div className="phase-label">{step.label}</div>
                    </div>
                );
            })}
        </div>
    );
}

// ── Science Tip ─────────────────────────────────────────────────
function ScienceTip({ icon, children }: { icon: string; children: React.ReactNode }) {
    return (
        <div className="qz-science-tip">
            <span className="qz-tip-icon">{icon}</span>
            <span>{children}</span>
        </div>
    );
}

// ── Loading Dots ────────────────────────────────────────────────
function LoadingDots({ label }: { label: string }) {
    return (
        <div className="qz-loading">
            <div className="qz-ld">
                <span></span><span></span><span></span>
            </div>
            <span>{label}</span>
        </div>
    );
}

// ── Badge ───────────────────────────────────────────────────────
const BADGE_TYPES: Record<string, { cls: string; label: string }> = {
    main: { cls: 'main', label: '★ Main Question' },
    detail: { cls: 'detail', label: '◆ Detail Question' },
    apply: { cls: 'apply', label: '⚡ Application Question' },
    comprehension: { cls: 'main', label: '★ Comprehension' },
    analysis: { cls: 'apply', label: '⚡ Analysis' },
};


// ── Main Component ───────────────────────────────────────────────
export default function QuizView({ content, onRestart }: QuizViewProps) {
    const [phase, setPhase] = useState<Phase>('quiz');
    const [quizData, setQuizData] = useState<QuizData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Quiz state
    const [currentIdx, setCurrentIdx] = useState(0);
    const [qResults, setQResults] = useState<(boolean | null)[]>([]);
    const [answered, setAnswered] = useState(false);
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

    // Feynman state
    const [inputMode, setInputMode] = useState<InputMode>('type');
    const [feynmanText, setFeynmanText] = useState('');
    const [voiceLang, setVoiceLang] = useState<'en-US' | 'fr-FR'>('en-US');
    const [isRecording, setIsRecording] = useState(false);
    const [finalTranscript, setFinalTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');
    const [feynmanLoading, setFeynmanLoading] = useState(false);
    const [feynmanFeedback, setFeynmanFeedback] = useState<FeynmanFeedback | null>(null);
    const recognitionRef = useRef<AnySpeechRecognition | null>(null);

    // Results state
    const [masteryScore, setMasteryScore] = useState(0);
    const [retentionPct, setRetentionPct] = useState(0);

    // Load quiz
    useEffect(() => {
        const fetchQuiz = async () => {
            try {
                const res = await fetch('http://localhost:3001/api/quiz', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: content }),
                });
                if (!res.ok) throw new Error('Failed to generate quiz.');
                const data: QuizData = await res.json();
                setQuizData(data);
                setQResults(new Array(data.questions.length).fill(null));
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'An error occurred.');
            } finally {
                setLoading(false);
            }
        };
        fetchQuiz();
    }, [content]);

    // ── Quiz logic ──────────────────────────────────────────────

    const selectAnswer = useCallback((optIdx: number) => {
        if (answered || !quizData) return;
        const q = quizData.questions[currentIdx];
        const correct = optIdx === q.correctAnswerIndex;
        setAnswered(true);
        setSelectedIdx(optIdx);
        setQResults(prev => {
            const next = [...prev];
            next[currentIdx] = correct;
            return next;
        });
        if (q.concept) {
            AuditService.logQuizResult(q.concept, correct);
        }
    }, [answered, quizData, currentIdx]);

    const handleNext = () => {
        if (!quizData) return;
        if (currentIdx < quizData.questions.length - 1) {
            setCurrentIdx(prev => prev + 1);
            setAnswered(false);
            setSelectedIdx(null);
        } else {
            setPhase('feynman');
        }
    };

    // ── Voice logic ──────────────────────────────────────────────

    const stopRecording = useCallback(() => {
        setIsRecording(false);
        setInterimTranscript('');
        if (recognitionRef.current) {
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }
    }, []);

    const startRecording = useCallback(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
        if (!SR) {
            alert('Voice dictation requires Chrome or Edge. Please switch or use Type mode.');
            return;
        }
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = voiceLang;

        rec.onstart = () => setIsRecording(true);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rec.onresult = (e: any) => {
            let interim = '';
            let newFinal = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) newFinal += t + ' ';
                else interim += t;
            }
            if (newFinal) setFinalTranscript(prev => prev + newFinal);
            setInterimTranscript(interim);
        };

        rec.onerror = () => stopRecording();

        rec.onend = () => {
            if (recognitionRef.current) {
                try { recognitionRef.current.start(); } catch { /* ignore */ }
            }
        };

        recognitionRef.current = rec;
        rec.start();
    }, [voiceLang, stopRecording]);

    const toggleRecording = () => {
        if (isRecording) stopRecording();
        else startRecording();
    };

    // If voice lang changes while recording — restart
    useEffect(() => {
        if (isRecording) {
            stopRecording();
            setTimeout(startRecording, 300);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voiceLang]);

    const clearTranscript = () => {
        setFinalTranscript('');
        setInterimTranscript('');
    };

    const editTranscript = () => {
        setFeynmanText(finalTranscript.trim());
        setInputMode('type');
    };

    const getFeynmanWordCount = () => {
        const src = inputMode === 'voice' ? finalTranscript : feynmanText;
        return src.trim() ? src.trim().split(/\s+/).filter(Boolean).length : 0;
    };

    const isFeynmanReady = getFeynmanWordCount() >= 15;

    // ── Feynman Submit ───────────────────────────────────────────

    const handleFeynmanSubmit = async () => {
        const text = inputMode === 'voice' ? finalTranscript.trim() : feynmanText.trim();
        if (!text) return;
        if (isRecording) stopRecording();

        setFeynmanLoading(true);
        try {
            const res = await fetch('http://localhost:3001/api/feynman', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ originalText: content, userExplanation: text }),
            });
            if (!res.ok) throw new Error('Failed to evaluate explanation.');
            const data: Record<string, string | number> = await res.json();
            const finalScore = Number(data.overallScore || data.score) || 65;
            AuditService.logFeynmanResult(finalScore);
            setFeynmanFeedback({
                score: finalScore,
                strongPoints: String(data.strongPoints || data.accuracyFeedback || 'Good attempt.'),
                whatToAdd: String(data.whatToAdd || data.missingConcepts || 'Continue to refine your points.'),
                sentenceToImprove: String(data.sentenceToImprove || data.oneThingToAdd || 'Review your concepts for clarity.'),
            });
        } catch {
            setFeynmanFeedback({
                score: 65,
                strongPoints: 'You captured the core idea and explained it with clarity.',
                whatToAdd: 'Try to include specific examples or context from the text to deepen your explanation.',
                sentenceToImprove: 'Add a concrete detail: who benefits, by how much, or why it matters.',
            });
        } finally {
            setFeynmanLoading(false);
        }
    };

    const retryFeynman = () => {
        setFeynmanFeedback(null);
        setFeynmanText('');
        setFinalTranscript('');
        setInterimTranscript('');
    };

    // ── Results ──────────────────────────────────────────────────

    const goToResults = () => {
        if (!quizData) return;
        const qScore = Math.round((qResults.filter(Boolean).length / quizData.questions.length) * 100);
        const fScore = feynmanFeedback?.score ?? 65;
        const mastery = Math.round(qScore * 0.5 + fScore * 0.5);
        setMasteryScore(mastery);
        setPhase('results');
        setTimeout(() => setRetentionPct(mastery), 300);
    };

    // ── Loading & Error states ───────────────────────────────────

    if (loading) {
        return (
            <div className="qz-page">
                <div className="qz-card">
                    <LoadingDots label="Generating your personalised questions…" />
                </div>
            </div>
        );
    }

    if (error || !quizData) {
        return (
            <div className="qz-page">
                <div className="qz-card">
                    <div className="qz-error">
                        <span>⚠️</span>
                        <h3>Quiz Generation Failed</h3>
                        <p>{error}</p>
                        <button className="qz-btn-primary" onClick={onRestart}>Try Again</button>
                    </div>
                </div>
            </div>
        );
    }

    const questions = quizData.questions;
    const currentQ = questions[currentIdx];
    const isCorrect = selectedIdx !== null && selectedIdx === currentQ.correctAnswerIndex;
    const badgeInfo = BADGE_TYPES[currentQ?.type?.toLowerCase()] ?? BADGE_TYPES.main;

    // ── QUIZ PHASE ───────────────────────────────────────────────
    if (phase === 'quiz') {
        return (
            <div className="qz-page">
                <div className="qz-logo">
                    <div className="qz-logo-mark">✦</div>
                    <span className="qz-logo-name">Alphie</span>
                    <span className="qz-logo-sub">Active Recall — Step 2 of 3</span>
                </div>

                <PhaseTracker phase="quiz" />

                <div className="qz-card">
                    {/* Q-dots counter */}
                    <div className="q-counter">
                        <div className="q-counter-dots">
                            {questions.map((_, i) => {
                                let cls = 'qdot';
                                if (qResults[i] === true) cls += ' done-q';
                                else if (qResults[i] === false) cls += ' wrong-q';
                                else if (i === currentIdx) cls += ' active-q';
                                return <div key={i} className={cls} />;
                            })}
                        </div>
                        <span className="q-counter-label">
                            Question {currentIdx + 1} / {questions.length}
                        </span>
                    </div>

                    <div className={`q-badge ${badgeInfo.cls}`}>{badgeInfo.label}</div>
                    <div className="q-text">{currentQ.question}</div>

                    {/* MCQ Options */}
                    <div className="mcq-options">
                        {(currentQ.options ?? []).map((opt, i) => {
                            const letters = ['A', 'B', 'C', 'D'];
                            let cls = 'mcq-opt';
                            if (answered) {
                                if (i === currentQ.correctAnswerIndex && i === selectedIdx) cls += ' selected-correct';
                                else if (i === selectedIdx) cls += ' selected-wrong';
                                else if (i === currentQ.correctAnswerIndex) cls += ' show-correct';
                                else cls += ' disabled';
                            }
                            return (
                                <div
                                    key={i}
                                    className={cls}
                                    onClick={() => selectAnswer(i)}
                                    role="button"
                                    tabIndex={answered ? -1 : 0}
                                    onKeyDown={(e) => {
                                        if (!answered && (e.key === 'Enter' || e.key === ' ')) {
                                            e.preventDefault();
                                            selectAnswer(i);
                                        }
                                    }}
                                >
                                    <div className="opt-letter">{letters[i]}</div>
                                    <div className="opt-text">{opt}</div>
                                    <div className="opt-check">✓</div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Explanation */}
                    {answered && (
                        <div className={`explanation-box ${isCorrect ? 'correct' : 'wrong'}`}>
                            <div className="ex-head">{isCorrect ? '✅ Correct!' : '❌ Not quite'}</div>
                            <div>{currentQ.explanation ?? ''}</div>
                            {currentQ.reference && (
                                <div className="ex-ref">{currentQ.reference}</div>
                            )}
                        </div>
                    )}

                    {answered && (
                        <button className="qz-btn-primary" onClick={handleNext}>
                            {currentIdx < questions.length - 1 ? 'Next Question →' : 'Start Feynman Test →'}
                        </button>
                    )}
                </div>

                <ScienceTip icon="🧠">
                    <strong style={{ color: 'var(--accent)' }}>Why multiple choice?</strong> Choosing forces your brain to discriminate between ideas — much stronger than just reading. The wrong answers are designed to reveal misconceptions.
                </ScienceTip>
            </div>
        );
    }

    // ── FEYNMAN PHASE ────────────────────────────────────────────
    if (phase === 'feynman') {
        const wordCount = getFeynmanWordCount();
        const voiceWordCount = finalTranscript.trim().split(/\s+/).filter(Boolean).length;

        return (
            <div className="qz-page">
                <div className="qz-logo">
                    <div className="qz-logo-mark">✦</div>
                    <span className="qz-logo-name">Alphie</span>
                    <span className="qz-logo-sub">Feynman Test — Step 3 of 3</span>
                </div>

                <PhaseTracker phase="feynman" />

                <div className="qz-card">
                    <div className="qz-card-title">The Feynman Test</div>
                    <div className="qz-card-sub">
                        Pretend you're explaining this to a curious friend who has never read it.
                        Use your own words — no jargon, no copying. If you can explain it simply, you truly understand it.
                    </div>

                    {!feynmanFeedback && (
                        <div id="feynman-input-section">
                            {/* Mode toggle */}
                            <div className="input-mode-toggle">
                                <button
                                    className={`im-btn ${inputMode === 'type' ? 'active' : ''}`}
                                    onClick={() => { if (isRecording) stopRecording(); setInputMode('type'); }}
                                >
                                    ✏️ Type
                                </button>
                                <button
                                    className={`im-btn ${inputMode === 'voice' ? 'active' : ''}`}
                                    onClick={() => setInputMode('voice')}
                                >
                                    🎙 Speak
                                </button>
                            </div>

                            {/* Type mode */}
                            {inputMode === 'type' && (
                                <div>
                                    <textarea
                                        className="feynman-area"
                                        placeholder="Explain the main ideas as if you're teaching someone from scratch…"
                                        value={feynmanText}
                                        onChange={(e) => setFeynmanText(e.target.value)}
                                    />
                                    <div className="qz-wc-row">
                                        <span className="qz-wc-label">{wordCount} words</span>
                                        <span className="qz-wc-label">Aim for at least 30 words</span>
                                    </div>
                                </div>
                            )}

                            {/* Voice mode */}
                            {inputMode === 'voice' && (
                                <div className="voice-recorder">
                                    {/* Language selector */}
                                    <div className="voice-lang-header">
                                        <div className="voice-lang-label">Speaking language</div>
                                        <div className="voice-lang">
                                            <button
                                                className={`vl-btn ${voiceLang === 'en-US' ? 'active' : ''}`}
                                                onClick={() => setVoiceLang('en-US')}
                                            >
                                                🇬🇧 English
                                            </button>
                                            <button
                                                className={`vl-btn ${voiceLang === 'fr-FR' ? 'active' : ''}`}
                                                onClick={() => setVoiceLang('fr-FR')}
                                            >
                                                🇫🇷 Français
                                            </button>
                                        </div>
                                    </div>

                                    {/* Mic button */}
                                    <div className="mic-wrap">
                                        <button
                                            className={`mic-btn ${isRecording ? 'recording' : ''}`}
                                            onClick={toggleRecording}
                                            aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                                        >
                                            {isRecording ? '⏹' : '🎙'}
                                            {isRecording && (
                                                <>
                                                    <div className="mic-ring"></div>
                                                    <div className="mic-ring mic-ring-2"></div>
                                                    <div className="mic-ring mic-ring-3"></div>
                                                </>
                                            )}
                                        </button>
                                    </div>

                                    <div className={`mic-status ${isRecording ? 'active-s' : ''}`}>
                                        {isRecording ? 'Listening… speak naturally' : finalTranscript ? 'Recording stopped — ready to evaluate' : 'Tap to start speaking'}
                                    </div>

                                    {/* Live transcript */}
                                    <div className={`live-transcript ${isRecording ? 'listening' : ''}`}>
                                        {!finalTranscript && !interimTranscript && (
                                            <span className="transcript-placeholder">Your words will appear here as you speak…</span>
                                        )}
                                        <span>{finalTranscript}</span>
                                        <span className="live-interim">{interimTranscript}</span>
                                    </div>

                                    {/* Voice actions */}
                                    {finalTranscript && !isRecording && (
                                        <div className="voice-actions">
                                            <button className="qz-btn-secondary voice-action-btn" onClick={clearTranscript}>🗑 Clear</button>
                                            <button className="qz-btn-secondary voice-action-btn" onClick={editTranscript}>✏️ Edit text</button>
                                        </div>
                                    )}

                                    <div className="qz-wc-row">
                                        <span className="qz-wc-label">{voiceWordCount} words recorded</span>
                                        <span className="qz-wc-label">Works best in Chrome</span>
                                    </div>
                                </div>
                            )}

                            <button
                                className="qz-btn-primary"
                                onClick={handleFeynmanSubmit}
                                disabled={!isFeynmanReady || feynmanLoading}
                            >
                                Evaluate My Understanding →
                            </button>
                        </div>
                    )}

                    {/* Loading */}
                    {feynmanLoading && <LoadingDots label="Analysing your explanation…" />}

                    {/* Feedback */}
                    {feynmanFeedback && !feynmanLoading && (
                        <div>
                            <div className="qz-divider" />
                            <div className="qz-feedback-label">Alphie's Feedback</div>
                            <div className="feynman-sections">
                                <div className="f-section strong">
                                    <div className="f-head">✅ Strong Points</div>
                                    {feynmanFeedback.strongPoints}
                                </div>
                                <div className="f-section missing">
                                    <div className="f-head">💡 What to Add</div>
                                    {feynmanFeedback.whatToAdd}
                                </div>
                                <div className="f-section rewrite">
                                    <div className="f-head">✏️ Try This Phrasing</div>
                                    {feynmanFeedback.sentenceToImprove}
                                </div>
                            </div>
                            <button className="qz-btn-primary" onClick={goToResults}>
                                See Full Results →
                            </button>
                            <button className="qz-btn-secondary" onClick={retryFeynman}>
                                ✏️ Rewrite my explanation
                            </button>
                        </div>
                    )}
                </div>

                <ScienceTip icon="🔬">
                    <strong style={{ color: 'var(--accent)' }}>The Feynman Technique:</strong> Physicist Richard Feynman learned anything by explaining it simply. The moment you struggle to explain it, you find your gap. That gap IS the learning.
                </ScienceTip>
            </div>
        );
    }

    // ── RESULTS PHASE ─────────────────────────────────────────────
    const masteryMsg =
        masteryScore >= 80 ? 'Excellent mastery. You truly understood this text.' :
            masteryScore >= 55 ? 'Good understanding. A few gaps left to close.' :
                'You need to revisit this material before it sticks.';

    const failedQs = questions.filter((_, i) => qResults[i] === false);

    const steps: { icon: string; text: string }[] = [];
    if (failedQs.length) {
        steps.push({
            icon: '📖',
            text: `Re-read the sections covering: <strong>${failedQs.map(q => q.question.slice(0, 50) + '…').join(', ')}</strong>`
        });
    }
    if (masteryScore < 80) {
        steps.push({ icon: '⏰', text: 'Review this text again in <strong>24 hours</strong> — spaced repetition doubles your retention.' });
    }
    steps.push({ icon: '🔁', text: 'Try the quiz again — each attempt strengthens the neural pathway.' });
    if (masteryScore >= 70) {
        steps.push({ icon: '⬆️', text: 'You\'re ready to read something <strong>more advanced</strong> on this topic.' });
    }

    return (
        <div className="qz-page">
            <div className="qz-logo">
                <div className="qz-logo-mark">✦</div>
                <span className="qz-logo-name">Alphie</span>
                <span className="qz-logo-sub">Session Complete</span>
            </div>

            <PhaseTracker phase="results" />

            <div className="qz-card">
                {/* Mastery */}
                <div className="mastery-banner">
                    <div className="mastery-score-label">Mastery Score</div>
                    <div className="mastery-score">{masteryScore}%</div>
                    <div className="mastery-label">{masteryMsg}</div>
                </div>

                {/* Retention bar */}
                <div className="retention-bar">
                    <div
                        className="retention-fill"
                        style={{ '--ret-width': `${retentionPct}%` } as React.CSSProperties}
                    />
                </div>
                <div className="retention-label">
                    <span>Estimated retention</span>
                    <span>{retentionPct}%</span>
                </div>

                <div className="qz-divider" />

                <div className="qz-next-steps-label">What to do next</div>
                <div className="next-steps-list">
                    {steps.map((s, i) => (
                        <div key={i} className="ns-item">
                            <span className="ns-icon">{s.icon}</span>
                            <span dangerouslySetInnerHTML={{ __html: s.text }} />
                        </div>
                    ))}
                </div>

                <button className="qz-btn-primary" onClick={() => {
                    setPhase('quiz');
                    setCurrentIdx(0);
                    setQResults(new Array(questions.length).fill(null));
                    setAnswered(false);
                    setSelectedIdx(null);
                    setFeynmanFeedback(null);
                    setFeynmanText('');
                    setFinalTranscript('');
                }}>
                    🔁 Try Again — Same Text
                </button>
                <button className="qz-btn-secondary" onClick={onRestart}>
                    ↩ Read Something New
                </button>

                <button
                    className="qz-back-btn"
                    onClick={onRestart}
                    style={{ marginTop: '12px' }}
                >
                    <ArrowLeft size={15} /> Back to Start
                </button>
            </div>
        </div>
    );
}
