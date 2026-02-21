import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, RotateCcw, ArrowRight, ArrowLeft, Loader, Brain, AlertCircle, MessageSquare } from 'lucide-react';
import './QuizView.css';

interface QuizViewProps {
    content: string;
    onRestart: () => void;
}

interface Question {
    paragraphNumber: number;
    paragraphText: string;
    type: string;
    question: string;
    options: string[];
    correctAnswerIndex: number;
    explanation: string;
}

interface QuizData {
    questions: Question[];
    summary: string[];
}

interface FeynmanFeedback {
    score: number;
    strongPoints: string;
    whatToAdd: string;
    sentenceToImprove: string;
}

export default function QuizView({ content, onRestart }: QuizViewProps) {
    const [quizData, setQuizData] = useState<QuizData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [currentIdx, setCurrentIdx] = useState(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [score, setScore] = useState(0);
    const [incorrectQuestions, setIncorrectQuestions] = useState<Question[]>([]);
    const [isComplete, setIsComplete] = useState(false);
    const [isOptionsRevealed, setIsOptionsRevealed] = useState(false);

    // Feynman test state
    const [feynmanStep, setFeynmanStep] = useState<'prepare' | 'write' | 'feedback'>('prepare');
    const [feynmanText, setFeynmanText] = useState('');
    const [feynmanFeedback, setFeynmanFeedback] = useState<FeynmanFeedback | null>(null);
    const [isFeynmanLoading, setIsFeynmanLoading] = useState(false);
    const [feynmanError, setFeynmanError] = useState('');

    useEffect(() => {
        const fetchQuiz = async () => {
            try {
                const res = await fetch('http://localhost:3001/api/quiz', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: content })
                });

                if (!res.ok) {
                    throw new Error('Failed to generate quiz.');
                }

                const data: QuizData = await res.json();
                setQuizData(data);
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : 'An error occurred.');
            } finally {
                setLoading(false);
            }
        };

        fetchQuiz();
    }, [content]);

    const handleSelect = (idx: number) => {
        if (selectedOption !== null || !quizData) return;

        setSelectedOption(idx);

        const isCorrect = idx === quizData.questions[currentIdx].correctAnswerIndex;
        if (isCorrect) {
            setScore(s => s + 1);
        } else {
            setIncorrectQuestions(prev => [...prev, quizData.questions[currentIdx]]);
        }
    };

    const handleNext = () => {
        if (!quizData) return;

        if (currentIdx < quizData.questions.length - 1) {
            setCurrentIdx(prev => prev + 1);
            setSelectedOption(null);
            setIsOptionsRevealed(false);
        } else {
            setIsComplete(true);
        }
    };

    const handleFeynmanSubmit = async () => {
        if (!feynmanText.trim()) return;
        setFeynmanError('');

        const currentWordCount = feynmanText.trim().split(/\s+/).filter(w => w.length > 0).length;
        if (currentWordCount < 50) {
            setFeynmanError("Please write at least 50 words before evaluating.");
            return;
        }

        // Plagiarism Detection
        if (quizData && quizData.summary) {
            const isPlagiarized = quizData.summary.some(summaryPoint => {
                const cleanPoint = summaryPoint.replace(/[^\w\s]/gi, '').trim().toLowerCase();
                const cleanInput = feynmanText.replace(/[^\w\s]/gi, '').toLowerCase();
                return cleanPoint.length > 10 && cleanInput.includes(cleanPoint);
            });

            if (isPlagiarized) {
                setFeynmanError("Try explaining this in your own words, not the words from the summary. Pretend you are explaining it to a friend who has never read this.");
                return;
            }
        }

        setIsFeynmanLoading(true);
        try {
            const res = await fetch('http://localhost:3001/api/feynman', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ originalText: content, userExplanation: feynmanText })
            });
            if (!res.ok) throw new Error('Failed to evaluate explanation.');
            const data: Record<string, string | number> = await res.json();

            // Fallback mapping in case of stale backend JSON structure
            setFeynmanFeedback({
                score: Number(data.score) || 0,
                strongPoints: String(data.strongPoints || data.accuracyFeedback || "Good attempt."),
                whatToAdd: String(data.whatToAdd || data.missingConcepts || "Continue to refine your points."),
                sentenceToImprove: String(data.sentenceToImprove || data.oneThingToAdd || "Review your concepts for clarity.")
            });
            setFeynmanStep('feedback');
        } catch (err) {
            console.error('Feynman evaluation failed:', err);
            setFeynmanError('Evaluation failed. Please check backend connection.');
        } finally {
            setIsFeynmanLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="view-container quiz-view center-content">
                <Loader className="spinner" size={48} />
                <h2>Analyzing Text via AI...</h2>
                <p>Generating personalized learning questions based on your reading.</p>
            </div>
        );
    }

    if (error || !quizData) {
        return (
            <div className="view-container quiz-view center-content">
                <XCircle size={48} color="var(--error)" />
                <h2>Quiz Generation Failed</h2>
                <p>{error}</p>
                <button className="primary-btn" onClick={onRestart}>Try Again</button>
            </div>
        );
    }

    const wordCount = feynmanText.trim().split(/\s+/).filter(w => w.length > 0).length;
    let wordCountMessage = "";
    if (wordCount === 0) wordCountMessage = "0 words";
    else if (wordCount < 100) wordCountMessage = `${wordCount} words - Keep going...`;
    else if (wordCount <= 200) wordCountMessage = `${wordCount} words - Good depth`;
    else wordCountMessage = `${wordCount} words - Excellent`;

    if (isComplete) {
        const percentage = Math.round((score / quizData.questions.length) * 100);
        let encouragement = "Great job!";
        if (percentage === 100) encouragement = "Perfect! You deeply understand the material!";
        else if (percentage >= 80) encouragement = "Excellent comprehension!";
        else if (percentage >= 60) encouragement = "Good effort, you grasped the main concepts.";
        else encouragement = "Keep practicing to improve your understanding.";

        return (
            <div className="view-container quiz-view">
                <div className="quiz-header">
                    <button className="back-btn" onClick={onRestart}>
                        <ArrowLeft size={20} />
                        <span>Back to Start</span>
                    </button>
                </div>
                <div className="results-dashboard glass-panel fade-in">
                    <div className="score-hero">
                        <div className="score-circle">
                            <span>{percentage}%</span>
                        </div>
                        <h2>{encouragement}</h2>
                        <p>You answered {score} out of {quizData.questions.length} questions correctly.</p>
                    </div>

                    <div className="dashboard-grid">
                        <div className="summary-section">
                            <h3><Brain size={20} /> What You Learned Today</h3>
                            <ul className="learning-summary">
                                {quizData.summary.map((point, i) => (
                                    <li key={i}><CheckCircle2 size={16} className="success-icon" /> <span>{point}</span></li>
                                ))}
                            </ul>
                        </div>

                        {incorrectQuestions.length > 0 && (
                            <div className="review-section">
                                <h3><AlertCircle size={20} /> Concepts to Review Tomorrow</h3>
                                <ul className="review-list">
                                    {incorrectQuestions.map((q, i) => (
                                        <li key={i} className="review-item">
                                            <div className="review-context">From Paragraph {q.paragraphNumber}:</div>
                                            <div className="review-explanation">{q.explanation}</div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    <div className="feynman-section glass-panel">
                        <div className="feynman-header">
                            <MessageSquare size={24} />
                            <h3>The Feynman Test</h3>
                        </div>

                        {feynmanStep === 'prepare' && (
                            <div className="feynman-prepare fade-in">
                                <p className="feynman-desc">Before you write, remember these key ideas:</p>
                                <div className="feynman-key-concepts">
                                    {quizData.summary.map((point, i) => (
                                        <div key={i} className="feynman-concept-card">{point}</div>
                                    ))}
                                </div>
                                <button className="primary-btn" onClick={() => setFeynmanStep('write')}>Start Writing</button>
                            </div>
                        )}

                        {feynmanStep === 'write' && (
                            <div className="feynman-write fade-in">
                                <p className="feynman-desc">Explain the core ideas of the text in your own words below.</p>

                                {feynmanError && (
                                    <div className="feynman-plagiarism-warning fade-in">
                                        <AlertCircle size={18} />
                                        <span>{feynmanError}</span>
                                    </div>
                                )}

                                <div className="feynman-input-wrapper">
                                    <textarea
                                        className="feynman-textarea"
                                        placeholder="What is the main idea?&#10;Why does it matter?&#10;Give one real life example."
                                        value={feynmanText}
                                        onChange={(e) => setFeynmanText(e.target.value)}
                                        disabled={isFeynmanLoading}
                                    />
                                    <div className="feynman-word-count">
                                        {wordCountMessage}
                                    </div>
                                </div>
                                <button
                                    className="primary-btn feynman-submit"
                                    onClick={handleFeynmanSubmit}
                                    disabled={wordCount === 0 || isFeynmanLoading}
                                >
                                    {isFeynmanLoading ? <Loader className="spinner" size={20} /> : 'Evaluate My Understanding'}
                                </button>
                            </div>
                        )}

                        {feynmanStep === 'feedback' && feynmanFeedback && (
                            <div className="feynman-feedback-container fade-in">
                                {feynmanError && (
                                    <div className="feynman-plagiarism-warning feynman-warning-margin fade-in">
                                        <AlertCircle size={18} />
                                        <span>{feynmanError}</span>
                                    </div>
                                )}
                                <div className="feynman-feedback-split">
                                    <div className="feynman-write-side">
                                        <div className="feynman-input-wrapper">
                                            <textarea
                                                className="feynman-textarea feynman-textarea-sm"
                                                value={feynmanText}
                                                onChange={(e) => setFeynmanText(e.target.value)}
                                                placeholder="Rewrite your explanation..."
                                            />
                                            <div className="feynman-word-count">
                                                {wordCountMessage}
                                            </div>
                                        </div>
                                        <div className="feynman-action-buttons">
                                            <button
                                                className="secondary-btn feynman-retry"
                                                onClick={() => {
                                                    setFeynmanText('');
                                                    setFeynmanFeedback(null);
                                                    setFeynmanStep('write');
                                                }}
                                            >
                                                <RotateCcw size={16} /> Try Again
                                            </button>
                                            <button
                                                className="primary-btn feynman-submit"
                                                onClick={handleFeynmanSubmit}
                                                disabled={wordCount === 0 || isFeynmanLoading}
                                            >
                                                {isFeynmanLoading ? <Loader className="spinner" size={20} /> : 'Re-Evaluate'}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="feynman-evaluation">
                                        <div className="feynman-feedback-text">
                                            <div className="feedback-block accuracy-block">
                                                <h4><CheckCircle2 size={16} /> Strong points</h4>
                                                <p>{feynmanFeedback.strongPoints}</p>
                                            </div>
                                            <div className="feedback-block missing-block">
                                                <h4><AlertCircle size={16} /> Here is what to add next time</h4>
                                                <p>{feynmanFeedback.whatToAdd}</p>
                                            </div>
                                            <div className="feedback-block improve-block">
                                                <h4><MessageSquare size={16} /> Try rewriting this sentence</h4>
                                                <p>{feynmanFeedback.sentenceToImprove}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <button className="secondary-btn restart-btn" onClick={onRestart}>
                        <RotateCcw size={20} />
                        <span>Read Another Document</span>
                    </button>
                </div>
            </div>
        );
    }

    const currentQ = quizData.questions[currentIdx];
    const hasAnswered = selectedOption !== null;

    return (
        <div className="view-container quiz-view fullscreen-quiz">
            <div className="quiz-header">
                <button className="back-btn" onClick={onRestart}>
                    <ArrowLeft size={20} />
                    <span>Back to Start</span>
                </button>
            </div>
            <div className="quiz-progress-bar">
                <div
                    className="quiz-progress-fill"
                    style={{ width: `${((currentIdx) / quizData.questions.length) * 100}%` }}
                ></div>
            </div>

            <div className="quiz-main fade-in" key={currentIdx}>
                <div className="context-panel glass-panel">
                    <div className="context-label">Context (Paragraph {currentQ.paragraphNumber})</div>
                    <p className="context-text">"{currentQ.paragraphText}"</p>
                </div>

                <div className="question-area">
                    <span className="question-type-badge">{currentQ.type} Question</span>
                    <h2 className="main-question">{currentQ.question}</h2>

                    {!isOptionsRevealed ? (
                        <div className="active-recall-overlay glass-panel fade-in">
                            <Brain size={48} className="recall-icon" />
                            <h3>Active Recall Challenge</h3>
                            <p>What do you remember about this? Force your brain to retrieve the concept before seeing the answers.</p>
                            <button className="primary-btn reveal-btn" onClick={() => setIsOptionsRevealed(true)}>
                                Reveal Options
                            </button>
                        </div>
                    ) : (
                        <div className="options-grid fade-in">
                            {currentQ.options.map((opt, optIdx) => {
                                const isSelected = selectedOption === optIdx;
                                const isCorrectAnswer = currentQ.correctAnswerIndex === optIdx;

                                let optionClass = "quiz-option-btn glass-panel ";
                                if (hasAnswered) {
                                    if (isCorrectAnswer) optionClass += "correct-answer ";
                                    else if (isSelected) optionClass += "wrong-answer ";
                                    else optionClass += "dimmed ";
                                }

                                return (
                                    <button
                                        key={optIdx}
                                        className={optionClass}
                                        onClick={() => handleSelect(optIdx)}
                                        disabled={hasAnswered}
                                    >
                                        <div className="option-marker">{String.fromCharCode(65 + optIdx)}</div>
                                        <div className="option-text">{opt}</div>
                                        {hasAnswered && isCorrectAnswer && <CheckCircle2 className="feedback-icon" size={20} />}
                                        {hasAnswered && isSelected && !isCorrectAnswer && <XCircle className="feedback-icon" size={20} />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {hasAnswered && (
                    <div className={`feedback-panel glass-panel fade-in ${selectedOption === currentQ.correctAnswerIndex ? 'success-feedback' : 'error-feedback'}`}>
                        <div className="feedback-header">
                            {selectedOption === currentQ.correctAnswerIndex ? (
                                <><CheckCircle2 size={24} /> <h3>Correct</h3></>
                            ) : (
                                <><XCircle size={24} /> <h3>Incorrect</h3></>
                            )}
                        </div>
                        <p>{currentQ.explanation}</p>
                        <button className="primary-btn next-q-btn" onClick={handleNext}>
                            <span>{currentIdx === quizData.questions.length - 1 ? 'See Results' : 'Next Question'}</span>
                            <ArrowRight size={20} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
