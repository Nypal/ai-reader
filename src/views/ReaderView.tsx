import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, SkipBack, SkipForward, Play, Pause } from 'lucide-react';
import { useSentenceSplitter } from '../hooks/useSentenceSplitter';
import { AuditService } from '../services/AuditService';
import './ReaderView.css';

interface ReaderViewProps {
    content: string;
    readingLanguage: 'english' | 'french';
    onFinish: () => void;
    onBack: () => void;
}

type CacheItem = {
    idx: number;
    url: string;
    blob: Blob;
    byteLength: number;
    contentType: string;
    createdAt: number;
};

type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

const MAX_CACHE = 6;

function nowMs() {
    return performance.now();
}

function safeRevoke(url: string | null) {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
}

function assertAudioContentType(ct: string | null): string {
    const safe = (ct ?? "").toLowerCase();
    if (!safe.startsWith("audio/")) return "audio/mpeg";
    return safe.split(";")[0].trim();
}

function blobUrlFrom(buf: ArrayBuffer, contentType: string) {
    const blob = new Blob([buf], { type: contentType });
    return { blob, url: URL.createObjectURL(blob), byteLength: buf.byteLength, contentType };
}

// Estimates syllable count for a word — a better proxy for spoken duration than char count.
// e.g. "the" → 1, "beautiful" → 3, "strength" → 1
function estimateSyllables(word: string): number {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length === 0) return 1;
    if (w.length <= 3) return 1;
    const groups = w.match(/[aeiouy]+/g);
    let count = groups ? groups.length : 1;
    // Silent trailing 'e': "cake" → 1 syllable, not 2
    if (w.endsWith('e') && count > 1) count--;
    return Math.max(1, count);
}

export default function ReaderView({ content, readingLanguage, onFinish, onBack }: ReaderViewProps) {
    const effectiveContent = content?.trim() || "Hello, this is a playback test.";
    const { original: sentences, spoken: sentencesSpoken } = useSentenceSplitter(effectiveContent);

    const [playbackState, setPlaybackState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'error'>('idle');
    const [currentSentenceIdx, setCurrentSentenceIdx] = useState(-1);
    const [speed, setSpeed] = useState(1);
    const [lastError, setLastError] = useState<string | null>(null);
    const [voiceUI, setVoiceUI] = useState<TTSVoice>(() => {
        return (localStorage.getItem('playlearn_voice') as TTSVoice) || 'onyx';
    });
    const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
    const handleSpeedToggle = () => {
        const nextIdx = (SPEEDS.indexOf(speed) + 1) % SPEEDS.length;
        setSpeed(SPEEDS[nextIdx]);
    };

    // Technical Audit State
    const [_ttsLatencyAvg, setTtsLatencyAvg] = useState(0);
    void _ttsLatencyAvg; // used by setTtsLatencyAvg in fetchTts
    const [isSlowBackend, setIsSlowBackend] = useState(false);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const runIdRef = useRef(0);
    const isStoppedRef = useRef(true);
    const currentObjectUrlRef = useRef<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const inFlightPlayRef = useRef<Promise<void> | null>(null);
    const voiceRef = useRef<TTSVoice>(voiceUI);

    const [sentenceProgress, setSentenceProgress] = useState(0);
    const animationFrameRef = useRef<number>(0);

    const sessionStartTimeRef = useRef<number>(Date.now());
    const maxSpeedUsedRef = useRef<number>(speed);
    const replayCountRef = useRef<number>(0);
    const highestSentenceIdxRef = useRef<number>(0);
    const hasLoggedSessionRef = useRef<boolean>(false);

    const cacheRef = useRef<Map<number, CacheItem>>(new Map());
    const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([]);

    const handleVoiceChange = (newVoice: TTSVoice) => {
        if (newVoice === voiceUI) return;
        setVoiceUI(newVoice);
        voiceRef.current = newVoice;
        localStorage.setItem('playlearn_voice', newVoice);
        for (const item of cacheRef.current.values()) safeRevoke(item.url);
        cacheRef.current.clear();
    };

    useEffect(() => {
        if (currentSentenceIdx >= 0 && sentenceRefs.current[currentSentenceIdx]) {
            const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            sentenceRefs.current[currentSentenceIdx]?.scrollIntoView({
                behavior: prefersReducedMotion ? "auto" : "smooth",
                block: "center"
            });
        }
    }, [currentSentenceIdx]);

    useEffect(() => {
        const a = new Audio();
        a.preload = "auto";
        audioRef.current = a;

        const cacheMap = cacheRef.current;

        const loop = () => {
            if (audioRef.current && audioRef.current.duration > 0 && !audioRef.current.paused) {
                setSentenceProgress(audioRef.current.currentTime / audioRef.current.duration);
            }
            animationFrameRef.current = requestAnimationFrame(loop);
        };

        a.onplaying = () => {
            if (isStoppedRef.current) return;
            setPlaybackState("playing");
            animationFrameRef.current = requestAnimationFrame(loop);
        };
        a.onpause = () => {
            if (isStoppedRef.current) return;
            setPlaybackState((s) => (s === "playing" ? "paused" : s));
            cancelAnimationFrame(animationFrameRef.current);
        };
        a.onended = () => {
            if (isStoppedRef.current) return;
        };
        a.onerror = () => {
            if (isStoppedRef.current) return;
            const el = audioRef.current;
            if (el?.error) {
                console.log("[PlayLearn] audio error code:", el.error.code);
            }
            const msg = (el?.error as { message?: string })?.message ?? "";
            console.error(`[PlayLearn] audio error. MediaError.code=${el?.error?.code ?? "?"} ${msg}`);
            setLastError(`Audio error. MediaError.code=${el?.error?.code ?? "?"} ${msg}`);
            setPlaybackState("error");
        };

        return () => {
            a.onplaying = null;
            a.onpause = null;
            a.onended = null;
            a.onerror = null;

            // Defers cleanup to prevent unhandled extension promises
            setTimeout(() => {
                try {
                    a.pause();
                    a.removeAttribute("src");
                    a.load();
                } catch (e) {
                    console.debug("[PlayLearn] Ignored extension channel error on unmount", e);
                }
                safeRevoke(currentObjectUrlRef.current);
                currentObjectUrlRef.current = null;
                for (const item of cacheMap.values()) safeRevoke(item.url);
                cacheMap.clear();
            }, 0);

            audioRef.current = null;
            cancelAnimationFrame(animationFrameRef.current);
        };
    }, []);

    const stop = useCallback(() => {
        isStoppedRef.current = true;
        runIdRef.current += 1;

        abortRef.current?.abort();
        abortRef.current = null;

        const a = audioRef.current;
        if (a) {
            a.onplaying = null;
            a.onpause = null;
            a.onended = null;
            a.onerror = null;

            try {
                a.pause();
                a.currentTime = 0;
                a.removeAttribute("src");
                a.load();
            } catch (e) {
                console.debug("[PlayLearn] Ignored extension channel error on stop", e);
            }
        }

        safeRevoke(currentObjectUrlRef.current);
        currentObjectUrlRef.current = null;

        for (const item of cacheRef.current.values()) safeRevoke(item.url);
        cacheRef.current.clear();

        setPlaybackState("idle");
        setLastError(null);
        setCurrentSentenceIdx(-1);
    }, []);

    const fetchTts = useCallback(async (text: string, signal: AbortSignal): Promise<{ buf: ArrayBuffer; contentType: string }> => {
        const MAX_RETRIES = 3;
        let lastErr: Error = new Error("unknown");

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delayMs = 500 * 2 ** (attempt - 1); // 500ms, then 1000ms
                await new Promise<void>((res) => setTimeout(res, delayMs));
                if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            }

            try {
                const fetchStartMs = nowMs();
                console.log(`[PlayLearn] fetching TTS (attempt ${attempt + 1}): "${text}"`);
                const res = await fetch(`${import.meta.env.VITE_API_URL}/api/tts`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text, voice: voiceRef.current, lang: readingLanguage === 'french' ? 'fr' : 'en' }),
                    signal,
                });

                const ct = res.headers.get("content-type");
                console.log(`[PlayLearn] status`, res.status, ct);

                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(`TTS HTTP ${res.status} (${ct ?? "no-ct"}): ${errText}`);
                }

                const buf = await res.arrayBuffer();
                console.log("[PlayLearn] bytes received:", buf.byteLength);

                if (buf.byteLength < 1000) {
                    throw new Error(`TTS returned too few bytes: ${buf.byteLength}`);
                }

                const latency = nowMs() - fetchStartMs;
                setTtsLatencyAvg(prev => {
                    const newAvg = prev === 0 ? latency : (prev * 0.7 + latency * 0.3);
                    if (newAvg > 3000 && !isSlowBackend) {
                        setIsSlowBackend(true);
                    }
                    return newAvg;
                });

                return { buf, contentType: assertAudioContentType(ct) };
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") throw err;
                lastErr = err instanceof Error ? err : new Error(String(err));
                console.warn(`[PlayLearn] TTS attempt ${attempt + 1} failed: ${lastErr.message}`);
            }
        }

        throw lastErr;
    }, [isSlowBackend, readingLanguage]);

    const prefetchSingle = useCallback(
        async (j: number, myRunId: number) => {
            if (isStoppedRef.current || runIdRef.current !== myRunId) return;
            if (j < 0 || j >= sentencesSpoken.length) return;
            if (cacheRef.current.has(j)) return;

            // evict oldest if at capacity
            if (cacheRef.current.size >= MAX_CACHE) {
                const oldest = [...cacheRef.current.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
                if (oldest) {
                    cacheRef.current.delete(oldest.idx);
                    safeRevoke(oldest.url);
                }
            }

            const ac = abortRef.current;
            if (!ac) return;

            const rawText = sentencesSpoken[j]?.trim() || "";
            const safeText = rawText.length > 0 ? rawText : "Test.";

            try {
                const { buf, contentType } = await fetchTts(safeText, ac.signal);
                if (isStoppedRef.current || runIdRef.current !== myRunId) return;

                const built = blobUrlFrom(buf, contentType);
                cacheRef.current.set(j, {
                    idx: j,
                    url: built.url,
                    blob: built.blob,
                    byteLength: built.byteLength,
                    contentType: built.contentType,
                    createdAt: Date.now(),
                });
                console.log("[PlayLearn] prefetched idx=", j, "bytes=", built.byteLength);
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.debug(`[PlayLearn] prefetch failed for idx ${j}: ${errMsg}`);
                // Will naturally retry on play miss
            }
        },
        [fetchTts, sentencesSpoken]
    );

    const playIndex = useCallback(async (idx: number, runIdAtStart: number): Promise<void> => {
        if (isStoppedRef.current) return;
        if (runIdRef.current !== runIdAtStart) return;

        if (idx < 0 || idx >= sentences.length) {
            setPlaybackState("completed");
            setCurrentSentenceIdx(-1);
            if (!hasLoggedSessionRef.current) {
                hasLoggedSessionRef.current = true;
                AuditService.logSession({
                    durationSeconds: Math.max(1, Math.round((Date.now() - sessionStartTimeRef.current) / 1000)),
                    sentencesRead: highestSentenceIdxRef.current + 1,
                    maxSpeedUsed: maxSpeedUsedRef.current,
                    replayCount: replayCountRef.current
                });
            }
            onFinish();
            return;
        }

        if (idx > highestSentenceIdxRef.current) highestSentenceIdxRef.current = idx;
        setPlaybackState("loading");
        const t0 = nowMs();

        const a = audioRef.current;
        if (!a) return;
        a.playbackRate = speed;

        const cached = cacheRef.current.get(idx);
        if (cached) {
            console.log(`[PlayLearn] cache hit idx=${idx} bytes=${cached.byteLength}`);
            safeRevoke(currentObjectUrlRef.current);
            currentObjectUrlRef.current = cached.url; // claim ownership
            cacheRef.current.delete(idx);
            a.src = currentObjectUrlRef.current;
            a.load(); // pre-warm browser decoder for instant start
        } else {
            console.log(`[PlayLearn] cache miss idx=${idx} fetching...`);
            const text = sentencesSpoken[idx]?.trim();
            const safeText = text && text.length > 0 ? text : "Test.";

            try {
                const ac = abortRef.current;
                if (!ac) return;

                const { buf, contentType } = await fetchTts(safeText, ac.signal);
                if (isStoppedRef.current || runIdRef.current !== runIdAtStart) return;

                const built = blobUrlFrom(buf, contentType);
                safeRevoke(currentObjectUrlRef.current);
                currentObjectUrlRef.current = built.url;
                a.src = currentObjectUrlRef.current;
                a.load(); // pre-warm browser decoder for instant start
            } catch (e: unknown) {
                if (isStoppedRef.current) return;
                const errName = e instanceof Error ? e.name : "Error";
                if (errName === "AbortError") return;
                setPlaybackState("error");
                setLastError(`Fetch error: ${e instanceof Error ? e.message : String(e)}`);
                return;
            }
        }

        if (isStoppedRef.current || runIdRef.current !== runIdAtStart) return;

        a.onended = () => {
            if (isStoppedRef.current || runIdRef.current !== runIdAtStart) return;
            const tgap = nowMs();

            if (idx >= sentences.length - 1) {
                console.log("[PlayLearn] FINAL sentence reached.");

                // Defers cleanup to prevent unhandled extension promises
                setTimeout(() => {
                    try {
                        a.pause();
                        a.removeAttribute("src");
                        a.load();
                    } catch (e) {
                        console.debug("[PlayLearn] Ignored extension channel error on finish", e);
                    }
                    safeRevoke(currentObjectUrlRef.current);
                    currentObjectUrlRef.current = null;
                }, 0);

                a.onended = null;
                a.onerror = null;

                setPlaybackState("completed");
                setCurrentSentenceIdx(-1);
                if (!hasLoggedSessionRef.current) {
                    hasLoggedSessionRef.current = true;
                    AuditService.logSession({
                        durationSeconds: Math.max(1, Math.round((Date.now() - sessionStartTimeRef.current) / 1000)),
                        sentencesRead: highestSentenceIdxRef.current + 1,
                        maxSpeedUsed: maxSpeedUsedRef.current,
                        replayCount: replayCountRef.current
                    });
                }
                onFinish();
                return;
            }

            const next = idx + 1;
            void playIndex(next, runIdAtStart).then(() => {
                console.log(`[PlayLearn] Gap ms for idx ${next}: ${Math.round(nowMs() - tgap)}ms`);
            });
        };

        try {
            setCurrentSentenceIdx(idx);
            setSentenceProgress(0);
            a.currentTime = 0;
            inFlightPlayRef.current = a.play();
            await inFlightPlayRef.current;
            console.log(`[PlayLearn] play started idx=${idx} ttfs_ms=${Math.round(nowMs() - t0)}ms`);

            // N is now playing — kick off lookahead prefetches so N+1 is ready before N ends.
            // N+1 immediately (highest priority, no competition with current fetch).
            // N+2 after 300ms to avoid competing with N+1's fetch.
            if (!isStoppedRef.current && runIdRef.current === runIdAtStart) {
                void prefetchSingle(idx + 1, runIdAtStart);
                setTimeout(() => {
                    if (!isStoppedRef.current && runIdRef.current === runIdAtStart) {
                        void prefetchSingle(idx + 2, runIdAtStart);
                    }
                }, 300);
            }
        } catch (e: unknown) {
            setPlaybackState("error");
            const errName = e instanceof Error ? e.name : "Error";
            const errMsg = e instanceof Error ? e.message : String(e);
            const errorMsg = `play() rejected: ${errName} ${errMsg}`;
            console.error(errorMsg);
            setLastError(errorMsg);
        } finally {
            inFlightPlayRef.current = null;
        }

    }, [fetchTts, prefetchSingle, speed, onFinish, sentences, sentencesSpoken]);

    useEffect(() => {
        if (speed > maxSpeedUsedRef.current) maxSpeedUsedRef.current = speed;
        if (audioRef.current) {
            audioRef.current.playbackRate = speed;
        }
    }, [speed]);

    useEffect(() => {
        return () => stop();
    }, [stop]);

    // Auto-start playback on mount
    useEffect(() => {
        if (sentences.length > 0 && playbackState === 'idle' && isStoppedRef.current) {
            runIdRef.current += 1;
            isStoppedRef.current = false;
            setLastError(null);
            abortRef.current = new AbortController();
            playIndex(0, runIdRef.current).catch((e: unknown) => {
                setPlaybackState("error");
                setLastError(e instanceof Error ? e.message : String(e));
            });
        }
    }, [sentences.length, playbackState, playIndex]);

    const togglePlay = () => {
        console.log("[PlayLearn] togglePlay clicked, text length =", effectiveContent.length);
        if (playbackState === 'playing') {
            const a = audioRef.current;
            if (a) {
                try {
                    a.pause();
                } catch (e) {
                    console.debug("[PlayLearn] Ignored extension channel error on pause toggle", e);
                }
                setPlaybackState("paused");
            }
        } else {
            const a = audioRef.current;
            if (a?.src && a.paused && playbackState === 'paused') {
                a.play().catch((e: unknown) => {
                    setPlaybackState("error");
                    const errName = e instanceof Error ? e.name : "Error";
                    const errMsg = e instanceof Error ? e.message : String(e);
                    setLastError(`resume play() rejected: ${errName} ${errMsg}`);
                    console.error("[PlayLearn] Resume rejected", e);
                });
            } else {
                runIdRef.current += 1;
                isStoppedRef.current = false;
                setLastError(null);
                abortRef.current = new AbortController();
                const startIdx = currentSentenceIdx >= 0 ? currentSentenceIdx : 0;
                playIndex(startIdx, runIdRef.current).catch((e: unknown) => {
                    setPlaybackState("error");
                    setLastError(e instanceof Error ? e.message : String(e));
                });
            }
        }
    };

    const handleSeek = (newIdx: number) => {
        // Immediately stop current audio so old sentence doesn't keep playing
        try { audioRef.current?.pause(); } catch { /* ignore */ }
        replayCountRef.current += 1;
        const wasPlaying = playbackState === 'playing' || playbackState === 'loading' || playbackState === 'paused';
        runIdRef.current += 1;
        isStoppedRef.current = false;
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        setLastError(null);
        setCurrentSentenceIdx(newIdx);

        if (wasPlaying) {
            playIndex(newIdx, runIdRef.current).catch(e => {
                setPlaybackState("error");
                const errName = e instanceof Error ? e.name : "Error";
                const errMsg = e instanceof Error ? e.message : String(e);
                setLastError(`seek play() rejected: ${errName} ${errMsg}`);
            });
        }
    };

    const handleBack = () => {
        stop();
        onBack();
    };

    const [isScrolled, setIsScrolled] = useState(false);
    const [theme, setTheme] = useState<'night' | 'light' | 'sepia' | 'forest'>('night');
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);

    useEffect(() => {
        const storedTheme = (localStorage.getItem('playlearn_theme') as string) || 'night';
        setTheme(storedTheme as 'night' | 'light' | 'sepia' | 'forest');
        if (storedTheme !== 'night') {
            document.documentElement.setAttribute('data-theme', storedTheme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }

        const handleScroll = () => {
            setIsScrolled(window.scrollY > 20);
        };
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const handleSetTheme = (newTheme: 'night' | 'light' | 'sepia' | 'forest') => {
        setTheme(newTheme);
        localStorage.setItem('playlearn_theme', newTheme);
        if (newTheme !== 'night') {
            document.documentElement.setAttribute('data-theme', newTheme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    };

    const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const bar = e.currentTarget;
        const pct = e.nativeEvent.offsetX / bar.offsetWidth;
        const idx = Math.round(pct * (sentences.length - 1));
        handleSeek(Math.max(0, Math.min(idx, sentences.length - 1)));
    };

    const overallProgressPct = sentences.length > 1
        ? (Math.max(0, currentSentenceIdx) / (sentences.length - 1)) * 100
        : 0;

    return (
        <div className="reader-page">
            <div className="ambient">
                <div className="glow-1"></div>
                <div className="glow-2"></div>
            </div>

            {/* PROGRESS LINE */}
            <div className="reader-progress-bar">
                <div
                    className="reader-progress-fill"
                    style={{ '--reader-progress-width': `${overallProgressPct}%` } as React.CSSProperties}
                />
            </div>

            {/* TOP BAR */}
            <nav className={`reader-topbar ${isScrolled ? 'scrolled' : ''}`}>
                <button className="reader-back-btn" onClick={handleBack}>
                    <ArrowLeft size={16} /> Back to Start
                </button>
                <div className="reader-topbar-right">
                    <div className="theme-dots">
                        <div
                            className={`tdot tdot-night ${theme === 'night' ? 'active' : ''}`}
                            onClick={() => handleSetTheme('night')}
                            data-tip="Night"
                        />
                        <div
                            className={`tdot tdot-light ${theme === 'light' ? 'active' : ''}`}
                            onClick={() => handleSetTheme('light')}
                            data-tip="Light"
                        />
                        <div
                            className={`tdot tdot-sepia ${theme === 'sepia' ? 'active' : ''}`}
                            onClick={() => handleSetTheme('sepia')}
                            data-tip="Sepia"
                        />
                        <div
                            className={`tdot tdot-forest ${theme === 'forest' ? 'active' : ''}`}
                            onClick={() => handleSetTheme('forest')}
                            data-tip="Forest"
                        />
                    </div>
                </div>
            </nav>

            {/* CONTENT */}
            <div className="reader-content" data-has-active={currentSentenceIdx >= 0}>
                <div className="sentences-container">
                    {sentences.map((sentence, idx) => {
                        const isHighlighted = idx === currentSentenceIdx;
                        const words = sentence.split(/(\s+)/);
                        const wordTokens = words.filter(w => w.trim().length > 0);
                        const totalSyllables = wordTokens.reduce((sum, w) => sum + estimateSyllables(w), 0) || 1;

                        // Build cumulative syllable-proportion thresholds — words with more syllables get more time
                        let cumSyllables = 0;
                        const wordThresholds = wordTokens.map(w => {
                            cumSyllables += estimateSyllables(w);
                            return cumSyllables / totalSyllables;
                        });

                        let activeWordIdx = -1;
                        if (isHighlighted) {
                            const found = wordThresholds.findIndex(t => t > sentenceProgress);
                            activeWordIdx = found === -1 ? wordTokens.length - 1 : found;
                        }
                        let currentWordCount = 0;

                        const wordElements = words.map((chunk, chunkIdx) => {
                            if (chunk.trim().length === 0) {
                                return <span key={chunkIdx}>{chunk}</span>;
                            }
                            const isWordActive = isHighlighted && currentWordCount === activeWordIdx;
                            const isWordPast = (isHighlighted && currentWordCount < activeWordIdx) || (idx < currentSentenceIdx);

                            let wordClass = 'word';
                            if (isWordActive) wordClass += ' current';
                            else if (isWordPast) wordClass += ' spoken';

                            currentWordCount++;
                            return <span key={chunkIdx} className={wordClass}>{chunk}</span>;
                        });

                        return (
                            <div
                                key={idx}
                                ref={(el) => { sentenceRefs.current[idx] = el; }}
                                className={`sentence ${isHighlighted ? 'active' : ''}`}
                                onClick={() => handleSeek(idx)}
                                role="button"
                                tabIndex={0}
                                aria-label={`Play sentence ${idx + 1}`}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        handleSeek(idx);
                                    }
                                }}
                            >
                                {wordElements}
                            </div>
                        );
                    })}
                </div>
                {lastError && (
                    <div className="reader-error">
                        Error: {lastError}
                    </div>
                )}
            </div>

            {/* PLAYER BAR */}
            <div className="player">
                <button
                    className="p-btn"
                    onClick={() => handleSeek(Math.max(0, currentSentenceIdx - 1))}
                    disabled={currentSentenceIdx <= 0}
                    aria-label="Previous sentence"
                >
                    <SkipBack size={16} />
                </button>
                <button
                    className="p-play"
                    onClick={togglePlay}
                    aria-label="Play or Pause"
                >
                    {playbackState === 'playing' ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="play-icon-offset" />}
                </button>
                <button
                    className="p-btn"
                    onClick={() => handleSeek(Math.min(sentences.length - 1, currentSentenceIdx + 1))}
                    disabled={currentSentenceIdx >= sentences.length - 1}
                    aria-label="Next sentence"
                >
                    <SkipForward size={16} />
                </button>

                <div className="p-divider"></div>

                <div className="p-speed" onClick={handleSpeedToggle} aria-label="Toggle Speed">
                    {speed}×
                </div>

                <div className="p-divider"></div>

                <div className="p-voice" onClick={() => setIsDropdownOpen(!isDropdownOpen)}>
                    <div className={`p-wave ${playbackState === 'playing' ? 'playing' : ''}`}>
                        <div className="pw"></div><div className="pw"></div>
                        <div className="pw"></div><div className="pw"></div>
                    </div>
                    {voiceUI}

                    {/* Voice Selection Dropdown */}
                    <div className={`p-voice-dropdown ${isDropdownOpen ? 'open' : ''}`}>
                        {(['onyx', 'echo', 'fable', 'nova', 'shimmer', 'alloy'] as TTSVoice[]).map(v => (
                            <div
                                key={v}
                                className={`p-vopt ${voiceUI === v ? 'sel' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleVoiceChange(v);
                                    setIsDropdownOpen(false);
                                }}
                            >
                                {v}
                            </div>
                        ))}
                    </div>
                </div>

                <div className="p-divider" style={{ marginRight: '8px' }}></div>

                <div className="p-progress" onClick={handleSeekClick}>
                    <div className="p-fill" style={{ '--p-fill-width': `${overallProgressPct}%` } as React.CSSProperties}></div>
                </div>
            </div>
        </div>
    );
}
