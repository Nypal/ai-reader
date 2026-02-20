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

app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
});
