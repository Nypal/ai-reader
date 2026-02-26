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
For EACH paragraph, generate EXACTLY ONE main question: "What is the main idea of this paragraph?"
Optionally, you may generate ONE additional supporting question about a key detail if the paragraph is dense.
Ensure questions are derived SOLELY from the provided text. DO NOT hallucinate or bring in outside information.

You MUST return the output ONLY as valid JSON in this exact structure:
{
  "questions": [
    {
      "paragraphNumber": 1,
      "paragraphText": "...",
      "concept": "...",
      "type": "Main Idea",
      "question": "What is the main idea of this paragraph?"
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

        res.json(quizData);
    } catch (error) {
        console.error('Quiz Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate quiz' });
    }
});

app.post('/api/evaluate', async (req, res) => {
    try {
        const { question, answer, paragraphText } = req.body;
        if (!question || !answer || !paragraphText) {
            return res.status(400).json({ error: 'question, answer, and paragraphText are required' });
        }

        const prompt = `You are an expert educator evaluating a student's answer.
Read the following paragraph:
        "${paragraphText}"

The question asked was:
        "${question}"

The student's answer is:
        "${answer}"

Evaluate the student's answer based STRICTLY on the paragraph text. Do not use outside knowledge.
Assess if the answer is "correct", "partial"(partially correct), or "incorrect".
Provide a short, encouraging 1 - 2 sentence explanation of your evaluation, again based only on the text.

You MUST return the output ONLY as valid JSON in this exact structure:
        {
            "score": "correct", // or "partial", or "incorrect"
                "explanation": "..."
        } `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.3,
        });

        res.json(JSON.parse(completion.choices[0].message.content));
    } catch (error) {
        console.error('Evaluate generation error:', error);
        res.status(500).json({ error: 'Failed to evaluate answer' });
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

Evaluate how accurately and completely the student explained the main ideas of the original text.Maintain an encouraging, coaching tone.DO NOT judge. 
You MUST return the output ONLY as valid JSON in this exact structure, using these EXACT keys:
{
    "overallScore": 85,
        "strongPoints": "List specific things the student explained correctly.",
            "whatToAdd": "List specific concepts they missed that they should add next time.",
                "sentenceToImprove": "Provide one concrete example sentence the student could use to improve their explanation."
} `;

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

app.post('/api/translate', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
            return res.status(500).json({ error: 'OpenAI API key is missing or invalid in backend/.env' });
        }

        console.log(`Translating text to French(${text.length} chars)...`);

        const prompt = `Translate the following text into fluent, natural - sounding French.Do not add any extra commentary, just output the translated text.Maintain proper paragraph formatting.\n\nText: \n${text} `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
        });

        res.json({ translatedText: completion.choices[0].message.content });
    } catch (error) {
        console.error('Translation Error:', error);
        res.status(500).json({ error: 'Failed to translate text' });
    }
});

app.post('/api/translate', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
            return res.status(500).json({ error: 'OpenAI API key is missing or invalid in backend/.env' });
        }

        console.log(`Translating text to French(${text.length} chars)...`);

        const prompt = `Translate the following text into fluent, natural - sounding French.Do not add any extra commentary, just output the translated text.Maintain proper paragraph formatting.\n\nText: \n${text} `;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
        });

        res.json({ translatedText: completion.choices[0].message.content });
    } catch (error) {
        console.error('Translation Error:', error);
        res.status(500).json({ error: 'Failed to translate text' });
    }
});

app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
});

