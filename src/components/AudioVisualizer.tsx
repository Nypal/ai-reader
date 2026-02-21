import { useEffect, useRef, useState } from 'react';
import './AudioVisualizer.css';

interface AudioVisualizerProps {
    audioElement: HTMLAudioElement | null;
    isPlaying: boolean;
    onClick?: () => void;
}

const NUM_BARS = 5;

export default function AudioVisualizer({ audioElement, isPlaying, onClick }: AudioVisualizerProps) {
    const [barHeights, setBarHeights] = useState<number[]>(new Array(NUM_BARS).fill(20));

    // Store web audio contexts safely to prevent memory leaks across re-renders
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    useEffect(() => {
        if (!audioElement) return;

        try {
            if (!audioCtxRef.current) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
                const ctx = new AudioContext();
                audioCtxRef.current = ctx;

                const analyser = ctx.createAnalyser();
                analyser.fftSize = 64; // Small FFT size for 5 broad buckets
                analyser.smoothingTimeConstant = 0.8;
                analyserRef.current = analyser;

                const source = ctx.createMediaElementSource(audioElement);
                sourceRef.current = source;

                source.connect(analyser);
                analyser.connect(ctx.destination);
            }
        } catch (e) {
            console.debug("[PlayLearn] AudioContext initialization failed or already connected:", e);
        }

        // Cleanup isn't strict here since HTMLAudioElement lives for the component lifecycle
        // Re-connecting a MediaElementSource will throw an error, which we catch above
    }, [audioElement]);

    useEffect(() => {
        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        if (prefersReducedMotion || !isPlaying || !analyserRef.current) {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            if (!isPlaying && !prefersReducedMotion) {
                requestAnimationFrame(() => {
                    setBarHeights(new Array(NUM_BARS).fill(20));
                });
            }
            return;
        }

        // Attempt to resume audio context if browser suspended it before user interaction
        if (audioCtxRef.current?.state === 'suspended') {
            audioCtxRef.current.resume();
        }

        const analyser = analyserRef.current;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            animationFrameRef.current = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);

            // We only need 5 bars
            // Divide the bufferLength (32 for fft 64) into 5 chunks
            const step = Math.floor(bufferLength / NUM_BARS);
            const newHeights = [];

            for (let i = 0; i < NUM_BARS; i++) {
                let sum = 0;
                // Average the frequencies in this bucket
                for (let j = 0; j < step; j++) {
                    sum += dataArray[(i * step) + j];
                }
                const average = sum / step;

                // Map 0-255 to a baseline 20% height up to 100%
                const heightPercent = 20 + (average / 255) * 80;
                newHeights.push(heightPercent);
            }

            setBarHeights(newHeights);
        };

        draw();

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [isPlaying]);

    return (
        <div
            className={`audio-visualizer ${isPlaying ? 'playing' : ''} ${onClick ? 'interactive' : ''}`}
            aria-hidden="true"
            onClick={onClick}
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={(e) => {
                if (onClick && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onClick();
                }
            }}
        >
            {barHeights.map((height, i) => (
                <div
                    key={i}
                    className="bar"
                    style={{ height: `${height}%` }}
                />
            ))}
        </div>
    );
}
