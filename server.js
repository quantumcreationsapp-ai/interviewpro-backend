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

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many AI requests, please try again later.' }
});

app.use('/api', apiLimiter);

// Request timeout
app.use((req, res, next) => {
    req.setTimeout(120000);
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
        version: '2.0.0',
        poweredBy: 'OpenAI GPT-4 + TTS',
        endpoints: ['/api/real-interview', '/api/mock-interview', '/api/quick-answer', '/api/tts']
    });
});

// Render health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

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
        const { messages, jobTitle, industry, experienceLevel, interviewType } = req.body;

        if (!jobTitle) {
            return res.status(400).json({ error: 'Job title is required' });
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

        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                openaiMessages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.content
                });
            });
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

        const aiMessage = response.choices[0].message.content;
        const containsFeedback = aiMessage.includes('---FEEDBACK_START---');

        res.json({
            success: true,
            message: aiMessage,
            containsFeedback,
            usage: {
                input_tokens: response.usage.prompt_tokens,
                output_tokens: response.usage.completion_tokens
            }
        });

    } catch (error) {
        console.error('Real Interview Error:', error);
        res.status(500).json({
            error: 'Failed to process interview',
            details: error.message
        });
    }
});

/**
 * Mock Interview Mode
 */
app.post('/api/mock-interview', aiLimiter, async (req, res) => {
    try {
        const { messages, jobTitle, industry, experienceLevel } = req.body;

        if (!jobTitle) {
            return res.status(400).json({ error: 'Job title is required' });
        }

        const systemPrompt = `${MOCK_INTERVIEW_PROMPT}

Context:
- Job Title: ${jobTitle}
- Industry: ${industry || 'General'}
- Experience Level: ${experienceLevel || 'Mid-level'}`;

        const openaiMessages = [
            { role: 'system', content: systemPrompt }
        ];

        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                openaiMessages.push({
                    role: msg.role === 'user' ? 'user' : 'assistant',
                    content: msg.content
                });
            });
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            max_tokens: 1024,
            temperature: 0.7
        });

        res.json({
            success: true,
            message: response.choices[0].message.content,
            usage: {
                input_tokens: response.usage.prompt_tokens,
                output_tokens: response.usage.completion_tokens
            }
        });

    } catch (error) {
        console.error('Mock Interview Error:', error);
        res.status(500).json({
            error: 'Failed to process mock interview',
            details: error.message
        });
    }
});

/**
 * Quick Answer Mode
 */
app.post('/api/quick-answer', aiLimiter, async (req, res) => {
    try {
        const { question, jobTitle, industry } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
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

        res.json({
            success: true,
            answer: response.choices[0].message.content,
            usage: {
                input_tokens: response.usage.prompt_tokens,
                output_tokens: response.usage.completion_tokens
            }
        });

    } catch (error) {
        console.error('Quick Answer Error:', error);
        res.status(500).json({
            error: 'Failed to generate answer',
            details: error.message
        });
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
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'nova' } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const selectedVoice = validVoices.includes(voice) ? voice : 'nova';

        // Limit text length (max 4096 chars)
        const truncatedText = text.length > 4096 ? text.substring(0, 4096) : text;

        console.log(`TTS: ${truncatedText.length} chars, voice: ${selectedVoice}`);

        const mp3Response = await openai.audio.speech.create({
            model: 'tts-1',
            voice: selectedVoice,
            input: truncatedText,
            response_format: 'mp3',
            speed: 1.0
        });

        const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

        console.log(`TTS Response: ${audioBuffer.length} bytes`);

        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length,
            'Cache-Control': 'no-cache'
        });

        res.send(audioBuffer);

    } catch (error) {
        console.error('TTS Error:', error);
        res.status(500).json({
            error: 'Failed to generate speech',
            details: error.message
        });
    }
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({
        error: 'Internal server error'
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║       InterviewPro AI Backend v2.0         ║
╠════════════════════════════════════════════╣
║  Powered by OpenAI (GPT-4o + TTS)          ║
║  Server running on port ${PORT}               ║
║                                            ║
║  Endpoints:                                ║
║  • POST /api/real-interview                ║
║  • POST /api/mock-interview                ║
║  • POST /api/quick-answer                  ║
║  • POST /api/tts                           ║
╚════════════════════════════════════════════╝
    `);
});
