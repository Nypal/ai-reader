import { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, Square, ArrowLeft, Settings2 } from 'lucide-react';
import { useSentenceSplitter } from '../hooks/useSentenceSplitter';
import AudioVisualizer from '../components/AudioVisualizer';
import './ReaderView.css';

interface ReaderViewProps {
    content: string;
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

export default function ReaderView({ content, onFinish, onBack }: ReaderViewProps) {
    const effectiveContent = content?.trim() || "Hello, this is a playback test.";
    const { original: sentences, spoken: sentencesSpoken } = useSentenceSplitter(effectiveContent);

    const [playbackState, setPlaybackState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'error'>('idle');
    const [currentSentenceIdx, setCurrentSentenceIdx] = useState(-1);
    const [speed, setSpeed] = useState(1);
    const [lastError, setLastError] = useState<string | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const runIdRef = useRef(0);
    const isStoppedRef = useRef(true);
    const currentObjectUrlRef = useRef<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const inFlightPlayRef = useRef<Promise<void> | null>(null);

    const cacheRef = useRef<Map<number, CacheItem>>(new Map());
    const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([]);

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

        a.onplaying = () => {
            if (isStoppedRef.current) return;
            setPlaybackState("playing");
        };
        a.onpause = () => {
            if (isStoppedRef.current) return;
            setPlaybackState((s) => (s === "playing" ? "paused" : s));
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
        console.log(`[PlayLearn] fetching TTS for chunk: "${text}"`);
        const res = await fetch('http://localhost:3001/api/tts', {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, voice: "alloy", format: "mp3" }),
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

        return { buf: buf, contentType: assertAudioContentType(ct) };
    }, []);

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
            onFinish();
            return;
        }

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
        if (audioRef.current) {
            audioRef.current.playbackRate = speed;
        }
    }, [speed]);

    useEffect(() => {
        return () => stop();
    }, [stop]);

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

    const handleBack = () => {
        stop();
        onBack();
    };

    const renderText = () => {
        return sentences.map((sentence, idx) => {
            const isHighlighted = idx === currentSentenceIdx;
            return (
                <span
                    key={idx}
                    ref={(el) => { sentenceRefs.current[idx] = el; }}
                    className={isHighlighted ? "highlighted-sentence" : ""}
                    style={{ transition: 'background-color 0.2s' }}
                >
                    {sentence}{" "}
                </span>
            );
        });
    };

    const uiStatusText = playbackState === 'loading' ? 'Loading AI Voice...' :
        playbackState === 'playing' ? 'Reading...' :
            playbackState === 'paused' ? 'Paused' :
                playbackState === 'error' ? 'Error' :
                    playbackState === 'completed' ? 'Finished' : 'Stopped';

    return (
        <div className="view-container reader-view">
            <div className="reader-header flex-between">
                <button className="back-btn" onClick={handleBack}>
                    <ArrowLeft size={20} />
                    <span>Stop & Back</span>
                </button>
                <div className="reader-status">
                    <span className={`status-dot ${playbackState === 'playing' ? 'active' : ''} ${playbackState === 'loading' ? 'buffering' : ''}`}></span>
                    {uiStatusText}
                </div>
                <button className="settings-btn" title="Audio Settings">
                    <Settings2 size={20} />
                </button>
            </div>

            <div className="reader-content">
                <AudioVisualizer
                    audioElement={audioRef.current}
                    isPlaying={playbackState === 'playing'}
                />
                <p className="reading-text">
                    {renderText()}
                </p>
                {lastError && (
                    <div style={{ color: 'red', marginTop: '1rem', fontSize: '0.9rem' }}>
                        Error: {lastError}
                    </div>
                )}
            </div>

            <div className="reader-controls-wrapper">
                <div className="speed-control">
                    <select
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                        className="speed-select"
                    >
                        <option value={0.75}>0.75x</option>
                        <option value={1}>1.0x</option>
                        <option value={1.25}>1.25x</option>
                        <option value={1.5}>1.5x</option>
                        <option value={2}>2.0x</option>
                    </select>
                </div>

                <div className="main-controls">
                    <button className="control-btn secondary" onClick={resetPlay} disabled={(playbackState === 'idle' || playbackState === 'completed') && currentSentenceIdx === 0}>
                        <Square size={24} />
                    </button>
                    <button className="control-btn primary" onClick={togglePlay} disabled={playbackState === 'loading'}>
                        {playbackState === 'playing' ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" />}
                    </button>
                </div>

                <div className="spacer"></div>
            </div>
        </div>
    );
}
