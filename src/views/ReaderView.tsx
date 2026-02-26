import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Settings2, SkipBack, SkipForward, Play, Pause, Activity } from 'lucide-react';
import { useSentenceSplitter } from '../hooks/useSentenceSplitter';
import { AuditService } from '../services/AuditService';
import AudioVisualizer from '../components/AudioVisualizer';
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

const LOOKAHEAD = 2;
const MAX_CACHE = 4;

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
    const [ttsLatencyAvg, setTtsLatencyAvg] = useState(0);
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
        const fetchStartMs = nowMs();
        console.log(`[PlayLearn] fetching TTS for chunk: "${text}"`);
        const res = await fetch('http://localhost:3001/api/tts', {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, voice: voiceRef.current, language: readingLanguage, format: "mp3" }),
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

        return { buf: buf, contentType: assertAudioContentType(ct) };
    }, [isSlowBackend, readingLanguage]);

    const ensurePrefetchWindow = useCallback(
        async (baseIdx: number, myRunId: number) => {
            const targets: number[] = [];
            for (let k = 1; k <= LOOKAHEAD; k++) {
                const j = baseIdx + k;
                if (j < sentencesSpoken.length) targets.push(j);
            }

            for (const j of targets) {
                if (isStoppedRef.current || runIdRef.current !== myRunId) return;
                if (cacheRef.current.has(j)) continue;

                // evict oldest
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

        // Queue prefetches in background
        void ensurePrefetchWindow(idx, runIdAtStart);

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
            inFlightPlayRef.current = a.play();
            await inFlightPlayRef.current;
            console.log(`[PlayLearn] play started idx=${idx} ttfs_ms=${Math.round(nowMs() - t0)}ms`);
        } catch (e: unknown) {
            setPlaybackState("error");
            const errName = e instanceof Error ? e.name : "Error";
            const errMsg = e instanceof Error ? e.message : String(e);
            const errorMsg = `play() rejected: ${errName} ${errMsg}`;
            console.error(errorMsg);
            setLastError(errorMsg);
            alert(`Audio blocked or failed: ${errorMsg}`);
        } finally {
            inFlightPlayRef.current = null;
        }

    }, [fetchTts, ensurePrefetchWindow, speed, onFinish, sentences, sentencesSpoken]);

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
        if (sentences.length > 0 && playbackState === 'idle') {
            const timer = setTimeout(() => {
                // Ensure we only try to play if we are still idle
                if (isStoppedRef.current) {
                    runIdRef.current += 1;
                    isStoppedRef.current = false;
                    setLastError(null);
                    abortRef.current = new AbortController();
                    playIndex(0, runIdRef.current).catch((e: unknown) => {
                        setPlaybackState("error");
                        setLastError(e instanceof Error ? e.message : String(e));
                    });
                }
            }, 100); // slight delay to allow audio element to mount
            return () => clearTimeout(timer);
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

    const resetPlay = () => {
        stop();
    };

    const handleSeek = (newIdx: number) => {
        replayCountRef.current += 1;
        const wasPlaying = playbackState === 'playing' || playbackState === 'loading';
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

    const renderText = () => {
        return sentences.map((sentence, idx) => {
            const isHighlighted = idx === currentSentenceIdx;
            const words = sentence.split(/(\s+)/); // Keep delimiters to preserve spacing
            const wordCount = words.filter(w => w.trim().length > 0).length;
            const activeWordIdx = isHighlighted ? Math.floor(wordCount * sentenceProgress) : -1;

            let currentWordCount = 0;

            const wordElements = words.map((chunk, chunkIdx) => {
                if (chunk.trim().length === 0) {
                    return <span key={chunkIdx} className="space-chunk">{chunk}</span>;
                }

                const isWordActive = isHighlighted && currentWordCount === activeWordIdx;
                const isWordPast = isHighlighted && currentWordCount < activeWordIdx;

                let wordClass = "word";
                if (isWordActive) wordClass += " active-word";
                else if (isWordPast) wordClass += " past-word";
                else wordClass += " future-word";

                currentWordCount++;

                return (
                    <span key={chunkIdx} className={wordClass}>
                        {chunk}
                    </span>
                );
            });

            return (
                <motion.span
                    key={idx}
                    ref={(el) => { sentenceRefs.current[idx] = el; }}
                    className="sentence"
                    data-active={isHighlighted ? "true" : undefined}
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
                    initial={{ opacity: 0.5, y: 0 }}
                    animate={isHighlighted ? {
                        opacity: 1,
                        y: -1,
                        backgroundColor: "rgba(139, 92, 246, 0.14)",
                        borderLeftColor: "var(--primary)"
                    } : {
                        opacity: 0.5,
                        y: 0,
                        backgroundColor: "transparent",
                        borderLeftColor: "transparent"
                    }}
                    transition={{
                        duration: 0.3,
                        ease: "easeInOut"
                    }}
                >
                    {wordElements}
                </motion.span>
            );
        });
    };

    return (
        <div className="view-container reader-view">
            <div className="progress-container top-progress">
                <input
                    type="range"
                    className="progress-slider"
                    min={0}
                    max={sentences.length > 0 ? sentences.length - 1 : 0}
                    value={Math.max(0, currentSentenceIdx)}
                    style={{ backgroundSize: `${sentences.length ? (Math.max(0, currentSentenceIdx) / (sentences.length - 1)) * 100 : 0}% 100%` }}
                    onChange={(e) => handleSeek(Number(e.target.value))}
                    aria-valuemin={0}
                    aria-valuemax={sentences.length > 0 ? sentences.length - 1 : 0}
                    aria-valuenow={Math.max(0, currentSentenceIdx)}
                    aria-label="Reading progress"
                    disabled={sentences.length === 0}
                />
            </div>

            <div className="reader-header" style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, 1fr) auto minmax(100px, 1fr)', alignItems: 'center' }}>
                <div style={{ justifySelf: 'start' }}>
                    <button className="back-btn" onClick={handleBack}>
                        <ArrowLeft size={20} />
                        <span>Back</span>
                    </button>
                </div>

                <div style={{ justifySelf: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <AudioVisualizer
                        audioElement={audioRef.current}
                        isPlaying={playbackState === 'playing'}
                        onClick={togglePlay}
                    />
                </div>

                <div className="header-actions" style={{ justifySelf: 'end', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    {isSlowBackend && (
                        <div className="slow-backend-warning glass-panel" style={{ color: 'var(--warning)', fontSize: '0.75rem', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid rgba(234, 179, 8, 0.2)' }} title={`High Latency Detected (~${Math.round(ttsLatencyAvg)}ms)`}>
                            <Activity size={12} /> <span className="hide-mobile">Slow Connection</span>
                        </div>
                    )}
                    <button className="settings-btn" title="Audio Settings">
                        <Settings2 size={20} />
                    </button>
                </div>
            </div>



            <div className="reader-content" data-has-active={currentSentenceIdx >= 0}>
                <p className="reading-text">
                    {renderText()}
                </p>
                {lastError && (
                    <div style={{ color: 'red', marginTop: '1rem', fontSize: '0.9rem' }}>
                        Error: {lastError}
                    </div>
                )}
            </div>

            <div className="reader-controls-pill">
                <div className="pill-left">
                    <button
                        className="control-btn"
                        onClick={() => handleSeek(Math.max(0, currentSentenceIdx - 1))}
                        disabled={currentSentenceIdx <= 0}
                        aria-label="Previous sentence"
                    >
                        <SkipBack size={20} />
                    </button>
                    <button
                        className="control-btn play-btn"
                        onClick={togglePlay}
                        aria-label="Play or Pause"
                    >
                        {playbackState === 'playing' ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
                    </button>
                    <button
                        className="control-btn"
                        onClick={() => handleSeek(Math.min(sentences.length - 1, currentSentenceIdx + 1))}
                        disabled={currentSentenceIdx >= sentences.length - 1}
                        aria-label="Next sentence"
                    >
                        <SkipForward size={20} />
                    </button>
                </div>

                <div className="pill-right">
                    <button className="speed-toggle" onClick={handleSpeedToggle} aria-label="Toggle Speed">
                        <AnimatePresence mode="popLayout">
                            <motion.span
                                key={speed}
                                initial={{ y: 15, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={{ y: -15, opacity: 0 }}
                                transition={{ duration: 0.15, ease: "easeInOut" }}
                                style={{ display: 'inline-block' }}
                            >
                                {speed}x
                            </motion.span>
                        </AnimatePresence>
                    </button>
                    <div className="voice-selector">
                        <select
                            value={voiceUI}
                            onChange={(e) => handleVoiceChange(e.target.value as TTSVoice)}
                            className="voice-select"
                            aria-label="Narrator voice"
                        >
                            <option value="onyx">Onyx</option>
                            <option value="echo">Echo</option>
                            <option value="fable">Fable</option>
                            <option value="nova">Nova</option>
                            <option value="shimmer">Shimmer</option>
                            <option value="alloy">Alloy</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    );
}
