import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
    earnXP as storeEarnXP,
    completeQuest,
    getSnapshot,
    getLevelIndex,
    levelProgress,
    subscribe,
    LEVELS,
    type GameState,
    type XpEvent,
    type Badge,
} from '../store/gameStore';
import './ArenaView.css';

interface ArenaViewProps {
    onBack: () => void;
}

// ── Toast state ───────────────────────────────────────────────
interface ToastState {
    icon: string;
    title: string;
    sub: string;
    show: boolean;
}

// ── Level-up state ────────────────────────────────────────────
interface LevelUpState {
    show: boolean;
    levelIdx: number;
}

// ── Floating XP number ────────────────────────────────────────
interface FloatXP {
    id: number;
    text: string;
    x: number;
    y: number;
}

// ── Combo badge ───────────────────────────────────────────────
interface ComboState {
    text: string;
    show: boolean;
}

// ─────────────────────────────────────────────────────────────
export default function ArenaView({ onBack }: ArenaViewProps) {
    const [gs, setGs] = useState<GameState>(getSnapshot);
    const [toast, setToast] = useState<ToastState>({ icon: '⭐', title: '', sub: '', show: false });
    const [levelUp, setLevelUp] = useState<LevelUpState>({ show: false, levelIdx: 0 });
    const [floats, setFloats] = useState<FloatXP[]>([]);
    const [combo, setCombo] = useState<ComboState>({ text: '', show: false });
    const [particles, setParticles] = useState<boolean>(false);
    const floatId = useRef(0);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const comboHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Subscribe to store changes
    useEffect(() => {
        return subscribe((state, event) => {
            setGs({ ...state });
            if (event) handleXpEvent(event);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Handle XP event from store ──────────────────────────────
    const handleXpEvent = useCallback((ev: XpEvent) => {
        // Floating XP
        if (ev.clientX !== undefined && ev.clientY !== undefined) {
            const id = ++floatId.current;
            const text = `+${ev.xpAdded} XP${ev.multiplier > 1 ? ` ×${ev.multiplier.toFixed(1)}` : ''}`;
            setFloats(prev => [...prev, { id, text, x: ev.clientX!, y: ev.clientY! }]);
            setTimeout(() => setFloats(prev => prev.filter(f => f.id !== id)), 1200);
        }

        // Combo badge
        if (ev.combo >= 2) {
            const emoji = ev.combo >= 5 ? '🔥' : ev.combo >= 3 ? '⚡' : '🎯';
            const text = `${emoji} ${ev.combo}× Combo!`;
            setCombo({ text, show: true });
            if (comboHideTimer.current) clearTimeout(comboHideTimer.current);
            comboHideTimer.current = setTimeout(() => setCombo(s => ({ ...s, show: false })), 2500);
        }

        // Level up overlay
        if (ev.leveledUp) {
            setTimeout(() => {
                setLevelUp({ show: true, levelIdx: ev.newLevelIndex });
                setParticles(true);
                setTimeout(() => setParticles(false), 6000);
            }, 800);
        }
    }, []);

    // ── Show toast ──────────────────────────────────────────────
    const showToast = useCallback((icon: string, title: string, sub: string) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ icon, title, sub, show: true });
        toastTimer.current = setTimeout(() => setToast(s => ({ ...s, show: false })), 2800);
    }, []);

    // ── Earn XP (triggered from action cards) ──────────────────
    const handleEarnXP = (
        base: number,
        toastTitle: string,
        toastSub: string,
        isCorrect: boolean,
        e: React.MouseEvent,
    ) => {
        const ev = storeEarnXP(base, isCorrect, e.clientX, e.clientY);
        showToast(isCorrect ? '⭐' : '💪', `+${ev.xpAdded} XP`, toastSub);

        // Quest progression
        if (toastSub.toLowerCase().includes('reading')) {
            const allDone = completeQuest(0);
            if (allDone) setTimeout(() => {
                showToast('🎉', '+100 XP Bonus!', 'Daily quest complete!');
                storeEarnXP(100, true);
            }, 600);
        }
        if (toastSub.toLowerCase().includes('quiz')) {
            completeQuest(1);
        }
        if (toastSub.toLowerCase().includes('feynman')) {
            completeQuest(2);
        }

        void toastTitle; // suppress unused warning — used in floating XP
    };

    // ── Computed HUD values ─────────────────────────────────────
    const lvlIdx = getLevelIndex(gs.totalXP);
    const lvl = LEVELS[lvlIdx];
    const nextLvl = LEVELS[Math.min(lvlIdx + 1, LEVELS.length - 1)];
    const pct = Math.round(levelProgress(gs.totalXP) * 100);
    const xpInLvl = gs.totalXP - lvl.min;
    const xpNeeded = nextLvl.min - lvl.min;

    // Quest progress
    const questCount = gs.questDone.filter(Boolean).length;
    const questPct = Math.round((questCount / 3) * 100);

    // Leaderboard your-row XP
    const yourXP = gs.totalXP;

    return (
        <div className="arena-page">
            <div className="arena-bg-glow" />

            {/* ── Particles ── */}
            {particles && <ParticleSystem />}

            {/* ── XP Toast ── */}
            <div className={`arena-xp-toast${toast.show ? ' show' : ''}`}>
                <div className="toast-icon-box">{toast.icon}</div>
                <div className="toast-body">
                    <div className="toast-title">{toast.title}</div>
                    <div className="toast-sub">{toast.sub}</div>
                </div>
            </div>

            {/* ── Combo Badge ── */}
            <div className={`arena-combo-badge${combo.show ? ' show' : ''}`}>
                {combo.text}
            </div>

            {/* ── Floating XP numbers ── */}
            {floats.map(f => (
                <div
                    key={f.id}
                    className="arena-float-xp"
                    style={{ left: f.x - 30, top: f.y - 20 }}
                >
                    {f.text}
                </div>
            ))}

            {/* ── Level-Up Overlay ── */}
            <div className={`arena-levelup-overlay${levelUp.show ? ' show' : ''}`}
                onClick={e => { if (e.target === e.currentTarget) setLevelUp(s => ({ ...s, show: false })); }}
            >
                <div className="arena-levelup-card">
                    <span className="arena-levelup-sparkle">✦</span>
                    <div className="arena-levelup-title">LEVEL UP!</div>
                    <div className="arena-levelup-name">
                        {LEVELS[levelUp.levelIdx]?.emoji} You are now a {LEVELS[levelUp.levelIdx]?.name}
                    </div>
                    <div className="arena-levelup-sub">Keep going — every session makes you stronger.</div>
                    <button
                        className="arena-levelup-btn"
                        onClick={() => setLevelUp(s => ({ ...s, show: false }))}
                    >
                        Continue →
                    </button>
                </div>
            </div>

            {/* ── HUD ── */}
            <div className="arena-hud">
                <div className="arena-hud-brand">Alphie</div>

                <div
                    className="arena-streak-pill"
                    onClick={() => showToast('🔥', `${gs.streak}-Day Streak!`, "Keep going — don't break it!")}
                >
                    <span className="streak-fire">🔥</span>
                    <span>{gs.streak}</span>&nbsp;day streak
                </div>

                <div className="arena-xp-section">
                    <div className="arena-xp-labels">
                        <span>{lvl.emoji} {lvl.name}</span>
                        <span>{xpInLvl} / {xpNeeded} XP</span>
                    </div>
                    <div className="arena-xp-bar-wrap">
                        <div className="arena-xp-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                </div>

                <div className="arena-level-badge">⭐ Lv.{lvlIdx + 1}</div>
                <div className="arena-total-xp">✦ {gs.totalXP.toLocaleString()}</div>
            </div>

            {/* ── Main ── */}
            <div className="arena-main">

                {/* Back */}
                <button className="arena-back-btn" onClick={onBack}>
                    <ArrowLeft size={15} /> Back to Reader
                </button>

                {/* ── Daily Quest ── */}
                <div className="arena-section-head">
                    <div className="arena-section-label">Today's Mission</div>
                    <div className="arena-section-title">Daily Quest</div>
                    <div className="arena-section-sub">Complete all 3 tasks to earn your daily bonus XP.</div>
                </div>

                <div className="arena-quest-card">
                    <div className="arena-quest-header">
                        <div className="arena-quest-title">📅 Daily Scholar Challenge</div>
                        <div className="arena-quest-reward">✦ +100 XP Bonus</div>
                    </div>
                    <div className="arena-quest-tasks">
                        {(['Complete 1 reading session', 'Answer 3 quiz questions correctly', 'Complete the Feynman Test'] as const).map((label, i) => (
                            <div key={i} className={`arena-quest-task${gs.questDone[i] ? ' done' : ''}`}>
                                <div className={`arena-qt-check${gs.questDone[i] ? ' done' : ''}`}>
                                    {gs.questDone[i] ? '✓' : ''}
                                </div>
                                {label}
                            </div>
                        ))}
                    </div>
                    <div className="arena-quest-progress">
                        <div className="arena-qp-label">
                            <span>Progress</span>
                            <span>{questCount} / 3 tasks</span>
                        </div>
                        <div className="arena-qp-bar">
                            <div className="arena-qp-fill" style={{ width: `${questPct}%` }} />
                        </div>
                    </div>
                </div>

                {/* ── Earn XP Actions ── */}
                <div className="arena-section-head" style={{ marginTop: 8 }}>
                    <div className="arena-section-label">Try It Now</div>
                    <div className="arena-section-title">Earn XP</div>
                    <div className="arena-section-sub">Each action rewards you. Chain correct answers for a combo multiplier.</div>
                </div>

                <div className="arena-actions-grid">
                    {ACTION_CARDS.map(card => (
                        <button
                            key={card.id}
                            className="arena-action-card"
                            onClick={e => handleEarnXP(card.xp, card.toastTitle, card.sub, card.isCorrect, e)}
                        >
                            <div className="ac-icon">{card.icon}</div>
                            <div className="ac-name">{card.name}</div>
                            <div className="ac-sub">{card.sub}</div>
                            <div className="ac-xp">✦ +{card.xp} XP</div>
                        </button>
                    ))}
                </div>

                {/* ── Badges ── */}
                <div className="arena-section-head">
                    <div className="arena-section-label">Your Collection</div>
                    <div className="arena-section-title">Badges</div>
                    <div className="arena-section-sub">Earn badges by reaching milestones.</div>
                </div>

                <div className="arena-badges-grid">
                    {gs.badges.map((badge: Badge) => (
                        <div
                            key={badge.id}
                            className={`arena-badge-item${badge.unlocked ? '' : ' locked'}`}
                            title={badge.title}
                            onClick={() => {
                                if (badge.unlocked) showToast(badge.icon, badge.name, badge.title);
                            }}
                        >
                            <div className={`arena-badge-icon ${badge.color}`}>{badge.icon}</div>
                            <div className="arena-badge-name">{badge.name}</div>
                        </div>
                    ))}
                </div>

                {/* ── Leaderboard ── */}
                <div className="arena-section-head">
                    <div className="arena-section-label">This Week</div>
                    <div className="arena-section-title">Leaderboard</div>
                    <div className="arena-section-sub">Weekly XP resets every Monday. Push to the top.</div>
                </div>

                <div className="arena-leaderboard">
                    {LEADERBOARD.map((row, i) => (
                        <div key={i} className={`arena-lb-row${row.isYou ? ' you' : ''}`}>
                            <div className={`arena-lb-rank${row.rankClass ? ` ${row.rankClass}` : ''}${row.isYou ? ' you' : ''}`}>
                                {row.rank}
                            </div>
                            <div className="arena-lb-avatar">{row.avatar}</div>
                            <div className="arena-lb-info">
                                <div className="arena-lb-name">
                                    {row.name}
                                    {row.isYou && <span className="arena-lb-you-tag">← YOU</span>}
                                </div>
                                <div className="arena-lb-level">⭐ Lv.{row.level} · {row.levelName}</div>
                            </div>
                            <div className="arena-lb-xp">
                                ✦ {row.isYou ? yourXP.toLocaleString() : row.xp.toLocaleString()}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Gap note */}
                <div className="arena-lb-gap-note">
                    You're <strong style={{ color: 'var(--accent)' }}>
                        {Math.max(0, 1890 - yourXP).toLocaleString()} XP
                    </strong> away from 3rd place 🚀
                </div>

            </div>
        </div>
    );
}

// ── Particle System ───────────────────────────────────────────
function ParticleSystem() {
    const colors = ['#FFD60A', '#7B6EF6', '#34C759', '#FF9500', '#06B6D4', '#FF453A', '#9B8BFF'];
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const particles = useMemo(() => Array.from({ length: 60 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        width: 4 + Math.random() * 8,
        height: 4 + Math.random() * 8,
        color: colors[Math.floor(Math.random() * colors.length)],
        duration: 2 + Math.random() * 3,
        delay: Math.random() * 1.5,
        isCircle: Math.random() > 0.5,
    })), []);

    return (
        <div className="arena-particles">
            {particles.map(p => (
                <div
                    key={p.id}
                    className="arena-particle"
                    style={{
                        left: `${p.left}vw`,
                        top: '-10px',
                        width: p.width,
                        height: p.height,
                        background: p.color,
                        borderRadius: p.isCircle ? '50%' : '2px',
                        animationDuration: `${p.duration}s`,
                        animationDelay: `${p.delay}s`,
                    }}
                />
            ))}
        </div>
    );
}

// ── Static data ───────────────────────────────────────────────
const ACTION_CARDS = [
    { id: 'correct', icon: '🧠', name: 'Correct Answer', sub: 'Quiz question', toastTitle: '✅ Correct!', xp: 15, isCorrect: true },
    { id: 'perfect', icon: '🏆', name: 'Perfect Quiz', sub: 'All answers correct', toastTitle: '🏆 Perfect Score!', xp: 50, isCorrect: true },
    { id: 'feynman', icon: '🔬', name: 'Feynman Test', sub: 'Explain in your words', toastTitle: '🔬 Feynman Done!', xp: 20, isCorrect: true },
    { id: 'voice', icon: '🎙', name: 'Voice Feynman', sub: 'Speak your explanation', toastTitle: '🎙 Voice Master!', xp: 25, isCorrect: true },
    { id: 'retry', icon: '💪', name: 'Retry & Improve', sub: 'Failed then tried again', toastTitle: '💪 Resilience!', xp: 10, isCorrect: false },
    { id: 'reading', icon: '📖', name: 'Reading Session', sub: 'Complete a reading', toastTitle: '📖 Session Done!', xp: 10, isCorrect: false },
];

const LEADERBOARD = [
    { rank: '🥇', rankClass: 'top1', avatar: '😎', name: 'Marcus T.', level: 5, levelName: 'Sage', xp: 2840, isYou: false },
    { rank: '🥈', rankClass: 'top2', avatar: '🎓', name: 'Sarah K.', level: 4, levelName: 'Master', xp: 2210, isYou: false },
    { rank: '🥉', rankClass: 'top3', avatar: '📚', name: 'Amir B.', level: 4, levelName: 'Master', xp: 1890, isYou: false },
    { rank: '4', rankClass: '', avatar: '✦', name: 'You', level: 3, levelName: 'Scholar', xp: 1340, isYou: true },
    { rank: '5', rankClass: '', avatar: '🌟', name: 'Priya M.', level: 3, levelName: 'Scholar', xp: 980, isYou: false },
];
