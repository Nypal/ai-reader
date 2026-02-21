import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.get('/api/health', (req, res) => {
    const hasKey = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here';
    res.json({
        status: 'ok',
        keyLoaded: hasKey
    });
});

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'alloy' } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
            return res.status(500).json({ error: 'OpenAI API key is missing or invalid in backend/.env' });
        }

        console.log(`Generating audio for chunk (${text.length} chars)...`);

        const mp3 = await openai.audio.speech.create({
            model: 'tts-1',
            voice: voice,
            input: text,
            response_format: 'mp3',
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());

        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': buffer.length,
            // Provide caching headers so the browser caches identical requests
            'Cache-Control': 'public, max-age=86400',
        });

        res.send(buffer);
    } catch (error) {
        console.error('TTS Error:', error);
        res.status(500).json({ error: 'Failed to generate audio' });
    }
});

app.post('/api/quiz', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
            return res.status(500).json({ error: 'OpenAI API key is missing or invalid in backend/.env' });
        }

        console.log(`Generating quiz for text (${text.length} chars)...`);

        const prompt = `You are an expert educator. Read the provided text.
Split the text into logical paragraphs.
For EACH paragraph, generate EXACTLY ONE multiple-choice question testing the main idea.
Rotate the question type for each paragraph cyclically through these 3 types:
1. "Comprehension": Test understanding of the main idea.
2. "Inference": Ask what conclusion can be drawn from the paragraph.
3. "Application": Ask how the user would apply this idea in real life.

For each question, provide 4 answer choices exactly:
- 1 clearly correct answer
- 1 partially correct but incomplete distractor
- 2 common misconceptions/incorrect answers

Include the 0-based index of the correct answer, and a short 1-sentence explanation of why it is correct and why the others are wrong/incomplete. Crucially, make distractor explanations highly educational by explicitly stating why that concept matters in context. Provide the correct concept explanation for every wrong answer.

Finally, generate a "summary" section: the 3 most important concepts from the text overall, in simple one-sentence form.

You MUST return the output ONLY as valid JSON in this exact structure:
{
  "questions": [
    {
      "paragraphNumber": 1,
      "paragraphText": "...",
      "concept": "...",
      "type": "Comprehension",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correctAnswerIndex": 0,
      "explanation": "..."
    }
  ],
  "summary": ["...", "...", "..."]
}

Text to analyze:
${text}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.7,
        });

        let quizData = JSON.parse(completion.choices[0].message.content);

        // Shuffle options for each question to avoid pattern guessing
        if (quizData.questions && Array.isArray(quizData.questions)) {
            quizData.questions = quizData.questions.map(q => {
                if (!q.options || q.options.length === 0) return q;
                const correctAnswerText = q.options[q.correctAnswerIndex];

                // create array of objects with original values and random sort key
                const shuffledObj = q.options
                    .map(value => ({ value, sort: Math.random() }))
                    .sort((a, b) => a.sort - b.sort)
                    .map(({ value }) => value);

                const newCorrectIndex = shuffledObj.indexOf(correctAnswerText);

                return {
                    ...q,
                    options: shuffledObj,
                    correctAnswerIndex: newCorrectIndex !== -1 ? newCorrectIndex : 0
                };
            });
        }

        res.json(quizData);
    } catch (error) {
        console.error('Quiz Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate quiz' });
    }
});

app.post('/api/feynman', async (req, res) => {
    try {
        const { originalText, userExplanation } = req.body;

        if (!originalText || !userExplanation) {
            return res.status(400).json({ error: 'Original text and user explanation are required' });
        }

        console.log(`Evaluating Feynman Test...`);

        const prompt = `You are an expert educator acting as a supportive coach for a student taking a Feynman Test.
Original Text:
${originalText}

Student's Explanation:
${userExplanation}

Evaluate how accurately and completely the student explained the main ideas of the original text. Maintain an encouraging, coaching tone. DO NOT judge. 
You MUST return the output ONLY as valid JSON in this exact structure, using these EXACT keys:
{
    "overallScore": 85,
    "strongPoints": "List specific things the student explained correctly.",
    "whatToAdd": "List specific concepts they missed that they should add next time.",
    "sentenceToImprove": "Provide one concrete example sentence the student could use to improve their explanation."
}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.7,
        });

        const feedbackData = JSON.parse(completion.choices[0].message.content);
        res.json(feedbackData);
    } catch (error) {
        console.error('Feynman Evaluation Error:', error);
        res.status(500).json({ error: 'Failed to evaluate explanation' });
    }
});

app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
});
