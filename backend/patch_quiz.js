import { readFileSync, writeFileSync } from 'fs';

const file = new URL('./server.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
let src = readFileSync(file, 'utf8');

// ── The old prompt (exact text as it appears in server.js) ──────────────
const OLD = `const systemPrompt = \`Generate exactly 4 multiple choice questions based SOLELY on the user text. Output valid JSON only.\r\nSchema: {"questions":[{"type":"main|detail|apply","question":"...","options":["...","...","...","..."],"correct":0,"explanation":"...","reference":"..."}]}\`;`;

// ── Replacement prompt ───────────────────────────────────────────────────
const NEW = `const systemPrompt = \`Generate exactly 4 multiple choice questions based SOLELY on the user text. Output valid JSON only.

CRITICAL RULES:
- The "correct" field is a 0-based index into the "options" array identifying the correct option.
- You MUST vary the correct answer position across ALL 4 questions. Spread the correct index across 0 (A), 1 (B), 2 (C), and 3 (D) — do NOT place the correct answer at the same index for every question.
- All 4 options must be plausible. The 3 distractors should be clearly wrong but not trivially obvious.

Schema: {"questions":[{"type":"main|detail|apply","question":"...","options":["option_A","option_B","option_C","option_D"],"correct":2,"explanation":"...","reference":"..."}]}\`;`;

if (src.includes(OLD)) {
  src = src.replace(OLD, NEW);
  writeFileSync(file, src, 'utf8');
  console.log('✅ Patched: system prompt updated — correct answers will now be varied across A/B/C/D');
} else {
  // Fallback: regex-based replace targeting just the schema line
  const regex = /(const systemPrompt = `Generate exactly 4 multiple choice questions based SOLELY on the user text\. Output valid JSON only\.[\r\n]+Schema:[^\`]+`);/s;
  if (regex.test(src)) {
    src = src.replace(regex, NEW + ';');
    writeFileSync(file, src, 'utf8');
    console.log('✅ Patched via regex fallback');
  } else {
    console.error('❌ Could not locate systemPrompt — no changes made');
    process.exit(1);
  }
}
