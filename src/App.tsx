import { useState } from 'react';
import Header from './components/Header';
import InputView from "./views/InputView";
import ReaderView from "./views/ReaderView";
import QuizView from "./views/QuizView";

import './App.css';

export type AppState = 'input' | 'reading' | 'quiz';

function App() {
  const [appState, setAppState] = useState<AppState>('input');
  const [content, setContent] = useState<string>('');
  const [readingMode, setReadingMode] = useState<'read' | 'learn'>('learn');

  const handleStartReading = (text: string, mode: 'read' | 'learn') => {
    if (!text.trim()) return;
    setContent(text);
    setReadingMode(mode);
    setAppState('reading');
  };

  const handleFinishReading = () => {
    if (readingMode === 'read') {
      setContent('');
      setAppState('input');
    } else {
      setAppState('quiz');
    }
  };

  const handleRestart = () => {
    setContent('');
    setAppState('input');
  };

  return (
    <div className="app-layout">
      {appState !== 'input' && <Header />}
      <main className="main-content">
        {appState === 'input' && <InputView onStart={handleStartReading} />}
        {appState === 'reading' && <ReaderView content={content} onFinish={handleFinishReading} onBack={() => setAppState('input')} />}
        {appState === 'quiz' && <QuizView content={content} onRestart={handleRestart} />}
      </main>
    </div>
  );
}

export default App;
