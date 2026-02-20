export function useSentenceSplitter(text: string): { original: string[]; spoken: string[] } {
    if (!text) return { original: [], spoken: [] };

    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    const emails: { key: string; original: string; spoken: string }[] = [];

    const protectedText = text.replace(emailRegex, (match) => {
        const key = `__EMAIL_${emails.length}__`;

        // Spoken version: test at example dot com
        const spoken = match
            .replace("@", " at ")
            .replace(/\./g, " dot ");

        console.log("[EmailPreprocess]", { original: match, spoken });

        emails.push({ key, original: match, spoken });
        return key;
    });

    const sentencesProtected = protectedText.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [];
    const trimmedProtected = sentencesProtected.map(s => s.trim()).filter(s => s.length > 0);

    const restore = (s: string, mode: "original" | "spoken") => {
        let out = s;
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
