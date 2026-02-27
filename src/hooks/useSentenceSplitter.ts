export function useSentenceSplitter(text: string): { original: string[]; spoken: string[] } {
    if (!text) return { original: [], spoken: [] };

    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const emails: { key: string; original: string; spoken: string }[] = [];

    let processedText = text.replace(emailRegex, (match) => {
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
