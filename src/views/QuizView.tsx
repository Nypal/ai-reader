import { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, Volume2, Square, Loader2 } from 'lucide-react';
import { AuditService } from '../services/AuditService';
import type { PrefetchedQuiz } from '../App';
import './QuizView.css';

interface QuizViewProps {
    content: string;
    lang?: 'en' | 'fr';
    prefetchedQuiz?: PrefetchedQuiz | null;
    examMode?: boolean;
    onRestart: () => void;
    onArena?: () => void;
}

interface ExamExplanation {
    bestNow: string;
    notLabel: string;
    notReason: string;
}

interface Question {
    type: string;
    question: string;
    options: string[];
    correctAnswerIndex: number;
    correctAnswerIndices: number[];
    requiredSelections: number;
    explanation?: string;
    reference?: string;
    examExplanation?: ExamExplanation;
}

interface QuizData {
    questions: Question[];
    openQuestion?: string;
    summary?: string[];
}

interface AnswerResult {
    understandingScore: number;
    expressionScore: number;
    didWell: string;
    missing: string;
    improved: string;
}

type Phase = 'quiz' | 'open' | 'results';

// ── Phase Tracker ──────────────────────────────────────────────
function PhaseTracker({ phase }: { phase: Phase }) {
    const steps = [
        { id: 'read', label: 'Read' },
        { id: 'quiz', label: 'Quiz' },
        { id: 'open', label: 'Open Question' },
    ];

    const doneSet: Record<Phase, string[]> = {
        quiz: ['read'],
        open: ['read', 'quiz'],
        results: ['read', 'quiz', 'open'],
    };

    const activeMap: Record<Phase, string> = {
        quiz: 'quiz',
        open: 'open',
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
function normalizeQuizData(raw: unknown): QuizData {
    const r = raw as Record<string, unknown>;
    return {
        ...(r as object),
        openQuestion: typeof r.openQuestion === 'string' ? r.openQuestion : undefined,
        questions: ((r.questions as unknown[]) ?? []).map((q) => {
            const qr = q as Record<string, unknown>;
            const primaryIdx = typeof qr.correct === 'number' ? Number(qr.correct) : (Number(qr.correctAnswerIndex) || 0);
            const rawCorrectIndices: number[] = Array.isArray(qr.correctAnswerIndices)
                ? (qr.correctAnswerIndices as number[])
                : [primaryIdx];
            const requiredSelections = typeof qr.requiredSelections === 'number' ? qr.requiredSelections : 1;

            let options = Array.isArray(qr.options) ? (qr.options as string[]) : [];
            let correctAnswerIndices = rawCorrectIndices;
            let correctAnswerIndex = primaryIdx;

            if (options.length > 0) {
                const tagged = options.map((opt, i) => ({ text: opt, isCorrect: rawCorrectIndices.includes(i) }));
                for (let i = tagged.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [tagged[i], tagged[j]] = [tagged[j], tagged[i]];
                }
                options = tagged.map(o => String(o.text));
                correctAnswerIndices = tagged.map((o, i) => o.isCorrect ? i : -1).filter(i => i !== -1);
                if (correctAnswerIndices.length === 0) correctAnswerIndices = [0];
                correctAnswerIndex = correctAnswerIndices[0];
            }

            return {
                ...qr,
                options,
                correctAnswerIndex,
                correctAnswerIndices,
                requiredSelections,
            } as Question;
        }),
    };
}

export default function QuizView({ content, lang = 'en', prefetchedQuiz, examMode = false, onRestart, onArena }: QuizViewProps) {
    const [phase, setPhase] = useState<Phase>('quiz');
    const [quizData, setQuizData] = useState<QuizData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Quiz state
    const [currentIdx, setCurrentIdx] = useState(0);
    const [qResults, setQResults] = useState<(boolean | null)[]>([]);
    const [answered, setAnswered] = useState(false);
    const [selectedIndices, setSelectedIndices] = useState<number[]>([]);

    // Open question state
    const [userAnswer, setUserAnswer] = useState('');
    const [answerLoading, setAnswerLoading] = useState(false);
    const [answerResult, setAnswerResult] = useState<AnswerResult | null>(null);

    // Results state
    const [masteryScore, setMasteryScore] = useState(0);
    const [retentionPct, setRetentionPct] = useState(0);

    // TTS state (exam mode)
    const [ttsLoading, setTtsLoading] = useState(false);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const stopTts = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
            audioRef.current = null;
        }
        setTtsPlaying(false);
        setTtsLoading(false);
    }, []);

    const playQuestion = useCallback(async (questionText: string) => {
        if (ttsLoading) return;
        if (ttsPlaying) { stopTts(); return; }

        const voice = localStorage.getItem('playlearn_voice') || 'echo';
        setTtsLoading(true);
        try {
            const res = await fetch(`${import.meta.env.VITE_API_URL}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: questionText, voice, lang: 'en' }),
            });
            if (!res.ok) throw new Error('TTS failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => { URL.revokeObjectURL(url); setTtsPlaying(false); };
            audio.onerror = () => { URL.revokeObjectURL(url); setTtsPlaying(false); setTtsLoading(false); };
            await audio.play();
            setTtsPlaying(true);
        } catch {
            setTtsPlaying(false);
        } finally {
            setTtsLoading(false);
        }
    }, [ttsLoading, ttsPlaying, stopTts]);

    // Stop audio when moving to a new question
    useEffect(() => { stopTts(); }, [currentIdx]); // eslint-disable-line react-hooks/exhaustive-deps

    // Load quiz — use prefetched result when available, otherwise fetch now.
    useEffect(() => {
        if (prefetchedQuiz?.loading) return;

        if (prefetchedQuiz?.data) {
            const data = normalizeQuizData(prefetchedQuiz.data);
            setQuizData(data);
            setQResults(new Array(data.questions.length).fill(null));
            setLoading(false);
            return;
        }

        if (prefetchedQuiz?.error) {
            setError(prefetchedQuiz.error);
            setLoading(false);
            return;
        }

        const fetchQuiz = async () => {
            try {
                const res = await fetch(`${import.meta.env.VITE_API_URL}/api/quiz`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: content, lang }),
                });
                if (!res.ok) throw new Error('Failed to generate quiz.');
                const data = normalizeQuizData(await res.json());
                setQuizData(data);
                setQResults(new Array(data.questions.length).fill(null));
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'An error occurred.');
            } finally {
                setLoading(false);
            }
        };
        fetchQuiz();
    }, [content, lang, prefetchedQuiz]);

    // ── Quiz logic ──────────────────────────────────────────────

    const selectAnswer = useCallback((optIdx: number) => {
        if (answered || !quizData) return;
        const q = quizData.questions[currentIdx];
        const required = q.requiredSelections ?? 1;

        if (required === 1) {
            // Single-select: immediate reveal
            const correct = q.correctAnswerIndices.includes(optIdx);
            setAnswered(true);
            setSelectedIndices([optIdx]);
            setQResults(prev => { const n = [...prev]; n[currentIdx] = correct; return n; });
            AuditService.logQuizResult(q.type ?? 'question', correct);
        } else {
            // Multi-select: toggle selection; submit only via "Check Answers" button
            setSelectedIndices(prev => {
                if (prev.includes(optIdx)) return prev.filter(i => i !== optIdx);
                if (prev.length < required) return [...prev, optIdx];
                return prev; // already at limit
            });
        }
    }, [answered, quizData, currentIdx]);

    const submitMultiSelect = useCallback(() => {
        if (answered || !quizData) return;
        const q = quizData.questions[currentIdx];
        const correct = [...selectedIndices].sort().join(',') === [...q.correctAnswerIndices].sort().join(',');
        setAnswered(true);
        setQResults(prev => { const n = [...prev]; n[currentIdx] = correct; return n; });
        AuditService.logQuizResult(q.type ?? 'question', correct);
    }, [answered, quizData, currentIdx, selectedIndices]);

    const handleNext = () => {
        if (!quizData) return;
        if (currentIdx < quizData.questions.length - 1) {
            setCurrentIdx(prev => prev + 1);
            setAnswered(false);
            setSelectedIndices([]);
        } else if (examMode) {
            goToResults();
        } else {
            setPhase('open');
        }
    };

    // ── Open Question Submit ─────────────────────────────────────

    const handleAnswerSubmit = async () => {
        if (!userAnswer.trim() || !quizData?.openQuestion) return;
        setAnswerLoading(true);
        try {
            const res = await fetch(`${import.meta.env.VITE_API_URL}/api/evaluate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: quizData.openQuestion,
                    answer: userAnswer.trim(),
                    originalText: content,
                }),
            });
            if (!res.ok) throw new Error('Failed to evaluate answer.');
            const data = await res.json();
            setAnswerResult({
                understandingScore: Number(data.understandingScore ?? 5),
                expressionScore: Number(data.expressionScore ?? 5),
                didWell: String(data.didWell ?? ''),
                missing: String(data.missing ?? ''),
                improved: String(data.improved ?? ''),
            });
        } catch {
            setAnswerResult({
                understandingScore: 0,
                expressionScore: 0,
                didWell: '',
                missing: '',
                improved: 'Unable to evaluate — please check your connection.',
            });
        } finally {
            setAnswerLoading(false);
        }
    };

    // ── Results ──────────────────────────────────────────────────

    const goToResults = () => {
        if (!quizData) return;
        const qScore = Math.round((qResults.filter(Boolean).length / quizData.questions.length) * 100);
        const mastery = examMode
            ? qScore
            : Math.min(100, Math.round(qScore * 0.8 + (answerResult ? Math.round((answerResult.understandingScore / 10) * 20) : 0)));
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
    const requiredSelections = currentQ.requiredSelections ?? 1;
    const isMultiSelect = requiredSelections > 1;
    const correctAnswerIndices = currentQ.correctAnswerIndices ?? [currentQ.correctAnswerIndex];
    const isCorrect = answered && (
        isMultiSelect
            ? [...selectedIndices].sort().join(',') === [...correctAnswerIndices].sort().join(',')
            : selectedIndices[0] === currentQ.correctAnswerIndex
    );
    const badgeInfo = BADGE_TYPES[currentQ?.type?.toLowerCase()] ?? BADGE_TYPES.main;
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

    // ── QUIZ PHASE ───────────────────────────────────────────────
    if (phase === 'quiz') {
        return (
            <div className="qz-page">
                <div className="qz-logo">
                    <div className="qz-logo-mark">✦</div>
                    <span className="qz-logo-name">Alphie</span>
                    <span className="qz-logo-sub">{examMode ? 'Exam Practice' : 'Active Recall — Step 2 of 3'}</span>
                </div>

                {!examMode && <PhaseTracker phase="quiz" />}

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
                    <div className="q-text-row">
                        <div className="q-text">{currentQ.question}</div>
                        {examMode && (
                            <button
                                type="button"
                                className={`q-tts-btn ${ttsPlaying ? 'playing' : ''}`}
                                onClick={() => playQuestion(currentQ.question)}
                                disabled={ttsLoading}
                                title={ttsPlaying ? 'Stop' : 'Read question aloud'}
                            >
                                {ttsLoading ? <Loader2 size={16} className="q-tts-spin" /> : ttsPlaying ? <Square size={16} /> : <Volume2 size={16} />}
                            </button>
                        )}
                    </div>

                    {/* Multi-select hint */}
                    {isMultiSelect && (
                        <div className="multi-select-hint">
                            Select {requiredSelections} answers · {answered ? 'done' : `${selectedIndices.length} / ${requiredSelections} chosen`}
                        </div>
                    )}

                    {/* MCQ Options */}
                    <div className="mcq-options">
                        {(currentQ.options ?? []).map((opt, i) => {
                            const isSelected = selectedIndices.includes(i);
                            const isCorrectOpt = correctAnswerIndices.includes(i);
                            let cls = 'mcq-opt';
                            if (answered) {
                                if (isCorrectOpt && isSelected) cls += ' selected-correct';
                                else if (isSelected && !isCorrectOpt) cls += ' selected-wrong';
                                else if (isCorrectOpt) cls += ' show-correct';
                                else cls += ' disabled';
                            } else if (isMultiSelect && isSelected) {
                                cls += ' multi-selected';
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
                                    <div className="opt-letter">{letters[i] ?? String(i + 1)}</div>
                                    <div className="opt-text">{opt}</div>
                                    <div className="opt-check">✓</div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Check Answers button for multi-select (before answered) */}
                    {isMultiSelect && !answered && selectedIndices.length === requiredSelections && (
                        <button type="button" className="qz-btn-primary" onClick={submitMultiSelect}>
                            Check Answers →
                        </button>
                    )}

                    {/* Explanation */}
                    {answered && examMode && isCorrect && !isMultiSelect && currentQ.examExplanation?.bestNow ? (
                        <div className="explanation-box correct exam-explain-box">
                            <div className="ex-head">Correct!</div>
                            <div className="exam-explain-line">
                                <span className="exam-explain-label">Why:</span>
                                <span className="exam-explain-text">{currentQ.examExplanation.bestNow}</span>
                            </div>
                            <div className="exam-explain-line">
                                <span className="exam-explain-label">Why not {currentQ.examExplanation.notLabel}:</span>
                                <span className="exam-explain-text">{currentQ.examExplanation.notReason}</span>
                            </div>
                        </div>
                    ) : answered ? (
                        <div className={`explanation-box ${isCorrect ? 'correct' : 'wrong'}`}>
                            <div className="ex-head">{isCorrect ? '✅ Correct!' : '❌ Not quite'}</div>
                            <div>{currentQ.explanation ?? ''}</div>
                            {currentQ.reference && (
                                <div className="ex-ref">{currentQ.reference}</div>
                            )}
                        </div>
                    ) : null}

                    {answered && (
                        <button type="button" className="qz-btn-primary" onClick={handleNext}>
                            {currentIdx < questions.length - 1 ? 'Next Question →' : (examMode ? 'See Results →' : 'Open Question →')}
                        </button>
                    )}
                </div>

                <ScienceTip icon="🧠">
                    <strong className="tip-accent">Why multiple choice?</strong> Choosing forces your brain to discriminate between ideas — much stronger than just reading. The wrong answers are designed to reveal misconceptions.
                </ScienceTip>
            </div>
        );
    }

    // ── OPEN QUESTION PHASE ──────────────────────────────────────
    if (phase === 'open') {
        const openQuestion = quizData.openQuestion ?? 'In your own words, what is the main idea of this text?';

        return (
            <div className="qz-page">
                <div className="qz-logo">
                    <div className="qz-logo-mark">✦</div>
                    <span className="qz-logo-name">Alphie</span>
                    <span className="qz-logo-sub">Open Question — Step 3 of 3</span>
                </div>

                <PhaseTracker phase="open" />

                <div className="qz-card">
                    <div className="qz-card-title">Open Question</div>
                    <div className="q-text" style={{ marginTop: '12px' }}>{openQuestion}</div>

                    {!answerResult && (
                        <>
                            <textarea
                                className="feynman-area"
                                placeholder="Type your answer here…"
                                value={userAnswer}
                                onChange={(e) => setUserAnswer(e.target.value)}
                                disabled={answerLoading}
                            />
                            <button
                                className="qz-btn-primary"
                                onClick={handleAnswerSubmit}
                                disabled={!userAnswer.trim() || answerLoading}
                            >
                                {answerLoading ? 'Evaluating…' : 'Submit Answer →'}
                            </button>
                        </>
                    )}

                    {answerLoading && <LoadingDots label="Checking your answer…" />}

                    {answerResult && !answerLoading && (
                        <div>
                            <div className="qz-divider" style={{ margin: '20px 0 16px' }} />

                            {/* Scores */}
                            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                                <div className="explanation-box correct" style={{ flex: 1, textAlign: 'center', padding: '12px 8px' }}>
                                    <div style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1 }}>{answerResult.understandingScore}<span style={{ fontSize: '13px', fontWeight: 400 }}>/10</span></div>
                                    <div style={{ fontSize: '11px', marginTop: '4px', opacity: 0.8 }}>Understanding</div>
                                </div>
                                <div className="explanation-box correct" style={{ flex: 1, textAlign: 'center', padding: '12px 8px' }}>
                                    <div style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1 }}>{answerResult.expressionScore}<span style={{ fontSize: '13px', fontWeight: 400 }}>/10</span></div>
                                    <div style={{ fontSize: '11px', marginTop: '4px', opacity: 0.8 }}>Expression</div>
                                </div>
                            </div>

                            {/* Feedback bullets */}
                            <div className="feynman-sections">
                                {answerResult.didWell && (
                                    <div className="f-section strong">
                                        <div className="f-head">👍 What you did well</div>
                                        {answerResult.didWell}
                                    </div>
                                )}
                                {answerResult.missing && (
                                    <div className="f-section missing">
                                        <div className="f-head">⚠️ What to improve</div>
                                        {answerResult.missing}
                                    </div>
                                )}
                                {answerResult.improved && (
                                    <div className="f-section rewrite">
                                        <div className="f-head">✨ Improved version</div>
                                        {answerResult.improved}
                                    </div>
                                )}
                            </div>

                            <button className="qz-btn-primary" onClick={goToResults}>
                                See Results →
                            </button>
                            <button className="qz-btn-secondary" onClick={() => {
                                setAnswerResult(null);
                                setUserAnswer('');
                            }}>
                                ✏️ Rewrite &amp; try again
                            </button>
                        </div>
                    )}
                </div>

                <ScienceTip icon="✍️">
                    <strong style={{ color: 'var(--accent)' }}>Why open questions?</strong> Writing your answer in your own words forces active retrieval — stronger than recognition alone.
                </ScienceTip>
            </div>
        );
    }

    // ── RESULTS PHASE ─────────────────────────────────────────────
    const masteryMsg = examMode
        ? (masteryScore >= 80 ? 'Excellent! You\'re well prepared for this exam.' :
            masteryScore >= 55 ? 'Good score. Review the questions you missed before the exam.' :
                'Keep studying — go over the missed questions and try again.')
        : (masteryScore >= 80 ? 'Excellent mastery. You truly understood this text.' :
            masteryScore >= 55 ? 'Good understanding. A few gaps left to close.' :
                'You need to revisit this material before it sticks.');

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

            {!examMode && <PhaseTracker phase="results" />}

            <div className="qz-card">
                {/* Mastery */}
                <div className="mastery-banner">
                    <div className="mastery-score-label">{examMode ? 'Exam Score' : 'Mastery Score'}</div>
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
                    setSelectedIndices([]);
                    setAnswerResult(null);
                    setUserAnswer('');
                }}>
                    🔁 Try Again — Same Text
                </button>
                <button className="qz-btn-secondary" onClick={onRestart}>
                    ↩ Read Something New
                </button>

                {onArena && (
                    <button className="qz-btn-arena" onClick={onArena}>
                        🏆 Enter Arena
                    </button>
                )}

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
