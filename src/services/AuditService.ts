export interface SessionStats {
    id: string;
    timestamp: number;
    durationSeconds: number;
    sentencesRead: number;
    maxSpeedUsed: number;
    replayCount: number;
}

export interface ConceptPerformance {
    concept: string;
    correctAnswers: number;
    incorrectAnswers: number;
    lastTested: number;
}

export interface FeynmanScoreHistory {
    id: string;
    timestamp: number;
    overallScore: number;
}

const STORAGE_KEYS = {
    SESSIONS: 'ai_reader_audit_sessions',
    CONCEPTS: 'ai_reader_audit_concepts',
    FEYNMAN: 'ai_reader_audit_feynman'
};

class AuditServiceClass {
    private getItem<T>(key: string, defaultValue: T): T {
        try {
            const val = localStorage.getItem(key);
            return val ? JSON.parse(val) : defaultValue;
        } catch (e) {
            console.error(`Error parsing localStorage for ${key}`, e);
            return defaultValue;
        }
    }

    private setItem<T>(key: string, value: T): void {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error(`Error setting localStorage for ${key}`, e);
        }
    }

    // --- Session Audit ---
    logSession(session: Omit<SessionStats, 'id' | 'timestamp'>) {
        const sessions = this.getItem<SessionStats[]>(STORAGE_KEYS.SESSIONS, []);
        const newSession: SessionStats = {
            ...session,
            id: Date.now().toString(),
            timestamp: Date.now()
        };
        sessions.push(newSession);
        this.setItem(STORAGE_KEYS.SESSIONS, sessions);
    }

    getSessions(): SessionStats[] {
        return this.getItem<SessionStats[]>(STORAGE_KEYS.SESSIONS, []);
    }

    // --- Quiz Concept Audit ---
    logQuizResult(concept: string, isCorrect: boolean) {
        if (!concept) return;

        // Normalize concept to lowercase for consistent grouping
        const normalizedConcept = concept.trim().toLowerCase();

        const concepts = this.getItem<Record<string, ConceptPerformance>>(STORAGE_KEYS.CONCEPTS, {});

        if (!concepts[normalizedConcept]) {
            // Store the original casing for display, but index by normalized
            concepts[normalizedConcept] = { concept: concept.trim(), correctAnswers: 0, incorrectAnswers: 0, lastTested: 0 };
        }

        if (isCorrect) {
            concepts[normalizedConcept].correctAnswers++;
        } else {
            // Only increment incorrect answers if they get it wrong
            concepts[normalizedConcept].incorrectAnswers++;
        }
        concepts[normalizedConcept].lastTested = Date.now();

        this.setItem(STORAGE_KEYS.CONCEPTS, concepts);
    }

    getConcepts(): ConceptPerformance[] {
        const conceptsMap = this.getItem<Record<string, ConceptPerformance>>(STORAGE_KEYS.CONCEPTS, {});
        // Sort by most recently tested first
        return Object.values(conceptsMap).sort((a, b) => b.lastTested - a.lastTested);
    }

    getStrugglingConcepts(threshold: number = 3): string[] {
        const concepts = this.getConcepts();
        return concepts
            .filter(c => c.incorrectAnswers >= threshold && c.incorrectAnswers > c.correctAnswers)
            .map(c => c.concept);
    }

    // --- Feynman Progress Audit ---
    logFeynmanResult(overallScore: number) {
        const history = this.getItem<FeynmanScoreHistory[]>(STORAGE_KEYS.FEYNMAN, []);
        history.push({
            id: Date.now().toString(),
            timestamp: Date.now(),
            overallScore
        });
        this.setItem(STORAGE_KEYS.FEYNMAN, history);
    }

    getFeynmanHistory(): FeynmanScoreHistory[] {
        return this.getItem<FeynmanScoreHistory[]>(STORAGE_KEYS.FEYNMAN, []);
    }
}

export const AuditService = new AuditServiceClass();
