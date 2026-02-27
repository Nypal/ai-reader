// Patterns that are almost always web-page chrome, not readable content.
const JUNK_LINE_PATTERNS: RegExp[] = [
    // UI actions
    /^(share|tweet|like|follow|subscribe|sign\s*in|sign\s*up|log\s*in|log\s*out|register|join now)$/i,
    /^(click here|read more|load more|see more|show more|view more|learn more|find out more)$/i,
    /^(back to top|skip to content|jump to|go to|scroll to)$/i,
    // Navigation / layout labels
    /^(menu|home|search|contact|about|privacy|terms|cookies?|newsletter|sitemap)$/i,
    /^(advertisement|sponsored content?|ad\b|promo)/i,
    // Legal boilerplate
    /^copyright\s/i,
    /^all rights reserved/i,
    /^©/,
    // Reading-time / date stamps ("5 min read", "March 15, 2024", "2 days ago")
    /^\d+\s*(min(ute)?|hour|day|week|month|year)s?\s*(read|ago|left)?\.?$/i,
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i,
    /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/,
    // Bare URLs
    /^https?:\/\//i,
    // Social share counts ("1.2K shares", "47 comments")
    /^\d[\d.,]*[KkMm]?\s*(shares?|likes?|comments?|views?|followers?)$/i,
];

function cleanWebText(raw: string): string {
    // Only apply line-by-line filtering when the text actually has newlines
    // (pasted web content). Single-block text is left untouched.
    if (!raw.includes('\n')) return raw;

    const lines = raw.split('\n');
    const kept: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Keep blank lines so paragraph structure is preserved
        if (!trimmed) { kept.push(''); continue; }

        // Drop known junk patterns
        if (JUNK_LINE_PATTERNS.some(p => p.test(trimmed))) continue;

        // Drop very short lines (≤3 words) with no sentence-ending punctuation —
        // these are almost always nav labels, headings-without-context, or bylines.
        const words = trimmed.split(/\s+/);
        const hasSentencePunct = /[.!?:;]$/.test(trimmed);
        if (words.length <= 3 && !hasSentencePunct) continue;

        kept.push(trimmed);
    }

    // Collapse runs of 3+ blank lines to a single blank line
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function useSentenceSplitter(text: string): { original: string[]; spoken: string[] } {
    if (!text) return { original: [], spoken: [] };

    const cleaned = cleanWebText(text);

    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const emails: { key: string; original: string; spoken: string }[] = [];

    let processedText = cleaned.replace(emailRegex, (match) => {
        const key = `__EMAIL_${emails.length}__`;

        // Spoken version: test at example dot com
        const spoken = match
            .replace("@", " at ")
            .replace(/\./g, " dot ");

        console.log("[EmailPreprocess]", { original: match, spoken });

        emails.push({ key, original: match, spoken });
        return key;
    });

    // Protect abbreviations from false sentence splits.
    // Replace each abbreviation with a Unicode Private Use Area placeholder so the
    // sentence-boundary regex never sees their interior periods.
    const abbrevMap: string[] = [];
    const protect = (m: string): string => {
        const k = `\uE000${abbrevMap.length}\uE001`;
        abbrevMap.push(m);
        return k;
    };

    processedText = processedText
        // 2+ uppercase letters with dots: U.S., U.K., E.U., U.S.A.
        .replace(/\b(?:[A-Z]\.){2,}/g, protect)
        // Title abbreviations: Dr., Mr., Mrs., Ms., Prof., Sr., Jr.
        .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr)\./g, protect)
        // Common word abbreviations
        .replace(/\b(?:vs|etc|approx|est|avg|dept|govt|ref|fig|vol|pp)\./g, protect)
        // Latin abbreviations: e.g., i.e., et al.
        .replace(/\be\.g\./g, protect)
        .replace(/\bi\.e\./g, protect)
        .replace(/\bet al\./g, protect)
        // Ordinal numbers with period: 1st., 2nd., 3rd., etc.
        .replace(/\b\d+(?:st|nd|rd|th)\./g, protect);

    // Preprocess: Ensure bullet points act as sentence boundaries
    // Match -, *, or • at the start of a line or preceded by spaces/newlines
    const blockText = processedText.replace(/(^|\n)\s*[-*•]\s+/g, '$1. ');

    // Split by standard punctuation
    const sentencesProtected = blockText.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [];
    const trimmedProtected = sentencesProtected
        .map(s => s.trim().replace(/^\.\s*/, '')) // Remove the artifact '.' we added for bullets
        .filter(s => s.length > 0);

    const restoreAbbrevs = (s: string): string =>
        s.replace(/\uE000(\d+)\uE001/g, (_, i) => abbrevMap[parseInt(i)]);

    const restore = (s: string, mode: "original" | "spoken") => {
        let out = restoreAbbrevs(s);
        for (const e of emails) {
            out = out.replaceAll(e.key, mode === "original" ? e.original : e.spoken);
        }
        return out;
    };

    return {
        original: trimmedProtected.map(s => restore(s, "original")),
        spoken: trimmedProtected.map(s => restore(s, "spoken"))
    };
}
