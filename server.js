/**
 * ============================================
 * InterviewPro AI - Backend Server
 * ============================================
 *
 * This server provides:
 * 1. Interview AI endpoints (powered by Claude)
 * 2. Text-to-Speech endpoint (powered by OpenAI)
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 * - ANTHROPIC_API_KEY: Your Claude API key
 * - OPENAI_API_KEY: Your OpenAI API key (for TTS)
 * - PORT: Server port (default: 3000)
 *
 * ============================================
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// VALIDATE ENVIRONMENT VARIABLES
// ============================================

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
}

// OpenAI is optional - TTS will fail gracefully if not configured
if (!process.env.OPENAI_API_KEY) {
    console.warn('WARNING: OPENAI_API_KEY not set. TTS endpoint will be disabled.');
}

// ============================================
// INITIALIZE AI CLIENTS
// ============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// ============================================
// MIDDLEWARE SETUP
// ============================================

// Security headers
app.use(helmet());

// CORS - allow all origins for mobile app
app.use(cors());

// Parse JSON
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20,
    message: { error: 'Too many AI requests, please try again later.' }
});

app.use('/api', apiLimiter);

// Request timeout
app.use((req, res, next) => {
    req.setTimeout(120000); // 2 minutes
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
        version: '1.0.0',
        endpoints: {
            interview: ['/api/real-interview', '/api/mock-interview', '/api/quick-answer'],
            tts: '/api/tts'
        },
        ttsEnabled: !!openai
    });
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

Keep your responses conversational and helpful. You can ask follow-up questions, provide tips, or give them another question to practice. Be warm and supportive - this is practice, not a real interview.`;

const QUICK_ANSWER_PROMPT = `You are an expert interview coach. Provide a comprehensive, well-structured answer to the interview question. Include:

1. A strong opening statement
2. Specific examples or frameworks to use
3. Key points to emphasize
4. Tips for delivery

Keep the answer practical and actionable. Format it clearly so it's easy to read and remember.`;

// ============================================
// INTERVIEW ENDPOINTS
// ============================================

/**
 * Real Interview Mode
 * Formal interview with scoring and feedback
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

        // Convert messages to Claude format
        const claudeMessages = (messages || []).map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));

        // If no messages, start the interview
        if (claudeMessages.length === 0) {
            claudeMessages.push({
                role: 'user',
                content: 'Please start the interview.'
            });
        }

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: claudeMessages
        });

        const aiMessage = response.content[0].text;
        const containsFeedback = aiMessage.includes('---FEEDBACK_START---');

        res.json({
            success: true,
            message: aiMessage,
            containsFeedback,
            usage: {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens
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
 * Casual practice with AI coach
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

        const claudeMessages = (messages || []).map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: claudeMessages
        });

        res.json({
            success: true,
            message: response.content[0].text,
            usage: {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens
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
 * Get instant answer to any interview question
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

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{
                role: 'user',
                content: `How should I answer this interview question: "${question}"`
            }]
        });

        res.json({
            success: true,
            answer: response.content[0].text,
            usage: {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens
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
// TEXT-TO-SPEECH ENDPOINT (OpenAI)
// ============================================

/**
 * TTS Endpoint
 * Converts text to natural speech using OpenAI
 *
 * POST /api/tts
 * Body: { text: "Hello world", voice: "nova" }
 * Returns: audio/mpeg binary
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
        // Check if OpenAI is configured
        if (!openai) {
            return res.status(503).json({
                error: 'TTS service not configured',
                details: 'OPENAI_API_KEY environment variable not set'
            });
        }

        const { text, voice = 'nova' } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        // Validate voice
        const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const selectedVoice = validVoices.includes(voice) ? voice : 'nova';

        // Limit text length (OpenAI limit is 4096 chars)
        const maxLength = 4096;
        const truncatedText = text.length > maxLength
            ? text.substring(0, maxLength)
            : text;

        console.log(`TTS Request: ${truncatedText.length} chars, voice: ${selectedVoice}`);

        // Generate speech
        const mp3Response = await openai.audio.speech.create({
            model: 'tts-1',           // Use 'tts-1-hd' for higher quality (2x cost)
            voice: selectedVoice,
            input: truncatedText,
            response_format: 'mp3',
            speed: 1.0                 // 0.25 to 4.0
        });

        // Get audio buffer
        const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());

        console.log(`TTS Response: ${audioBuffer.length} bytes`);

        // Send audio
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
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║       InterviewPro AI Backend              ║
╠════════════════════════════════════════════╣
║  Server running on port ${PORT}               ║
║                                            ║
║  Endpoints:                                ║
║  • POST /api/real-interview                ║
║  • POST /api/mock-interview                ║
║  • POST /api/quick-answer                  ║
║  • POST /api/tts                           ║
║                                            ║
║  TTS Enabled: ${openai ? 'Yes ✓' : 'No ✗ (set OPENAI_API_KEY)'}              ║
╚════════════════════════════════════════════╝
    `);
});
