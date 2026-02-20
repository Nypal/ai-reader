import { useState } from 'react';
import { CheckCircle2, XCircle, RotateCcw, ArrowLeft } from 'lucide-react';
import './QuizView.css';

interface QuizViewProps {
    content: string; // The original text (used later for AI generation)
    onRestart: () => void;
}

// Mock questions for MVP
const MOCK_QUESTIONS = [
    {
        id: 1,
        question: "What is the main topic of the text?",
        options: ["Artificial Intelligence", "Web Development", "Data Science", "Cybersecurity"],
        answer: 0,
        explanation: "The text discusses AI-powered tools."
    },
    {
        id: 2,
        question: "Which feature is critical for the application?",
        options: ["Social sharing", "Neural Text-to-Speech", "Blockchain integration", "3D graphics"],
        answer: 1,
        explanation: "Neural TTS ensures human-like reading quality."
    }
];

export default function QuizView({ onRestart }: QuizViewProps) {
    const [answers, setAnswers] = useState<Record<number, number>>({});

    const handleSelect = (qId: number, optIndex: number) => {
        if (answers[qId] !== undefined) return; // Prevent changing answer
        setAnswers(prev => ({ ...prev, [qId]: optIndex }));
    };

    const calculateScore = () => {
        let score = 0;
        MOCK_QUESTIONS.forEach(q => {
            if (answers[q.id] === q.answer) score++;
        });
        return Math.round((score / MOCK_QUESTIONS.length) * 100);
    };

    return (
        <div className="view-container quiz-view">
            <div className="quiz-header top-header">
                <button className="back-btn" onClick={onRestart}>
                    <ArrowLeft size={20} />
                    <span>Back to Start</span>
                </button>
                <div className="quiz-titles">
                    <h2>Quick Knowledge Check</h2>
                    <p>Let's see how much you remembered.</p>
                </div>
                <div className="spacer-invisible"></div>
            </div>

            <div className="quiz-content">
                {MOCK_QUESTIONS.map((q, i) => (
                    <div key={q.id} className="question-card">
                        <h3>{i + 1}. {q.question}</h3>
                        <div className="options-list">
                            {q.options.map((opt, optIdx) => {
                                const isSelected = answers[q.id] === optIdx;
                                const isCorrect = q.answer === optIdx;
                                const hasAnswered = answers[q.id] !== undefined;

                                let optionClass = "option-btn ";
                                if (isSelected) optionClass += "selected ";
                                if (hasAnswered) {
                                    if (isCorrect) optionClass += "correct ";
                                    else if (isSelected && !isCorrect) optionClass += "incorrect ";
                                }

                                return (
                                    <button
                                        key={optIdx}
                                        className={optionClass}
                                        onClick={() => handleSelect(q.id, optIdx)}
                                        disabled={hasAnswered}
                                    >
                                        <div className="option-marker">
                                            {String.fromCharCode(65 + optIdx)}
                                        </div>
                                        <span>{opt}</span>

                                        {hasAnswered && isCorrect && <CheckCircle2 className="result-icon correct-icon" size={20} />}
                                        {hasAnswered && isSelected && !isCorrect && <XCircle className="result-icon incorrect-icon" size={20} />}
                                    </button>
                                );
                            })}
                        </div>

                        {answers[q.id] !== undefined && (
                            <div className={`explanation ${answers[q.id] === q.answer ? 'success' : 'error'}`}>
                                <strong>Explanation: </strong> {q.explanation}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <div className="quiz-actions">
                {Object.keys(answers).length === MOCK_QUESTIONS.length && (
                    <div className="results-panel">
                        <div className="score-display">
                            <span className="score-label">Your Score:</span>
                            <span className="score-value">{calculateScore()}%</span>
                        </div>
                        <button className="secondary-btn restart-btn" onClick={onRestart}>
                            <RotateCcw size={20} />
                            <span>Learn Something New</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
