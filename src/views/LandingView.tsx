import { useEffect, useState, useRef } from 'react';
import './LandingView.css';

interface LandingViewProps {
    onOpenApp: () => void;
}

export default function LandingView({ onOpenApp }: LandingViewProps) {
    const [demoPlaying, setDemoPlaying] = useState(false);
    const [demoWordIdx, setDemoWordIdx] = useState(3);
    const [realTtsStatus, setRealTtsStatus] = useState<string>('');
    const [realTtsLoading, setRealTtsLoading] = useState(false);

    const words = [
        "A", "prerequisite", "of", "many", "attacks", "is", "to", "obtain",
        "information", "about", "the", "network", "and", "its", "security", "controls."
    ];

    const demoIntervalRef = useRef<number | null>(null);

    useEffect(() => {
        // Scroll reveal logic
        const reveals = document.querySelectorAll('.reveal');
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry, i) => {
                if (entry.isIntersecting) {
                    setTimeout(() => entry.target.classList.add('visible'), i * 80);
                }
            });
        }, { threshold: 0.1 });
        reveals.forEach(el => observer.observe(el));

        // Auto start demo after 2s
        const timer = setTimeout(() => {
            setDemoPlaying(true);
        }, 2000);

        return () => {
            observer.disconnect();
            clearTimeout(timer);
            if (demoIntervalRef.current !== null) {
                clearInterval(demoIntervalRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (demoPlaying) {
            demoIntervalRef.current = window.setInterval(() => {
                setDemoWordIdx(prev => (prev + 1) % words.length);
            }, 400);
        } else if (demoIntervalRef.current !== null) {
            clearInterval(demoIntervalRef.current);
        }
        return () => {
            if (demoIntervalRef.current !== null) {
                clearInterval(demoIntervalRef.current);
            }
        };
    }, [demoPlaying, words.length]);

    const togglePlay = () => {
        setDemoPlaying(!demoPlaying);
    };

    const playRealTTS = async () => {
        const demoText = "A prerequisite of many attacks is to obtain information about the network and its security controls.";
        setRealTtsLoading(true);
        setRealTtsStatus('Connecting to AI...');

        // Stop animated demo if running
        setDemoPlaying(false);

        try {
            const response = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: demoText, voice: 'onyx', lang: 'en' })
            });

            if (!response.ok) throw new Error('Backend not available');

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            setRealTtsStatus('🔊 Playing...');

            // Animate words while audio plays
            setDemoWordIdx(0);
            const wordInterval = window.setInterval(() => {
                setDemoWordIdx(prev => {
                    const next = prev + 1;
                    if (next >= words.length) {
                        clearInterval(wordInterval);
                    }
                    return next;
                });
            }, 350);

            audio.play();
            audio.onended = () => {
                setRealTtsLoading(false);
                setRealTtsStatus('');
                clearInterval(wordInterval);
                setDemoWordIdx(words.length - 1); // keep at end
            };

            audio.onerror = () => {
                setRealTtsLoading(false);
                setRealTtsStatus('⚠️ Audio playback failed');
                clearInterval(wordInterval);
            }

        } catch {
            setRealTtsStatus('⚠️ Start backend first');
            setRealTtsLoading(false);
            setTimeout(() => setRealTtsStatus(''), 3000);
        }
    };

    return (
        <div className="landing-view">
            {/* NAV */}
            <nav className="landing-nav">
                <a href="#" className="landing-nav-logo">
                    <div className="logo-icon">📖</div>
                    Alphie
                </a>
                <ul className="landing-nav-links">
                    <li><a href="#features">Features</a></li>
                    <li><a href="#science">Learning Science</a></li>
                    <li><a href="#voices">Voices</a></li>
                </ul>
                <button className="landing-nav-cta" onClick={onOpenApp}>
                    Open App
                </button>
            </nav>

            {/* HERO */}
            <section className="landing-hero">
                <div className="hero-content">
                    <div className="hero-badge">AI-Powered Reading &amp; Learning</div>
                    <h1>Read Smarter.<br /><span className="accent">Learn Deeper.</span></h1>
                    <p className="hero-sub">Alphie listens with you, highlights every word in real-time, then tests your comprehension with science-backed quizzes and the Feynman Test.</p>
                    <div className="hero-actions">
                        <button onClick={onOpenApp} className="btn-primary">▶ Open Alphie</button>
                        <a href="#features" className="btn-secondary">See How It Works →</a>
                    </div>
                </div>

                <div className="landing-demo-area">
                    <div className="demo-card">
                        <div className="demo-sentence muted-sentence">Threat actors can use a diverse range of techniques to compromise a security system.</div>
                        <div className="demo-sentence active" id="demo-active">
                            {words.map((w, i) => {
                                let className = "demo-word";
                                if (i < demoWordIdx) className += " past-word";
                                if (i === demoWordIdx) className += " active-word word-highlight";
                                return <span key={i} className={className}>{w} </span>;
                            })}
                        </div>
                        <div className="demo-sentence muted-sentence">Social engineering refers to techniques that persuade people into revealing confidential information.</div>

                        <div className="demo-player">
                            <button className="demo-btn" onClick={() => setDemoWordIdx(prev => Math.max(0, prev - 1))}>⏮</button>
                            <button className="demo-btn play" id="play-btn" onClick={togglePlay}>
                                {demoPlaying ? '⏸' : '▶'}
                            </button>
                            <button className="demo-btn" onClick={() => setDemoWordIdx(prev => Math.min(words.length - 1, prev + 1))}>⏭</button>
                            <span className="demo-speed">1.0×</span>
                            <span className="demo-voice">🎙 Onyx</span>
                            <span id="tts-status" className="tts-status-text">{realTtsStatus}</span>
                        </div>

                        {/* REAL TTS DEMO */}
                        <div className="real-tts-container">
                            <button
                                onClick={playRealTTS}
                                disabled={realTtsLoading}
                                className={`real-tts-btn ${realTtsLoading ? 'loading' : ''}`}
                            >
                                {realTtsLoading ? '⏳ Loading...' : '🔊 Hear Real AI Voice Demo'}
                            </button>
                            <p className="real-tts-hint">Requires backend starting</p>
                        </div>
                    </div>
                </div>
            </section>

            {/* STATS */}
            <div className="landing-stats" id="features">
                <div className="landing-stat reveal">
                    <div className="stat-num">3×</div>
                    <div className="stat-label">Faster Comprehension</div>
                </div>
                <div className="landing-stat reveal">
                    <div className="stat-num">6</div>
                    <div className="stat-label">AI Voice Options</div>
                </div>
                <div className="landing-stat reveal">
                    <div className="stat-num">2</div>
                    <div className="stat-label">Languages Supported</div>
                </div>
                <div className="landing-stat reveal">
                    <div className="stat-num">100%</div>
                    <div className="stat-label">Science-Backed Learning</div>
                </div>
            </div>

            {/* FEATURES */}
            <section className="landing-section">
                <div className="reveal">
                    <div className="section-label">Core Features</div>
                    <h2 className="section-title">Everything you need<br />to <em style={{ fontStyle: 'italic', color: 'var(--violet)' }}>actually</em> learn.</h2>
                    <p className="section-sub">Not just text-to-speech. A complete cognitive learning system built around how your brain retains information.</p>
                </div>

                <div className="features-grid">
                    <div className="feature-card reveal">
                        <div className="feature-icon violet">🎙</div>
                        <h3>Neural Text-to-Speech</h3>
                        <p>Powered by OpenAI's most advanced TTS. Six voices from deep authoritative to soft and gentle. Reads like a human narrator, not a robot.</p>
                    </div>
                    <div className="feature-card reveal">
                        <div className="feature-icon cyan">✨</div>
                        <h3>Word-by-Word Spotlight</h3>
                        <p>Every single word lights up exactly as it's spoken. Your eyes follow effortlessly. No more losing your place. Pure focus, zero effort.</p>
                    </div>
                    <div className="feature-card reveal">
                        <div className="feature-icon warm">🧠</div>
                        <h3>Active Recall Quizzes</h3>
                        <p>After reading, AI generates comprehension, inference, and application questions. Answer choices hidden until you try to recall. Science proves this doubles retention.</p>
                    </div>
                    <div className="feature-card reveal">
                        <div className="feature-icon green">🔬</div>
                        <h3>The Feynman Test</h3>
                        <p>Explain what you read in your own words. AI evaluates your understanding, highlights what you got right, and coaches you on what to add.</p>
                    </div>
                    <div className="feature-card reveal">
                        <div className="feature-icon pink">🎯</div>
                        <h3>Focus Reader Mode</h3>
                        <p>All sentences except the active one dim to 25% opacity. Your brain locks onto one idea at a time. Cognitive load drops dramatically.</p>
                    </div>
                    <div className="feature-card reveal">
                        <div className="feature-icon blue">🌍</div>
                        <h3>English &amp; French</h3>
                        <p>Switch between English and French reading mode. The TTS engine uses native pronunciation for each language. Paste your text, choose your language, listen naturally.</p>
                    </div>
                </div>
            </section>

            {/* LEARNING SCIENCE */}
            <div className="science-section" id="science">
                <div className="science-inner">
                    <div className="reveal">
                        <div className="section-label">Built on Research</div>
                        <h2 className="section-title responsive-title-large">The science behind every feature.</h2>
                        <p className="section-sub responsive-sub">Alphie isn't a study tool. It's a learning system designed around how memory actually works.</p>

                        <div className="science-steps">
                            <div className="science-step">
                                <div className="step-num">1</div>
                                <div className="step-content">
                                    <h4>Active Recall</h4>
                                    <p>Testing yourself from memory is 50% more effective than rereading. Every quiz forces retrieval before showing answers.</p>
                                </div>
                            </div>
                            <div className="science-step">
                                <div className="step-num">2</div>
                                <div className="step-content">
                                    <h4>Spaced Repetition</h4>
                                    <p>Wrong answers are saved as &quot;Concepts to Review Tomorrow.&quot; The app tells you exactly what to study next session.</p>
                                </div>
                            </div>
                            <div className="science-step">
                                <div className="step-num">3</div>
                                <div className="step-content">
                                    <h4>The Feynman Technique</h4>
                                    <p>If you can explain it simply, you truly understand it. The AI evaluates your explanation and tells you what's missing.</p>
                                </div>
                            </div>
                            <div className="science-step">
                                <div className="step-num">4</div>
                                <div className="step-content">
                                    <h4>Depth of Field Focus</h4>
                                    <p>Research shows peripheral contrast reduces cognitive load. Active sentences glow. Everything else recedes. Your brain locks in.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="reveal">
                        <div className="quiz-mockup">
                            <div className="q-label">Active Recall Quiz — Question 2 of 5</div>
                            <div className="q-text">What is the PRIMARY goal of social engineering in cybersecurity attacks?</div>
                            <div className="quiz-option correct">
                                <div className="quiz-letter">A</div>
                                Persuade people into revealing confidential information
                            </div>
                            <div className="quiz-option wrong">
                                <div className="quiz-letter">B</div>
                                Exploit software vulnerabilities directly
                            </div>
                            <div className="quiz-option">
                                <div className="quiz-letter">C</div>
                                Install malware on target systems
                            </div>
                            <div className="quiz-option">
                                <div className="quiz-letter">D</div>
                                Intercept network communications
                            </div>
                        </div>

                        <div className="feynman-card">
                            <div className="f-title">📝 <span className="text-violet">The Feynman Test</span></div>
                            <div className="f-sub">Explain the main ideas in your own words, as if teaching a friend.</div>
                            <div className="feynman-area">Attackers first gather information about a target network before launching an attack. Social engineering tricks people into giving up this information...</div>
                            <div className="feynman-hints">
                                <div className="hint-pill">✓ Strong points</div>
                                <div className="hint-pill">💡 What to add next time</div>
                                <div className="hint-pill">✏️ Try rewriting this</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* VOICES */}
            <section className="voices-section reveal" id="voices">
                <div className="section-label">Voice Selection</div>
                <h2 className="section-title">Find the voice that<br />helps you <em className="italic-cyan">focus.</em></h2>
                <p className="section-sub text-center mx-auto">Six distinct AI voices. Preview any before you start. Your choice is remembered next session.</p>

                <div className="voices-grid">
                    <div className="voice-card featured">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Onyx</div>
                        <div className="voice-desc">Deep, authoritative male narrator. Perfect for technical content and long study sessions.</div>
                        <div className="voice-tag">★ Most Popular</div>
                    </div>
                    <div className="voice-card">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Echo</div>
                        <div className="voice-desc">Calm, clear male voice. Clean and precise for academic and professional material.</div>
                        <div className="voice-tag">Great for focus</div>
                    </div>
                    <div className="voice-card">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Fable</div>
                        <div className="voice-desc">Warm storytelling voice. Makes even dense material feel engaging and natural.</div>
                        <div className="voice-tag">Most engaging</div>
                    </div>
                    <div className="voice-card">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Nova</div>
                        <div className="voice-desc">Clear, friendly female voice. Energetic and encouraging for motivation during study.</div>
                        <div className="voice-tag">Clear &amp; bright</div>
                    </div>
                    <div className="voice-card">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Shimmer</div>
                        <div className="voice-desc">Soft, gentle female voice. Ideal for relaxed evening reading and light material.</div>
                        <div className="voice-tag">Calm &amp; gentle</div>
                    </div>
                    <div className="voice-card">
                        <div className="voice-wave">🎙</div>
                        <div className="voice-name">Alloy</div>
                        <div className="voice-desc">Neutral, balanced voice. A versatile all-rounder for any type of content.</div>
                        <div className="voice-tag">Versatile</div>
                    </div>
                </div>

                {/* THEMES */}
                <div className="reveal mt-80">
                    <div className="section-label">Reading Themes</div>
                    <h3 className="theme-title">Comfort for every hour.</h3>
                    <p className="theme-sub">Light for daytime. Dark for night. Sepia to eliminate blue light. Your preference is saved automatically.</p>
                    <div className="themes-showcase">
                        <div className="theme-pill light">
                            <div className="theme-dot theme-dot-light"></div>
                            Light Mode
                        </div>
                        <div className="theme-pill dark">
                            <div className="theme-dot theme-dot-dark"></div>
                            Dark Mode
                        </div>
                        <div className="theme-pill sepia">
                            <div className="theme-dot theme-dot-sepia"></div>
                            Sepia Mode
                        </div>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="cta-section" id="cta">
                <div className="cta-glow"></div>
                <h2 className="reveal">Ready to <em className="italic-violet">actually</em><br />remember what you read?</h2>
                <p className="reveal">Paste any text. Choose your voice. Listen, learn, and prove you understand it.</p>
                <div className="reveal cta-actions">
                    <button onClick={onOpenApp} className="btn-primary btn-large">▶ Open Alphie</button>
                </div>
                <p className="reveal cta-hint">No account required. Works in your browser.</p>
            </section>

            {/* FOOTER */}
            <footer className="landing-footer">
                <div className="footer-logo">
                    <div className="logo-icon footer-icon">📖</div>
                    Alphie
                </div>
                <div className="footer-links">
                </div>
                <p className="footer-copy">© 2026 Alphie</p>
            </footer>
        </div>
    );
}
