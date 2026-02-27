// ─────────────────────────────────────────────────────────────
//  Alphie Game Store  —  lightweight reactive game-state module
//  No external lib needed; uses a simple observer pattern so
//  any component can subscribe to changes.
// ─────────────────────────────────────────────────────────────

export interface Level {
    name: string;
    emoji: string;
    min: number;     // XP threshold to enter this level
    max: number;
}

export const LEVELS: Level[] = [
    { name: 'Curious', emoji: '🌱', min: 0, max: 199 },
    { name: 'Thinker', emoji: '💭', min: 200, max: 499 },
    { name: 'Scholar', emoji: '📚', min: 500, max: 999 },
    { name: 'Master', emoji: '🎓', min: 1000, max: 1999 },
    { name: 'Sage', emoji: '🧙', min: 2000, max: 99999 },
];

export interface Badge {
    id: string;
    icon: string;
    name: string;
    color: 'gold' | 'violet' | 'green' | 'cyan';
    title: string;
    unlocked: boolean;
}

export interface GameState {
    totalXP: number;
    levelIndex: number;   // 0-indexed into LEVELS
    streak: number;
    combo: number;
    questDone: [boolean, boolean, boolean];
    badges: Badge[];
}

// ── XP Event ──────────────────────────────────────────────────
export interface XpEvent {
    xpAdded: number;
    basXP: number;
    multiplier: number;
    newTotal: number;
    leveledUp: boolean;
    newLevelIndex: number;
    combo: number;
    isCorrect: boolean;
    clientX?: number;
    clientY?: number;
}

// ── Internal store ────────────────────────────────────────────
const _state: GameState = {
    totalXP: 340,
    levelIndex: 2,   // Scholar
    streak: 3,
    combo: 0,
    questDone: [true, false, false],
    badges: [
        { id: 'first-steps', icon: '📖', name: 'First Steps', color: 'violet', title: 'Completed your first reading session', unlocked: true },
        { id: 'on-fire', icon: '🔥', name: 'On Fire', color: 'gold', title: '3-day streak achieved', unlocked: true },
        { id: 'perfectionist', icon: '🏆', name: 'Perfectionist', color: 'gold', title: '100% on a quiz', unlocked: true },
        { id: 'power-reader', icon: '⚡', name: 'Power Reader', color: 'violet', title: 'Complete 5 sessions', unlocked: false },
        { id: 'voice-master', icon: '🎙', name: 'Voice Master', color: 'cyan', title: 'Use Voice Feynman', unlocked: false },
        { id: 'bilingue', icon: '🇫🇷', name: 'Bilingue', color: 'cyan', title: 'Read in French', unlocked: false },
        { id: 'week-warrior', icon: '⭐', name: 'Week Warrior', color: 'gold', title: '7-day streak', unlocked: false },
        { id: 'sage', icon: '🧙', name: 'Sage', color: 'gold', title: 'Reach level 5', unlocked: false },
    ],
};

type Listener = (state: GameState, event: XpEvent | null) => void;
const _listeners: Set<Listener> = new Set();

let _comboTimer: ReturnType<typeof setTimeout> | null = null;

// ── Subscribe / Unsubscribe ────────────────────────────────────
export function subscribe(fn: Listener): () => void {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _notify(event: XpEvent | null) {
    _listeners.forEach(fn => fn({ ..._state, badges: [..._state.badges] }, event));
}

// ── Level helpers ─────────────────────────────────────────────
export function getLevelIndex(xp: number): number {
    for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (xp >= LEVELS[i].min) return i;
    }
    return 0;
}

export function getSnapshot(): GameState {
    return { ..._state, badges: [..._state.badges] };
}

/** Progress inside current level as 0-1 */
export function levelProgress(xp: number): number {
    const idx = getLevelIndex(xp);
    const lvl = LEVELS[idx];
    const next = LEVELS[Math.min(idx + 1, LEVELS.length - 1)];
    if (next === lvl) return 1;
    return Math.min((xp - lvl.min) / (next.min - lvl.min), 1);
}

// ── Core: earn XP ─────────────────────────────────────────────
export function earnXP(
    base: number,
    isCorrect: boolean,
    clientX?: number,
    clientY?: number,
): XpEvent {
    // Combo
    if (isCorrect) {
        _state.combo++;
        if (_comboTimer) clearTimeout(_comboTimer);
        _comboTimer = setTimeout(() => { _state.combo = 0; }, 4000);
    } else {
        _state.combo = 0;
        if (_comboTimer) { clearTimeout(_comboTimer); _comboTimer = null; }
    }

    // Multiplier
    let mult = 1;
    if (_state.combo >= 5) mult = 2.0;
    else if (_state.combo >= 3) mult = 1.5;

    // Streak bonus
    if (_state.streak >= 7) mult *= 1.5;
    else if (_state.streak >= 3) mult *= 1.2;

    const xpAdded = Math.round(base * mult);
    const oldLevel = getLevelIndex(_state.totalXP);

    _state.totalXP += xpAdded;
    _state.levelIndex = getLevelIndex(_state.totalXP);
    const leveledUp = _state.levelIndex > oldLevel;

    // Badge: unlock Sage if level 5
    if (_state.levelIndex === 4) {
        const b = _state.badges.find(b => b.id === 'sage');
        if (b) b.unlocked = true;
    }

    const event: XpEvent = {
        xpAdded,
        basXP: base,
        multiplier: mult,
        newTotal: _state.totalXP,
        leveledUp,
        newLevelIndex: _state.levelIndex,
        combo: _state.combo,
        isCorrect,
        clientX,
        clientY,
    };

    _notify(event);
    return event;
}

// ── Quest helpers ─────────────────────────────────────────────
export function completeQuest(idx: 0 | 1 | 2): boolean {
    if (_state.questDone[idx]) return false;
    _state.questDone[idx] = true;

    const allDone = _state.questDone.every(Boolean);
    _notify(null);
    return allDone;
}

export function unlockBadge(id: string): boolean {
    const b = _state.badges.find(b => b.id === id);
    if (!b || b.unlocked) return false;
    b.unlocked = true;
    _notify(null);
    return true;
}
