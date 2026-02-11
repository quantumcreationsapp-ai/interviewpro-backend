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
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30000,        // 30 second timeout for all API calls
    maxRetries: 1          // 1 automatic retry on transient errors
});

// ============================================
// MIDDLEWARE SETUP
// ============================================

// Trust proxy (required for correct client IP behind Render/load balancers)
app.set('trust proxy', 1);

app.use(helmet());

// CORS configuration
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : true,
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

// ============================================
// HEALTH CHECK (must be BEFORE rate limiter so Render checks aren't blocked)
// ============================================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'InterviewPro AI API is running',
        version: '2.1.0',
        poweredBy: 'OpenAI GPT-4 + TTS'
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

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
// INPUT VALIDATION HELPERS
// ============================================

function validateString(value, maxLength = 500) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Strip newlines and control characters from user input to prevent prompt injection */
function sanitizeInput(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\n\r\t]/g, ' ').trim();
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

/**
 * Safety net: if the AI returns multiple numbered questions in one response,
 * truncate to only the first question. This prevents the AI from dumping
 * all interview questions at once instead of asking one at a time.
 */
function enforceOneQuestion(text) {
    // Check if response contains a numbered list pattern: "1." followed by "2."
    const hasNumberedList = /(?:^|\n)\s*1[\.\)]\s/.test(text) && /\n\s*2[\.\)]\s/.test(text);
    if (!hasNumberedList) return text;

    // Find where the second numbered item starts and truncate before it
    const match = text.match(/\n\s*2[\.\)]\s/);
    if (match) {
        console.log('enforceOneQuestion: Truncated multi-question response');
        return text.substring(0, match.index).trim();
    }
    return text;
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

const REAL_INTERVIEW_PROMPT = `You are a senior hiring manager conducting a realistic one-on-one job interview. Your goal is to simulate an authentic interview experience tailored to the candidate's specific role, industry, and experience level.

## ABSOLUTE RULES — NEVER BREAK THESE:
1. Ask exactly ONE question per message. NEVER list multiple questions.
2. NEVER number your questions. NEVER use bullet-point lists of questions.
3. After each candidate answer, you MUST reference at least one specific detail from what they just said before asking your next question.
4. Keep each response to 2-4 sentences max (acknowledgement + question).

## HOW TO RESPOND TO EACH ANSWER (your turn policy):

Every time the candidate answers, follow this structure:
a) ACKNOWLEDGE: Paraphrase or reference 1 specific detail from their answer (1 sentence).
b) DECIDE: Either ask a follow-up on the same topic OR transition to a new topic.
c) ASK: One clear question.

Follow-up vs. Transition rules:
- Ask a FOLLOW-UP ~70% of the time (dig deeper into what they said — ask for metrics, specific examples, outcomes, challenges, or lessons learned).
- TRANSITION ~30% of the time (move to a new topic with a brief bridge like "That's helpful context — let me shift gears a bit…" or "Thanks for that. I'd like to explore a different area…").

## ACTIVE LISTENING EXAMPLES:

GOOD (references their answer):
"Interesting — so you were managing a team of 12 and owned the quarterly planning process. What were the main KPIs you tracked to measure your team's performance?"

"Got it — creating SOPs for onboarding sounds like it had a big impact. How did you measure whether those guidelines actually improved ramp-up time?"

BAD (ignores their answer — NEVER do this):
"Great. Tell me about a time you dealt with conflict."
"Thanks. What's your greatest weakness?"

## CLARIFYING VAGUE ANSWERS:
If the candidate gives a vague, generic, or rambling answer, do NOT move on. Instead, ask a clarifying question:
- "When you say 'managed overall operations', what specifically were you accountable for day-to-day?"
- "Can you give me a concrete example of that?"
- "What was the measurable outcome?"

## INTERVIEW STRUCTURE (adapt to the role):
Follow this natural flow, but adapt questions to the specific job title, industry, and experience level:
1. Warm opener → "Walk me through your background and current role"
2. Role-specific deep dive → responsibilities, tools, processes relevant to the job
3. Behavioral examples → leadership, teamwork, conflict resolution (with follow-ups)
4. Metrics & results → quantifiable achievements, KPIs, impact
5. Problem-solving / challenges → how they handle pressure, ambiguity, failure
6. Growth & self-awareness → what they'd do differently, areas they're developing
7. Closing → "Any questions for me?" or wrap-up

Aim for 8-12 total exchanges (including follow-ups) before providing feedback.

## CONVERSATION MEMORY:
Remember key facts the candidate mentions (team size, tools, metrics, projects, company names) and reference them naturally in later questions. Example: "Earlier you mentioned leading that migration project at [company] — how did you handle stakeholder communication during that?"

## TONE:
- Professional but warm — like a real hiring manager, not a robot.
- Sometimes gently challenge: "What would you do differently if you could redo that?" or "How do you know that approach actually worked?"
- Use natural transitions: "That's really helpful context.", "I appreciate you walking me through that.", "Let me dig into that a bit more.", "Let's switch gears."

## FIRST MESSAGE:
Start with a brief, warm greeting and ONE opening question. Example:
"Hi, thanks for taking the time to meet today. I've had a chance to look over your background and I'm looking forward to our conversation. To kick things off, can you walk me through your current role and what your day-to-day looks like?"

## ENDING THE INTERVIEW:
After 8-12 exchanges (or when the candidate requests to end), provide detailed performance feedback. Base your scores on the ENTIRE conversation — how well they communicated, their depth of knowledge for the role, problem-solving ability, and professionalism. Wrap feedback in these exact markers:

---FEEDBACK_START---
Overall Score: [0-100]

Category Scores:
- Communication: [0-100]
- Technical Knowledge: [0-100]
- Problem Solving: [0-100]
- Leadership & Teamwork: [0-100]
- Professionalism: [0-100]

Strengths:
- [strength 1 — reference specific moments from the interview]
- [strength 2]
- [strength 3]

Areas for Improvement:
- [improvement 1 — reference specific moments where they could have done better]
- [improvement 2]
- [improvement 3]

Hiring Recommendation: [Strong Hire / Hire / Consider / Do Not Hire]

Summary: [3-4 sentence summary that references specific answers and moments from the interview]
---FEEDBACK_END---`;

const MOCK_INTERVIEW_PROMPT = `You are a friendly AI interview coach. You are having a one-on-one practice session.

## ABSOLUTE RULES — NEVER BREAK THESE:
1. You must ask exactly ONE question per message. NEVER include more than one question.
2. NEVER number your questions. NEVER use lists of questions.
3. Wait for the user's response before asking the next question.
4. Keep each message short — a brief comment plus ONE question.

## PRACTICE FLOW:
- Your FIRST message: A warm greeting (1 sentence) + your first practice question. Nothing else.
- After each answer: Brief feedback on what was good and what could improve (2-3 sentences), then ONE new question.
- Be supportive, warm, and encouraging — this is practice, not a real interview.
- Answer their questions about interviewing if they ask.

## EXAMPLE OF CORRECT FIRST MESSAGE:
"Hi there! Great to have you for practice today. Let's jump right in — tell me about yourself and your background."

## EXAMPLE OF INCORRECT FIRST MESSAGE (NEVER DO THIS):
"Here are some practice questions: 1. Tell me about... 2. Why do you... 3. Describe..."

Keep responses concise and conversational.`;

const QUICK_ANSWER_PROMPT = `You are an expert interview coach. Write a SAMPLE ANSWER that the user can memorize and say out loud in an interview.

CRITICAL RULES:
- Write the answer in FIRST PERSON ("I", "my experience", "my role")
- Write in natural, spoken English — as if actually speaking to an interviewer
- Length: 150-250 words (about 60-120 seconds when spoken)
- Tone: confident, professional, conversational (NOT robotic or scripted)
- Do NOT include headings, bullet points, numbered lists, or bold text
- Do NOT include coaching tips, STAR explanations, or interview theory
- Do NOT use meta language like "When answering this question..." or "You should..."
- Do NOT include labels like "Opening Statement:", "Body:", "Conclusion:"
- Just write the answer as continuous paragraphs, ready to speak

After the sample answer, add a blank line then:
---
Customize this answer: Replace [Your Company] with the company name, [X years] with your experience, and [your key achievement] with a specific accomplishment from your background.`;

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

        // Sanitize all user-supplied fields embedded in prompts
        const safeJobTitle = sanitizeInput(jobTitle);
        const safeIndustry = sanitizeInput(industry) || 'General';
        const safeExperience = sanitizeInput(experienceLevel) || 'Mid-level';
        const safeInterviewType = sanitizeInput(interviewType) || 'Behavioral and Technical';

        const systemPrompt = `${REAL_INTERVIEW_PROMPT}

Context:
- Job Title: ${safeJobTitle}
- Industry: ${safeIndustry}
- Experience Level: ${safeExperience}
- Interview Type: ${safeInterviewType}`;

        // Convert messages to OpenAI format
        const openaiMessages = [
            { role: 'system', content: systemPrompt }
        ];

        const isInitialMessage = !Array.isArray(messages) || messages.length === 0;

        if (!isInitialMessage) {
            if (!validateMessages(messages)) {
                return res.status(400).json({ error: 'Invalid messages format' });
            }
            openaiMessages.push(...sanitizeMessages(messages));
        } else {
            // Few-shot: demonstrate the conversational one-question style
            // including acknowledgement + follow-up pattern
            openaiMessages.push(
                { role: 'user', content: 'Hi, I am here for the interview.' },
                { role: 'assistant', content: `Hi, thanks for taking the time to meet today! I've had a chance to review your background and I'm looking forward to our conversation. To kick things off, can you walk me through your current role and what your day-to-day looks like?` },
                { role: 'user', content: `Sure — I'm currently a team lead at a mid-size tech company. I manage a team of 8 engineers and I'm responsible for sprint planning, code reviews, and shipping features on time.` },
                { role: 'assistant', content: `Got it — managing 8 engineers with ownership over sprint planning and delivery is a solid scope. What's your process for prioritizing work when you have competing deadlines from different stakeholders?` },
                { role: 'user', content: 'Hello, I am ready for my interview.' }
            );
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            // Initial: 200 tokens (greeting + 1 question)
            // Late conversation (8+ messages): 1024 tokens (feedback may be generated)
            // Normal follow-ups: 512 tokens (acknowledgement + question)
            max_tokens: isInitialMessage ? 200 : (Array.isArray(messages) && messages.length >= 8 ? 1024 : 512),
            temperature: 0.7
        });

        let aiMessage = safeContent(response);
        if (!aiMessage) {
            return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
        }

        const containsFeedback = aiMessage.includes('---FEEDBACK_START---');

        // Safety net: strip multi-question responses (skip for feedback)
        if (!containsFeedback) {
            aiMessage = enforceOneQuestion(aiMessage);
        }

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

        // Sanitize all user-supplied fields embedded in prompts
        const safeJobTitle = sanitizeInput(jobTitle);
        const safeIndustry = sanitizeInput(industry) || 'General';
        const safeExperience = sanitizeInput(experienceLevel) || 'Mid-level';

        const systemPrompt = `${MOCK_INTERVIEW_PROMPT}

Context:
- Job Title: ${safeJobTitle}
- Industry: ${safeIndustry}
- Experience Level: ${safeExperience}`;

        const openaiMessages = [
            { role: 'system', content: systemPrompt }
        ];

        const isInitialMessage = messages.length === 0;

        if (!isInitialMessage) {
            openaiMessages.push(...sanitizeMessages(messages));
        } else {
            // Few-shot example to enforce one-question-at-a-time
            openaiMessages.push(
                { role: 'user', content: 'Hi, I want to practice.' },
                { role: 'assistant', content: `Great to have you here! Let's make this a productive session. To start things off — tell me about yourself and your professional background.` },
                { role: 'user', content: 'Hi, I am ready to practice.' }
            );
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            max_tokens: isInitialMessage ? 200 : 1024,
            temperature: 0.7
        });

        let aiMessage = safeContent(response);
        if (!aiMessage) {
            return res.status(502).json({ error: 'AI returned an empty response. Please try again.' });
        }

        // Safety net: strip multi-question responses
        aiMessage = enforceOneQuestion(aiMessage);

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

        // Sanitize all user-supplied fields embedded in prompts
        const safeJobTitle = sanitizeInput(jobTitle) || 'Professional';
        const safeIndustry = sanitizeInput(industry) || 'General';
        const safeQuestion = sanitizeInput(question);

        const systemPrompt = `${QUICK_ANSWER_PROMPT}

Context:
- Job Title: ${safeJobTitle}
- Industry: ${safeIndustry}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `How should I answer this interview question: "${safeQuestion}"` }
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
        if (!validVoices.includes(voice)) {
            return res.status(400).json({ error: 'Invalid voice. Valid options: ' + validVoices.join(', ') });
        }
        const selectedVoice = voice;

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

        // Guard against unexpectedly large audio that could exhaust memory
        if (audioBuffer.length > 5 * 1024 * 1024) {
            console.error(`TTS: Audio too large (${audioBuffer.length} bytes), rejecting`);
            return res.status(502).json({ error: 'Generated audio too large. Please try shorter text.' });
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

// Sanitize error messages to prevent API key leakage in logs
function sanitizeError(msg) {
    if (typeof msg !== 'string') return String(msg);
    return msg.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
}

// Prevent silent crashes — log and keep running
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION (keeping server alive):', sanitizeError(err.message));
    console.error(sanitizeError(err.stack || ''));
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION (keeping server alive):', sanitizeError(String(reason)));
});
