import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Header from './components/Header';
import InputView from "./views/InputView";
import ReaderView from "./views/ReaderView";
import QuizView from "./views/QuizView";
import ArenaView from "./views/ArenaView";

import './App.css';

export type AppState = 'input' | 'reading' | 'quiz' | 'arena';

function App() {
  const [appState, setAppState] = useState<AppState>('input');
  const [content, setContent] = useState<string>('');
  const [readingMode, setReadingMode] = useState<'read' | 'learn'>('learn');
  const [readingLanguage, setReadingLanguage] = useState<'english' | 'french'>('english');

  const handleStartReading = (text: string, mode: 'read' | 'learn', language: 'english' | 'french') => {
    if (!text.trim()) return;
    setContent(text);
    setReadingMode(mode);
    setReadingLanguage(language);
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

  const handleGoToArena = () => {
    setAppState('arena');
  };

  return (
    <div className="app-layout">
      {appState !== 'input' && appState !== 'arena' && <Header />}
      <main className={`main-content${appState === 'arena' ? ' main-arena' : ''}`}>
        <AnimatePresence mode="wait">
          {appState === 'input' && (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <InputView onStart={handleStartReading} onArena={handleGoToArena} />
            </motion.div>
          )}
          {appState === 'reading' && (
            <motion.div
              key="reading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <ReaderView content={content} readingLanguage={readingLanguage} onFinish={handleFinishReading} onBack={() => setAppState('input')} />
            </motion.div>
          )}
          {appState === 'quiz' && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <QuizView content={content} onRestart={handleRestart} onArena={handleGoToArena} />
            </motion.div>
          )}
          {appState === 'arena' && (
            <motion.div
              key="arena"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              style={{ width: '100%' }}
            >
              <ArenaView onBack={() => setAppState('input')} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

export default App;
