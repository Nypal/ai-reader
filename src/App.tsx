import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Header from './components/Header';
import InputView from "./views/InputView";
import ReaderView from "./views/ReaderView";
import QuizView from "./views/QuizView";
import ArenaView from "./views/ArenaView";
import LandingView from "./views/LandingView";

import './App.css';

export type AppState = 'landing' | 'input' | 'reading' | 'quiz' | 'arena';

// Opaque shape — QuizView normalises the fields it cares about.
export type PrefetchedQuiz = { data?: unknown; error?: string; loading: boolean };

function App() {
  const [appState, setAppState] = useState<AppState>('landing');
  const [content, setContent] = useState<string>('');
  const [readingMode, setReadingMode] = useState<'read' | 'learn'>('learn');
  const [readingLanguage, setReadingLanguage] = useState<'english' | 'french'>('english');
  const [prefetchedQuiz, setPrefetchedQuiz] = useState<PrefetchedQuiz | null>(null);
  const [prewarmBlob, setPrewarmBlob] = useState<{ blob: Blob; voice: string; lang: string } | null>(null);

  useEffect(() => {
    const storedTheme = localStorage.getItem('playlearn_theme') || 'sepia';
    if (storedTheme !== 'night') {
      document.documentElement.setAttribute('data-theme', storedTheme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, []);

  const handleStartReading = (text: string, mode: 'read' | 'learn', language: 'english' | 'french') => {
    if (!text.trim()) return;
    setContent(text);
    setReadingMode(mode);
    setReadingLanguage(language);
    setAppState('reading');

    // Pre-fetch quiz in the background while the user is reading.
    // By the time they finish listening the questions should be ready.
    if (mode === 'learn') {
      const lang = language === 'french' ? 'fr' : 'en';
      setPrefetchedQuiz({ loading: true });
      fetch(`${import.meta.env.VITE_API_URL}/api/quiz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
      })
        .then(res => res.ok ? res.json() : Promise.reject(new Error(`Quiz API error ${res.status}`)))
        .then(data => setPrefetchedQuiz({ data, loading: false }))
        .catch(err => setPrefetchedQuiz({ error: err instanceof Error ? err.message : String(err), loading: false }));
    }
  };

  const handleFinishReading = () => {
    if (readingMode === 'read') {
      setContent('');
      setPrefetchedQuiz(null);
      setPrewarmBlob(null);
      setAppState('input');
    } else {
      setAppState('quiz');
    }
  };

  const handleRestart = () => {
    setContent('');
    setPrefetchedQuiz(null);
    setPrewarmBlob(null);
    setAppState('input');
  };

  const handleGoToArena = () => {
    setAppState('arena');
  };

  // prewarmPromise resolves to { blob, voice, lang } once the TTS fetch completes.
  // ReaderView awaits this Promise directly so it can skip its own TTS fetch even
  // when the user navigates before the prewarm blob is stored in React state.
  const prewarmPromiseRef = useRef<Promise<{ blob: Blob; voice: string; lang: string }> | null>(null);

  const handlePrewarm = (sentence0: string, voice: string, lang: string) => {
    setPrewarmBlob(null);

    const promise = fetch(`${import.meta.env.VITE_API_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sentence0, voice, lang }),
    })
      .then(res => res.ok ? res.arrayBuffer() : Promise.reject())
      .then(buf => {
        if (buf.byteLength < 1000) {
          throw new Error(`Prewarm TTS returned too few bytes: ${buf.byteLength}`);
        }
        const blob = new Blob([buf], { type: 'audio/mpeg' });
        const result = { blob, voice, lang };
        setPrewarmBlob(result);
        console.log('[Prewarm] TTS sentence-0 ready, bytes=', buf.byteLength);
        return result;
      });

    prewarmPromiseRef.current = promise.catch(() => {
      console.debug('[Prewarm] prefetch failed — will fall back to normal fetch');
      return Promise.reject();
    });
  };

  const handleGoHome = () => {
    setContent('');
    setPrefetchedQuiz(null);
    setPrewarmBlob(null);
    prewarmPromiseRef.current = null;
    setAppState('input');
  };

  return (
    <div className="app-layout">
      {appState !== 'landing' && appState !== 'input' && appState !== 'arena' && <Header onHome={handleGoHome} />}
      <main className={`main-content${appState === 'arena' ? ' main-arena' : ''}${appState === 'landing' ? ' main-landing' : ''}`}>
        <AnimatePresence mode="wait">
          {appState === 'landing' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <LandingView onOpenApp={() => setAppState('input')} />
            </motion.div>
          )}
          {appState === 'input' && (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <InputView onStart={handleStartReading} onArena={handleGoToArena} onPrewarm={handlePrewarm} />
            </motion.div>
          )}
          {appState === 'reading' && (
            <motion.div
              key="reading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <ReaderView content={content} readingLanguage={readingLanguage} prewarmBlob={prewarmBlob} prewarmPromiseRef={prewarmPromiseRef} onFinish={handleFinishReading} onBack={() => { setPrefetchedQuiz(null); setPrewarmBlob(null); prewarmPromiseRef.current = null; setAppState('input'); }} />
            </motion.div>
          )}
          {appState === 'quiz' && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            >
              <QuizView
                content={content}
                lang={readingLanguage === 'french' ? 'fr' : 'en'}
                prefetchedQuiz={prefetchedQuiz}
                onRestart={handleRestart}
                onArena={handleGoToArena}
              />
            </motion.div>
          )}
          {appState === 'arena' && (
            <motion.div
              key="arena"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.3 } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
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
