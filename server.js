/**
 * ============================================
 * InterviewPro AI - Backend Server
 * ============================================
 *
 * 100% OpenAI powered:
 * - GPT-4 for interview AI
 * - TTS for natural voice
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 * - OPENAI_API_KEY: Your OpenAI API key
 * - PORT: Server port (default: 3000)
 * - API_SECRET: Shared secret for client auth (optional)
 * - ALLOWED_ORIGINS: Comma-separated allowed CORS origins (optional)
 *
 * ============================================
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// VALIDATE ENVIRONMENT VARIABLES
// ============================================

if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

// ============================================
// INITIALIZE OPENAI CLIENT
// ============================================

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ============================================
// MIDDLEWARE SETUP
// ============================================

// Trust proxy (required for correct client IP behind Render/load balancers)
app.set('trust proxy', 1);

app.use(helmet());

// CORS configuration — reject unknown origins by default in production
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(o => o.length > 0)
        : (process.env.NODE_ENV === 'production' ? false : true),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
    maxAge: 86400
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

// API key authentication (if API_SECRET is set)
const apiSecret = process.env.API_SECRET;
if (apiSecret) {
    app.use('/api', (req, res, next) => {
        // Skip auth for health check
        if (req.path === '/health') return next();

        const clientKey = req.headers['x-api-key'];
        if (clientKey !== apiSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });
}

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many AI requests, please try again later.' }
});

const ttsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many TTS requests, please try again later.' }
});

app.use('/api', apiLimiter);

// Request timeout
app.use((req, res, next) => {
    res.setTimeout(120000, () => {
        if (!res.headersSent) {
            res.status(408).json({ error: 'Request timed out. Please try again.' });
        }
    });
    next();
});

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
    next();
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'InterviewPro AI API is running',
        version: '2.1.0',
        poweredBy: 'OpenAI GPT-4 + TTS'
    });
});

// Render health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ============================================
// INPUT VALIDATION HELPERS
// ============================================

function validateString(value, maxLength = 500) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validateMessages(messages) {
    if (!Array.isArray(messages)) return false;
    if (messages.length > 100) return false;
    return messages.every(msg =>
        msg && typeof msg === 'object' &&
        typeof msg.role === 'string' &&
        typeof msg.content === 'string' &&
        msg.content.length <= 10000
    );
}

function sanitizeMessages(messages) {
    return messages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
    }));
}

function safeUsage(response) {
    return {
        input_tokens: response?.usage?.prompt_tokens ?? 0,
        output_tokens: response?.usage?.completion_tokens ?? 0
    };
}

function safeContent(response) {
    return response?.choices?.[0]?.message?.content ?? '';
}

// ============================================
// INLINE TTS HELPER
// ============================================

/**
 * Generate TTS audio and return as base64 string.
 * Returns null if voice is not requested or TTS fails (non-blocking).
 */
async function generateInlineTTS(text, voice) {
    if (!voice) return null;

    const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    const selectedVoice = validVoices.includes(voice) ? voice : 'nova';
    const truncated = text.length > 1000 ? text.substring(0, 1000) : text;

    try {
        const mp3Response = await openai.audio.speech.create({
            model: 'tts-1',
            voice: selectedVoice,
            input: truncated,
            response_format: 'mp3',
            speed: 1.0
        });

        const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());
        if (!audioBuffer.length) return null;

        console.log(`Inline TTS: ${truncated.length} chars → ${audioBuffer.length} bytes`);
        return audioBuffer.toString('base64');
    } catch (err) {
        console.error('Inline TTS failed (non-blocking):', err.message);
        return null;
    }
}

// ============================================
// INTERVIEW PROMPTS
// ============================================

const REAL_INTERVIEW_PROMPT = `You are a professional job interviewer conducting a formal interview. Your role is to:

1. Ask relevant interview questions based on the job title, industry, and experience level
2. Listen to responses and ask follow-up questions when appropriate
3. Maintain a professional but friendly demeanor
4. After 5-7 questions OR when the candidate requests to end, provide detailed feedback

IMPORTANT: When providing final feedback, wrap it in these exact markers:
---FEEDBACK_START---
Overall Score: [0-100]

Category Scores:
- Communication: [0-100]
- Technical Skills: [0-100]
- Problem Solving: [0-100]
- Professionalism: [0-100]

Strengths:
- [strength 1]
- [strength 2]
- [strength 3]

Areas for Improvement:
- [improvement 1]
- [improvement 2]

Hiring Recommendation: [Strong Hire / Hire / Consider / Do Not Hire]

Summary: [2-3 sentence summary]
---FEEDBACK_END---

Keep responses concise (2-3 paragraphs max). Be encouraging but honest.`;

const MOCK_INTERVIEW_PROMPT = `You are a friendly AI interview coach having a practice conversation. Your role is to:

1. Help the user practice answering interview questions
2. Provide constructive feedback on their answers
3. Suggest improvements and alternative approaches
4. Answer their questions about interviewing
5. Be supportive and encouraging

Keep your responses conversational and helpful. Be warm and supportive - this is practice, not a real interview.`;

const QUICK_ANSWER_PROMPT = `You are an expert interview coach. Provide a comprehensive, well-structured answer to the interview question. Include:

1. A strong opening statement
2. Specific examples or frameworks to use
3. Key points to emphasize
4. Tips for delivery

Keep the answer practical and actionable.`;

// ============================================
// INTERVIEW ENDPOINTS (Using GPT-4)
// ============================================

/**
 * Real Interview Mode
 */
app.post('/api/real-interview', aiLimiter, async (req, res) => {
    try {
        const { messages, jobTitle, industry, experienceLevel, interviewType, voice } = req.body;

        if (!validateString(jobTitle, 200)) {
            return res.status(400).json({ error: 'A valid job title is required' });
        }

        const systemPrompt = `${REAL_INTERVIEW_PROMPT}

Context:
- Job Title: ${jobTitle}
- Industry: ${industry || 'General'}
- Experience Level: ${experienceLevel || 'Mid-level'}
- Interview Type: ${interviewType || 'Behavioral and Technical'}`;

        // Convert messages to OpenAI format
        const openaiMessages = [
            { role: 'system', content: systemPrompt }
        ];

        if (Array.isArray(messages) && messages.length > 0) {
            if (!validateMessages(messages)) {
                return res.status(400).json({ error: 'Invalid messages format' });
            }
            openaiMessages.push(...sanitizeMessages(messages));
        } else {
            openaiMessages.push({
                role: 'user',
                content: 'Please start the interview.'
            });
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            max_tokens: 1024,
            temperature: 0.7
        });

        const aiMessage = safeContent(response);
        if (!aiMessage) {
            return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
        }

        const containsFeedback = aiMessage.includes('---FEEDBACK_START---');

        // Generate inline TTS if voice requested and not feedback
        const audioBase64 = (!containsFeedback && voice)
            ? await generateInlineTTS(aiMessage, voice)
            : null;

        res.json({
            success: true,
            message: aiMessage,
            containsFeedback,
            usage: safeUsage(response),
            ...(audioBase64 && { audioBase64 })
        });

    } catch (error) {
        console.error('Real Interview Error:', error.message);
        if (error?.status === 429) {
            return res.status(429).json({ error: 'AI service is busy. Please try again in a moment.' });
        }
        res.status(500).json({ error: 'Failed to process interview. Please try again.' });
    }
});

/**
 * Mock Interview Mode
 */
app.post('/api/mock-interview', aiLimiter, async (req, res) => {
    try {
        const { messages, jobTitle, industry, experienceLevel, voice } = req.body;

        if (!validateString(jobTitle, 200)) {
            return res.status(400).json({ error: 'A valid job title is required' });
        }

        if (!Array.isArray(messages) || !validateMessages(messages)) {
            return res.status(400).json({ error: 'Valid messages array is required' });
        }

        const systemPrompt = `${MOCK_INTERVIEW_PROMPT}

Context:
- Job Title: ${jobTitle}
- Industry: ${industry || 'General'}
- Experience Level: ${experienceLevel || 'Mid-level'}`;

        const openaiMessages = [
            { role: 'system', content: systemPrompt },
            ...sanitizeMessages(messages)
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            max_tokens: 1024,
            temperature: 0.7
        });

        const aiMessage = safeContent(response);
        if (!aiMessage) {
            return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
        }

        // Generate inline TTS if voice requested
        const audioBase64 = voice
            ? await generateInlineTTS(aiMessage, voice)
            : null;

        res.json({
            success: true,
            message: aiMessage,
            usage: safeUsage(response),
            ...(audioBase64 && { audioBase64 })
        });

    } catch (error) {
        console.error('Mock Interview Error:', error.message);
        if (error?.status === 429) {
            return res.status(429).json({ error: 'AI service is busy. Please try again in a moment.' });
        }
        res.status(500).json({ error: 'Failed to process mock interview. Please try again.' });
    }
});

/**
 * Quick Answer Mode
 */
app.post('/api/quick-answer', aiLimiter, async (req, res) => {
    try {
        const { question, jobTitle, industry } = req.body;

        if (!validateString(question, 2000)) {
            return res.status(400).json({ error: 'A valid question is required (max 2000 characters)' });
        }

        const systemPrompt = `${QUICK_ANSWER_PROMPT}

Context:
- Job Title: ${jobTitle || 'Professional'}
- Industry: ${industry || 'General'}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `How should I answer this interview question: "${question}"` }
            ],
            max_tokens: 1024,
            temperature: 0.7
        });

        const answer = safeContent(response);
        if (!answer) {
            return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
        }

        res.json({
            success: true,
            answer,
            usage: safeUsage(response)
        });

    } catch (error) {
        console.error('Quick Answer Error:', error.message);
        if (error?.status === 429) {
            return res.status(429).json({ error: 'AI service is busy. Please try again in a moment.' });
        }
        res.status(500).json({ error: 'Failed to generate answer. Please try again.' });
    }
});

// ============================================
// TEXT-TO-SPEECH ENDPOINT (OpenAI TTS)
// ============================================

/**
 * TTS Endpoint - Natural voice synthesis
 *
 * Available voices:
 * - nova: Female, warm and friendly (recommended)
 * - alloy: Neutral, balanced
 * - echo: Male, warm
 * - fable: Male, British accent
 * - onyx: Male, deep and authoritative
 * - shimmer: Female, clear and expressive
 */
app.post('/api/tts', ttsLimiter, async (req, res) => {
    try {
        const { text, voice = 'nova' } = req.body;

        if (!validateString(text, 4096)) {
            return res.status(400).json({ error: 'Text is required (max 4096 characters)' });
        }

        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const selectedVoice = validVoices.includes(voice) ? voice : 'nova';

        // Cap text to prevent large audio buffers that can OOM the server
        const ttsText = text.length > 1000 ? text.substring(0, 1000) : text;

        console.log(`TTS: ${ttsText.length} chars (original: ${text.length}), voice: ${selectedVoice}`);

        const mp3Response = await openai.audio.speech.create({
            model: 'tts-1',
            voice: selectedVoice,
            input: ttsText,
            response_format: 'mp3',
            speed: 1.0
        });

        const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

        if (!audioBuffer.length) {
            return res.status(502).json({ error: 'TTS returned empty audio. Please try again.' });
        }

        console.log(`TTS Response: ${audioBuffer.length} bytes`);

        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length,
            'Cache-Control': 'no-cache'
        });

        res.send(audioBuffer);

    } catch (error) {
        console.error('TTS Error:', error.message);
        if (error?.status === 429) {
            return res.status(429).json({ error: 'TTS service is busy. Please try again in a moment.' });
        }
        res.status(500).json({ error: 'Failed to generate speech. Please try again.' });
    }
});

// ============================================
// 404 HANDLER
// ============================================

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║       InterviewPro AI Backend v2.1         ║
╠════════════════════════════════════════════╣
║  Powered by OpenAI (GPT-4o + TTS)         ║
║  Server running on port ${String(PORT).padEnd(19)}║
║                                            ║
║  Endpoints:                                ║
║  • POST /api/real-interview                ║
║  • POST /api/mock-interview                ║
║  • POST /api/quick-answer                  ║
║  • POST /api/tts                           ║
╚════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
    // Force exit after 10 seconds if server hasn't closed
    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prevent silent crashes — log and keep running
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION (keeping server alive):', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION (keeping server alive):', reason);
});
