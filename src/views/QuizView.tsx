import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, Volume2, Square, Loader2 } from 'lucide-react';
import { AuditService } from '../services/AuditService';
import type { PrefetchedQuiz } from '../App';
import { apiFetch } from '../lib/api';
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
    topic?: string;
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

// ── Performance tracking types ──────────────────────────────────
interface AnsweredQuestion {
    questionId: number;
    questionNumber: number;
    topic: string;
    questionText: string;
    selectedAnswer: string;
    correctAnswer: string;
    isCorrect: boolean;
    explanation: string;
    timestamp: number;
}

interface LiveStats {
    total: number;
    answered: number;
    correct: number;
    incorrect: number;
    scorePct: number;
    remaining: number;
}

interface WeakAreaItem {
    topic: string;
    wrongCount: number;
    reviewText: string;
    wrongQuestions: AnsweredQuestion[];
}

interface RecommendationData {
    strongestTopic: string;
    weakestTopic: string;
    studyNext: string;
}

// ── Adaptive learning types ─────────────────────────────────────
interface WrongEntry {
    qIdx: number;
    topic: string;
    question: string;
}

interface InterventionData {
    topic: string;
    recentMissCount: number;
    reviewConcepts: string[];
    wrongQuestions: WrongEntry[];
}

type Phase = 'quiz' | 'results';

// ── Pure helpers ────────────────────────────────────────────────

function getQuestionTopic(q: Question): string {
    if (q.topic) return q.topic;
    if (q.reference) {
        const m = q.reference.match(/(?:topic|domain|section|area|objective)[:\s]+([^.]+)/i);
        if (m) return m[1].trim().slice(0, 60);
        return q.reference.split(/[-–:|]/)[0].trim().slice(0, 60) || 'General';
    }
    if (q.type && q.type !== 'main' && q.type !== 'detail' && q.type !== 'apply') {
        return q.type.charAt(0).toUpperCase() + q.type.slice(1);
    }
    return 'General';
}

const INTERVENTION_COOLDOWN = 5;

function computeIntervention(
    streak: number,
    recent: WrongEntry[],
    qIdx: number,
    lastAt: number,
): InterventionData | null {
    if (qIdx - lastAt < INTERVENTION_COOLDOWN) return null;

    const topicMap = new Map<string, WrongEntry[]>();
    for (const e of recent) {
        const list = topicMap.get(e.topic) ?? [];
        list.push(e);
        topicMap.set(e.topic, list);
    }

    let bestTopic = '';
    let bestEntries: WrongEntry[] = [];
    for (const [topic, entries] of topicMap) {
        if (entries.length > bestEntries.length) {
            bestTopic = topic;
            bestEntries = entries;
        }
    }

    const streakTrigger = streak >= 5;
    const topicTrigger = bestEntries.length >= 4;
    if (!streakTrigger && !topicTrigger) return null;

    const topic = topicTrigger ? bestTopic : (recent[recent.length - 1]?.topic ?? 'General');
    const topicEntries = topicMap.get(topic) ?? recent.slice(-3);

    return {
        topic,
        recentMissCount: topicEntries.length,
        reviewConcepts: topicEntries
            .map(e => e.question.length > 72 ? e.question.slice(0, 72) + '…' : e.question)
            .slice(0, 3),
        wrongQuestions: topicEntries,
    };
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

// ── Intervention Modal ──────────────────────────────────────────
function InterventionModal({
    data,
    onContinue,
    onReviewAreas,
}: {
    data: InterventionData;
    onContinue: () => void;
    onReviewAreas: () => void;
}) {
    return (
        <div className="intv-overlay" role="dialog" aria-modal="true" aria-label="Weak area detected">
            <div className="intv-modal" onClick={e => e.stopPropagation()}>
                <div className="intv-emoji">🧭</div>
                <div className="intv-title">You may be hitting a weak area</div>
                <div className="intv-topic-chip">{data.topic}</div>
                <div className="intv-miss-count">
                    {data.recentMissCount} miss{data.recentMissCount !== 1 ? 'es' : ''} in this topic recently
                </div>
                <div className="intv-review-box">
                    <div className="intv-review-heading">What to review</div>
                    <ul className="intv-concepts">
                        {data.reviewConcepts.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                </div>
                <div className="intv-actions">
                    <button type="button" className="intv-btn-review" onClick={onReviewAreas}>
                        📊 Review weak areas
                    </button>
                    <button type="button" className="intv-btn-continue" onClick={onContinue}>
                        Continue test
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Live Stats Bar ──────────────────────────────────────────────
function LiveStatsBar({ stats, open, onToggle }: {
    stats: LiveStats;
    open: boolean;
    onToggle: () => void;
}) {
    if (stats.total === 0) return null;
    return (
        <div className="live-stats-bar">
            <div className="lsb-nums">
                <span className="lsb-item">
                    <span className="lsb-label">Q </span>
                    <span className="lsb-val">{stats.answered}<span className="lsb-of">/{stats.total}</span></span>
                </span>
                <span className="lsb-dot">·</span>
                <span className="lsb-item lsb-correct">
                    <span className="lsb-label">✓ </span>
                    <span className="lsb-val">{stats.correct}</span>
                </span>
                <span className="lsb-dot">·</span>
                <span className="lsb-item lsb-wrong">
                    <span className="lsb-label">✗ </span>
                    <span className="lsb-val">{stats.incorrect}</span>
                </span>
                <span className="lsb-dot">·</span>
                <span className="lsb-item lsb-score">
                    <span className="lsb-val">{stats.scorePct}%</span>
                </span>
            </div>
            <button type="button" className={`lsb-toggle ${open ? 'lsb-open' : ''}`} onClick={onToggle}>
                📊 {open ? 'Hide' : 'Report'}
            </button>
        </div>
    );
}

// ── Live Report Panel ───────────────────────────────────────────
function LiveReportPanel({ stats, weakAreas, recommendations, missedQuestions, onPractice }: {
    stats: LiveStats;
    weakAreas: WeakAreaItem[];
    recommendations: RecommendationData;
    missedQuestions: AnsweredQuestion[];
    onPractice: (topic: string) => void;
}) {
    const [showMissed, setShowMissed] = useState(false);

    return (
        <div className="live-report-panel">
            <div className="lrp-section">
                <div className="lrp-heading">Live Summary</div>
                <div className="lrp-stats-grid">
                    <div className="lrp-stat">
                        <span>Total</span>
                        <strong>{stats.total}</strong>
                    </div>
                    <div className="lrp-stat">
                        <span>Answered</span>
                        <strong>{stats.answered}/{stats.total}</strong>
                    </div>
                    <div className="lrp-stat">
                        <span>Remaining</span>
                        <strong>{stats.remaining}</strong>
                    </div>
                    <div className="lrp-stat lrp-correct">
                        <span>Correct</span>
                        <strong>{stats.correct}</strong>
                    </div>
                    <div className="lrp-stat lrp-wrong">
                        <span>Incorrect</span>
                        <strong>{stats.incorrect}</strong>
                    </div>
                    <div className="lrp-stat lrp-score">
                        <span>Score</span>
                        <strong>{stats.scorePct}%</strong>
                    </div>
                </div>
            </div>

            {(recommendations.strongestTopic || recommendations.weakestTopic) && (
                <div className="lrp-section">
                    <div className="lrp-heading">Recommendations</div>
                    {recommendations.strongestTopic && (
                        <div className="lrp-rec-row lrp-rec-strong">
                            <span className="lrp-rec-label">Strongest:</span>
                            <span>{recommendations.strongestTopic}</span>
                        </div>
                    )}
                    {recommendations.weakestTopic && (
                        <div className="lrp-rec-row lrp-rec-weak">
                            <span className="lrp-rec-label">Weakest:</span>
                            <span>{recommendations.weakestTopic}</span>
                        </div>
                    )}
                    {recommendations.studyNext && (
                        <div className="lrp-rec-row">
                            <span className="lrp-rec-label">Study next:</span>
                            <span>{recommendations.studyNext}</span>
                        </div>
                    )}
                </div>
            )}

            {weakAreas.length > 0 && (
                <div className="lrp-section">
                    <div className="lrp-heading">Weak Areas</div>
                    {weakAreas.map((wa, i) => (
                        <div key={i} className="lrp-weak-item">
                            <div className="lrp-weak-header">
                                <span className="lrp-weak-topic">{wa.topic}</span>
                                <span className="lrp-weak-count">{wa.wrongCount} wrong</span>
                            </div>
                            <div className="lrp-weak-review">Review: {wa.reviewText}</div>
                            <button type="button" className="lrp-practice-btn" onClick={() => onPractice(wa.topic)}>
                                🎯 Practice this topic
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {missedQuestions.length > 0 && (
                <div className="lrp-section">
                    <button type="button" className="lrp-missed-toggle" onClick={() => setShowMissed(v => !v)}>
                        📋 Missed Questions ({missedQuestions.length}) {showMissed ? '▲' : '▼'}
                    </button>
                    {showMissed && (
                        <div className="lrp-missed-list">
                            {missedQuestions.map((mq, i) => (
                                <div key={i} className="lrp-missed-item">
                                    <div className="lrp-missed-header">
                                        <span className="lrp-missed-num">Q{mq.questionNumber}</span>
                                        <span className="lrp-missed-topic">{mq.topic}</span>
                                    </div>
                                    <div className="lrp-missed-question">{mq.questionText}</div>
                                    <div className="lrp-missed-correct">✓ {mq.correctAnswer}</div>
                                    {mq.explanation && (
                                        <div className="lrp-missed-expl">{mq.explanation}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Practice Mini-Quiz ──────────────────────────────────────────
function PracticeQuiz({
    topic,
    questions,
    onExit,
}: {
    topic: string;
    questions: Question[];
    onExit: () => void;
}) {
    const [current, setCurrent] = useState(0);
    const [results, setResults] = useState<(boolean | null)[]>(new Array(questions.length).fill(null));
    const [answered, setAnswered] = useState(false);
    const [selected, setSelected] = useState<number[]>([]);
    const [showSummary, setShowSummary] = useState(false);

    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const q = questions[current];
    const correctIndices = q.correctAnswerIndices ?? [q.correctAnswerIndex];
    const required = q.requiredSelections ?? 1;
    const isMulti = required > 1;

    const isCorrect = answered && (
        isMulti
            ? [...selected].sort().join(',') === [...correctIndices].sort().join(',')
            : selected[0] === q.correctAnswerIndex
    );

    const select = (i: number) => {
        if (answered) return;
        if (required === 1) {
            const correct = correctIndices.includes(i);
            setAnswered(true);
            setSelected([i]);
            setResults(prev => { const n = [...prev]; n[current] = correct; return n; });
        } else {
            setSelected(prev => {
                if (prev.includes(i)) return prev.filter(x => x !== i);
                if (prev.length < required) return [...prev, i];
                return prev;
            });
        }
    };

    const submitMulti = () => {
        if (answered) return;
        const correct = [...selected].sort().join(',') === [...correctIndices].sort().join(',');
        setAnswered(true);
        setResults(prev => { const n = [...prev]; n[current] = correct; return n; });
    };

    const next = () => {
        if (current < questions.length - 1) {
            setCurrent(c => c + 1);
            setAnswered(false);
            setSelected([]);
        } else {
            setShowSummary(true);
        }
    };

    if (showSummary) {
        const correct = results.filter(Boolean).length;
        const pct = Math.round((correct / questions.length) * 100);
        return (
            <div className="qz-page">
                <div className="intv-practice-banner">
                    <span>🎯 Practice: {topic}</span>
                    <button type="button" className="intv-exit-btn" onClick={onExit}>Exit Practice</button>
                </div>
                <div className="qz-card">
                    <div className="mastery-banner">
                        <div className="mastery-score-label">Practice Score</div>
                        <div className="mastery-score">{pct}%</div>
                        <div className="mastery-label">
                            {pct === 100
                                ? 'Perfect on this topic — great work!'
                                : pct >= 60
                                    ? 'Good progress. Keep reviewing!'
                                    : 'Keep at it — you\'re building the foundation.'}
                        </div>
                    </div>
                    <button type="button" className="qz-btn-primary" onClick={onExit}>← Back to full exam</button>
                </div>
            </div>
        );
    }

    return (
        <div className="qz-page">
            <div className="intv-practice-banner">
                <span>🎯 Practice: {topic}</span>
                <button type="button" className="intv-exit-btn" onClick={onExit}>Exit Practice</button>
            </div>

            <div className="qz-card">
                <div className="q-counter">
                    <div className="q-counter-dots">
                        {questions.map((_, i) => {
                            let cls = 'qdot';
                            if (results[i] === true) cls += ' done-q';
                            else if (results[i] === false) cls += ' wrong-q';
                            else if (i === current) cls += ' active-q';
                            return <div key={i} className={cls} />;
                        })}
                    </div>
                    <span className="q-counter-label">Practice {current + 1} / {questions.length}</span>
                </div>

                <div className="intv-practice-topic-label">Topic Focus</div>
                <div className="q-text">{q.question}</div>

                {isMulti && (
                    <div className="multi-select-hint">
                        Select {required} answers · {answered ? 'done' : `${selected.length} / ${required} chosen`}
                    </div>
                )}

                <div className="mcq-options">
                    {(q.options ?? []).map((opt, i) => {
                        const isSel = selected.includes(i);
                        const isCorrectOpt = correctIndices.includes(i);
                        let cls = 'mcq-opt';
                        if (answered) {
                            if (isCorrectOpt && isSel) cls += ' selected-correct';
                            else if (isSel && !isCorrectOpt) cls += ' selected-wrong';
                            else if (isCorrectOpt) cls += ' show-correct';
                            else cls += ' disabled';
                        } else if (isMulti && isSel) {
                            cls += ' multi-selected';
                        }
                        return (
                            <div
                                key={i}
                                className={cls}
                                onClick={() => select(i)}
                                role="button"
                                tabIndex={answered ? -1 : 0}
                                onKeyDown={e => {
                                    if (!answered && (e.key === 'Enter' || e.key === ' ')) {
                                        e.preventDefault();
                                        select(i);
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

                {isMulti && !answered && selected.length === required && (
                    <button type="button" className="qz-btn-primary" onClick={submitMulti}>
                        Check Answers →
                    </button>
                )}

                {answered && (
                    <div className={`explanation-box ${isCorrect ? 'correct' : 'wrong'}`}>
                        <div className="ex-head">{isCorrect ? '✅ Correct!' : '❌ Not quite'}</div>
                        <div>{q.explanation ?? ''}</div>
                    </div>
                )}

                {answered && (
                    <button type="button" className="qz-btn-primary" onClick={next}>
                        {current < questions.length - 1 ? 'Next →' : 'See Practice Results →'}
                    </button>
                )}
            </div>
        </div>
    );
}

// ── Quiz data normalizer ────────────────────────────────────────
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

// ── Main Component ───────────────────────────────────────────────
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

    // Results state
    const [masteryScore, setMasteryScore] = useState(0);
    const [retentionPct, setRetentionPct] = useState(0);
    const retentionFillRef = useRef<HTMLDivElement>(null);

    // TTS state
    const [ttsLoading, setTtsLoading] = useState(false);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Performance tracking
    const [answeredQuestions, setAnsweredQuestions] = useState<AnsweredQuestion[]>([]);
    const [showLiveReport, setShowLiveReport] = useState(false);

    // Adaptive learning refs — synchronous access avoids stale closures
    const wrongStreakRef = useRef(0);
    const longestStreakRef = useRef(0);
    const recentWrongRef = useRef<WrongEntry[]>([]);
    const lastInterventionAtRef = useRef(-INTERVENTION_COOLDOWN);

    // Intervention UI state
    const [intervention, setIntervention] = useState<InterventionData | null>(null);
    const [practiceMode, setPracticeMode] = useState<{ topic: string; questions: Question[] } | null>(null);

    // ── Derived performance data ─────────────────────────────────

    const liveStats = useMemo((): LiveStats => {
        const total = quizData?.questions.length ?? 0;
        const correct = answeredQuestions.filter(a => a.isCorrect).length;
        const ans = answeredQuestions.length;
        const incorrect = ans - correct;
        const scorePct = ans > 0 ? Math.round((correct / ans) * 100) : 0;
        return { total, answered: ans, correct, incorrect, scorePct, remaining: total - ans };
    }, [answeredQuestions, quizData]);

    const weakAreas = useMemo((): WeakAreaItem[] => {
        const topicMap = new Map<string, AnsweredQuestion[]>();
        for (const a of answeredQuestions) {
            if (!a.isCorrect) {
                const list = topicMap.get(a.topic) ?? [];
                list.push(a);
                topicMap.set(a.topic, list);
            }
        }
        return [...topicMap.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([topic, qs]) => ({
                topic,
                wrongCount: qs.length,
                reviewText: qs.slice(0, 2).map(q => q.correctAnswer).filter(Boolean).join('; ') || 'Review this topic',
                wrongQuestions: qs,
            }));
    }, [answeredQuestions]);

    const recommendations = useMemo((): RecommendationData => {
        if (answeredQuestions.length < 3) return { strongestTopic: '', weakestTopic: '', studyNext: '' };
        const topicMap = new Map<string, { correct: number; total: number; correctAnswers: string[] }>();
        for (const a of answeredQuestions) {
            const e = topicMap.get(a.topic) ?? { correct: 0, total: 0, correctAnswers: [] };
            e.total++;
            if (a.isCorrect) e.correct++;
            else e.correctAnswers.push(a.correctAnswer);
            topicMap.set(a.topic, e);
        }
        let strongestTopic = '';
        let strongestRate = -1;
        let weakestTopic = '';
        let mostWrong = 0;
        let studyNext = '';
        for (const [topic, v] of topicMap) {
            if (v.total >= 2 && v.correct / v.total > strongestRate) {
                strongestRate = v.correct / v.total;
                strongestTopic = topic;
            }
            if (v.correctAnswers.length > mostWrong) {
                mostWrong = v.correctAnswers.length;
                weakestTopic = topic;
                studyNext = v.correctAnswers.slice(0, 3).join(', ');
            }
        }
        return { strongestTopic, weakestTopic, studyNext };
    }, [answeredQuestions]);

    const missedQuestions = useMemo(
        () => answeredQuestions.filter(a => !a.isCorrect),
        [answeredQuestions],
    );

    // ── Adaptive tracking ────────────────────────────────────────

    const resetAdaptiveTracking = () => {
        wrongStreakRef.current = 0;
        longestStreakRef.current = 0;
        recentWrongRef.current = [];
        lastInterventionAtRef.current = -INTERVENTION_COOLDOWN;
        setIntervention(null);
        setPracticeMode(null);
        setAnsweredQuestions([]);
        setShowLiveReport(false);
    };

    const updateAdaptiveTracking = useCallback((correct: boolean, q: Question, qIdx: number) => {
        if (correct) { wrongStreakRef.current = 0; return; }

        const topic = getQuestionTopic(q);
        const entry: WrongEntry = { qIdx, topic, question: q.question };

        wrongStreakRef.current += 1;
        longestStreakRef.current = Math.max(longestStreakRef.current, wrongStreakRef.current);

        const newRecent = [...recentWrongRef.current, entry].slice(-5);
        recentWrongRef.current = newRecent;

        const data = computeIntervention(wrongStreakRef.current, newRecent, qIdx, lastInterventionAtRef.current);
        if (data) {
            lastInterventionAtRef.current = qIdx;
            setIntervention(data);
        }
    }, []);

    const startPracticeForTopic = useCallback((topic: string) => {
        if (!quizData) return;
        let qs = quizData.questions.filter(q => getQuestionTopic(q) === topic);
        if (qs.length === 0) qs = quizData.questions.slice(0, 5);
        setPracticeMode({ topic, questions: qs });
        setShowLiveReport(false);
        setIntervention(null);
    }, [quizData]);

    // ── TTS ──────────────────────────────────────────────────────

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
            const res = await apiFetch('/api/tts', {
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

    useEffect(() => { stopTts(); }, [currentIdx]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (retentionFillRef.current) {
            retentionFillRef.current.style.width = `${retentionPct}%`;
        }
    }, [retentionPct]);

    // ── Load quiz ────────────────────────────────────────────────

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
                const res = await apiFetch('/api/quiz', {
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

    // ── Quiz logic ───────────────────────────────────────────────

    const recordAnswer = useCallback((q: Question, qIdx: number, correct: boolean, selIndices: number[]) => {
        const topic = getQuestionTopic(q);
        const isMulti = (q.requiredSelections ?? 1) > 1;
        setAnsweredQuestions(prev => {
            if (prev.some(a => a.questionId === qIdx)) return prev;
            return [...prev, {
                questionId: qIdx,
                questionNumber: qIdx + 1,
                topic,
                questionText: q.question,
                selectedAnswer: isMulti
                    ? selIndices.map(i => q.options[i]).join(', ')
                    : (q.options[selIndices[0]] ?? ''),
                correctAnswer: q.correctAnswerIndices.map(i => q.options[i]).join(', '),
                isCorrect: correct,
                explanation: q.explanation ?? '',
                timestamp: Date.now(),
            }];
        });
    }, []);

    const selectAnswer = useCallback((optIdx: number) => {
        if (answered || !quizData) return;
        const q = quizData.questions[currentIdx];
        const required = q.requiredSelections ?? 1;
        if (required === 1) {
            const correct = q.correctAnswerIndices.includes(optIdx);
            setAnswered(true);
            setSelectedIndices([optIdx]);
            setQResults(prev => { const n = [...prev]; n[currentIdx] = correct; return n; });
            AuditService.logQuizResult(q.type ?? 'question', correct);
            updateAdaptiveTracking(correct, q, currentIdx);
            recordAnswer(q, currentIdx, correct, [optIdx]);
        } else {
            setSelectedIndices(prev => {
                if (prev.includes(optIdx)) return prev.filter(i => i !== optIdx);
                if (prev.length < required) return [...prev, optIdx];
                return prev;
            });
        }
    }, [answered, quizData, currentIdx, updateAdaptiveTracking, recordAnswer]);

    const submitMultiSelect = useCallback(() => {
        if (answered || !quizData) return;
        const q = quizData.questions[currentIdx];
        const correct = [...selectedIndices].sort().join(',') === [...q.correctAnswerIndices].sort().join(',');
        setAnswered(true);
        setQResults(prev => { const n = [...prev]; n[currentIdx] = correct; return n; });
        AuditService.logQuizResult(q.type ?? 'question', correct);
        updateAdaptiveTracking(correct, q, currentIdx);
        recordAnswer(q, currentIdx, correct, selectedIndices);
    }, [answered, quizData, currentIdx, selectedIndices, updateAdaptiveTracking, recordAnswer]);

    const handleNext = () => {
        if (!quizData) return;
        if (currentIdx < quizData.questions.length - 1) {
            setCurrentIdx(prev => prev + 1);
            setAnswered(false);
            setSelectedIndices([]);
        } else {
            goToResults();
        }
    };

    const goToResults = () => {
        if (!quizData) return;
        const mastery = Math.round((qResults.filter(Boolean).length / quizData.questions.length) * 100);
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
                        <button type="button" className="qz-btn-primary" onClick={onRestart}>Try Again</button>
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

    // Practice mode takes over any phase
    if (practiceMode) {
        return (
            <PracticeQuiz
                topic={practiceMode.topic}
                questions={practiceMode.questions}
                onExit={() => setPracticeMode(null)}
            />
        );
    }

    // ── QUIZ PHASE ───────────────────────────────────────────────
    if (phase === 'quiz') {
        return (
            <div className="qz-page">
                {intervention && (
                    <InterventionModal
                        data={intervention}
                        onContinue={() => setIntervention(null)}
                        onReviewAreas={() => { setIntervention(null); setShowLiveReport(true); }}
                    />
                )}

                <div className="qz-logo">
                    <div className="qz-logo-mark">✦</div>
                    <span className="qz-logo-name">Alphie</span>
                    <span className="qz-logo-sub">{examMode ? 'Exam Practice' : 'Active Recall'}</span>
                </div>

                <LiveStatsBar
                    stats={liveStats}
                    open={showLiveReport}
                    onToggle={() => setShowLiveReport(v => !v)}
                />

                {showLiveReport && (
                    <LiveReportPanel
                        stats={liveStats}
                        weakAreas={weakAreas}
                        recommendations={recommendations}
                        missedQuestions={missedQuestions}
                        onPractice={startPracticeForTopic}
                    />
                )}

                <div className="qz-card">
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
                        <button
                            type="button"
                            className={`q-tts-btn ${ttsPlaying ? 'playing' : ''}`}
                            onClick={() => playQuestion(currentQ.question)}
                            disabled={ttsLoading}
                            title={ttsPlaying ? 'Stop' : 'Read question aloud'}
                        >
                            {ttsLoading ? <Loader2 size={16} className="q-tts-spin" /> : ttsPlaying ? <Square size={16} /> : <Volume2 size={16} />}
                        </button>
                    </div>

                    {isMultiSelect && (
                        <div className="multi-select-hint">
                            Select {requiredSelections} answers · {answered ? 'done' : `${selectedIndices.length} / ${requiredSelections} chosen`}
                        </div>
                    )}

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

                    {isMultiSelect && !answered && selectedIndices.length === requiredSelections && (
                        <button type="button" className="qz-btn-primary" onClick={submitMultiSelect}>
                            Check Answers →
                        </button>
                    )}

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
                            {currentIdx < questions.length - 1 ? 'Next Question →' : 'See Results →'}
                        </button>
                    )}
                </div>

                <ScienceTip icon="🧠">
                    <strong className="tip-accent">Why multiple choice?</strong> Choosing forces your brain to discriminate between ideas — much stronger than just reading. The wrong answers are designed to reveal misconceptions.
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

    const steps: { icon: string; text: React.ReactNode }[] = [];
    if (missedQuestions.length) {
        steps.push({
            icon: '📖',
            text: <>Re-read the sections covering: <strong>{missedQuestions.slice(0, 3).map(q => q.questionText.slice(0, 45) + '…').join(', ')}</strong></>
        });
    }
    if (masteryScore < 80) {
        steps.push({ icon: '⏰', text: <>Review this text again in <strong>24 hours</strong> — spaced repetition doubles your retention.</> });
    }
    steps.push({ icon: '🔁', text: 'Try the quiz again — each attempt strengthens the neural pathway.' });
    if (masteryScore >= 70) {
        steps.push({ icon: '⬆️', text: <>You're ready to read something <strong>more advanced</strong> on this topic.</> });
    }

    return (
        <div className="qz-page">
            <div className="qz-logo">
                <div className="qz-logo-mark">✦</div>
                <span className="qz-logo-name">Alphie</span>
                <span className="qz-logo-sub">Session Complete</span>
            </div>

            <div className="qz-card">
                <div className="mastery-banner">
                    <div className="mastery-score-label">{examMode ? 'Exam Score' : 'Mastery Score'}</div>
                    <div className="mastery-score">{masteryScore}%</div>
                    <div className="mastery-label">{masteryMsg}</div>
                </div>

                <div className="retention-bar">
                    <div className="retention-fill" ref={retentionFillRef} />
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
                            <span>{s.text}</span>
                        </div>
                    ))}
                </div>
            </div>

            <LiveReportPanel
                stats={liveStats}
                weakAreas={weakAreas}
                recommendations={recommendations}
                missedQuestions={missedQuestions}
                onPractice={startPracticeForTopic}
            />

            <div className="qz-card qz-card--actions">
                <button type="button" className="qz-btn-primary" onClick={() => {
                    setPhase('quiz');
                    setCurrentIdx(0);
                    setQResults(new Array(questions.length).fill(null));
                    setAnswered(false);
                    setSelectedIndices([]);
                    resetAdaptiveTracking();
                }}>
                    🔁 Try Again — Same Text
                </button>
                <button type="button" className="qz-btn-secondary" onClick={onRestart}>
                    ↩ Read Something New
                </button>

                {onArena && (
                    <button type="button" className="qz-btn-arena" onClick={onArena}>
                        🏆 Enter Arena
                    </button>
                )}

                <button
                    type="button"
                    className="qz-back-btn qz-back-btn--results"
                    onClick={onRestart}
                >
                    <ArrowLeft size={15} /> Back to Start
                </button>
            </div>
        </div>
    );
}
