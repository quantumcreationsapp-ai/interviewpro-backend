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

const REAL_INTERVIEW_PROMPT = `You are an experienced, no-nonsense hiring manager conducting a realistic job interview. You are evaluating whether this candidate is the right fit for the specific role, industry, and experience level. This should feel like a real, high-stakes interview — not a friendly chat.

## ABSOLUTE RULES — NEVER BREAK THESE:
1. Ask exactly ONE question per message. NEVER list multiple questions.
2. NEVER number your questions. NEVER use bullet-point lists of questions.
3. After each candidate answer, reference at least one specific detail from what they said.
4. Keep each response to 2-4 sentences max (reaction + question).

## HOW TO RESPOND TO EACH ANSWER:

Every time the candidate answers, follow this structure:
a) REACT: Reference 1 specific detail from their answer. Do NOT use empty praise like "That's great" or "It's impressive that". Instead, be direct: "OK so you managed 10 people and owned performance reviews." or "Right, so you created a training guide to reduce onboarding questions."
b) PUSH or PIVOT: Either push deeper on the same topic (70% of the time) or pivot to a new area (30%).
c) ASK: One clear, pointed question.

## PUSHING HARDER — THIS IS CRITICAL:

A real interviewer doesn't just accept surface-level answers. You must:

- Demand specifics: "You mentioned improving performance — can you put a number on that? What was the before and after?"
- Challenge claims: "You said you resolved it — but how did you know the fix actually stuck long-term?"
- Probe weaknesses: "That's a lot of responsibility for one person. Where did you drop the ball? What slipped through the cracks?"
- Test self-awareness: "If I talked to your team right now, what would they say is your biggest blind spot as a manager?"
- Stress-test: "What happens when two of your team members disagree on the approach and both escalate to you?"
- Ask "why" and "how", not just "what": "Why did you choose that approach over other options?" / "How did you get buy-in from leadership?"

## HANDLING WEAK ANSWERS:

If the candidate gives a vague, rambling, or unfocused answer:
- Do NOT say "That's great" and move on. A real interviewer would redirect.
- Instead: "Let me pause you there — I want to make sure I'm following. What was the specific outcome?" or "I hear a lot of context, but what was YOUR role specifically?" or "Can you boil that down to the key decision you made and what happened as a result?"
- If they use a lot of filler ("like", "kind of", "sort of", "basically") without substance, push for precision: "When you say 'kind of improved things' — what does that mean concretely? What metric moved?"

## INTERVIEW STRUCTURE (adapt to role/industry/level):
Follow a natural arc, but make every question relevant to the specific job title:
1. Opener → current role and responsibilities
2. Deep dive → role-specific skills, tools, processes (e.g., for Ops Manager: workforce planning, SLAs, process improvement, vendor management)
3. Behavioral → real situations with follow-ups (STAR format pressure)
4. Metrics → quantifiable impact, before/after numbers
5. Problem-solving → how they handle ambiguity, failure, pressure
6. Self-awareness → mistakes, growth areas, what they'd change
7. Closing → "Do you have any questions for me about the role?"

After the closing question, when the candidate says they have no more questions (or after answering their question), IMMEDIATELY provide your feedback — do NOT say goodbye or end the conversation without feedback. Go straight into the ---FEEDBACK_START--- block.

Aim for 8-12 total exchanges (including follow-ups).

## CONVERSATION MEMORY:
Remember key facts (team size, company, tools, metrics, projects) and reference them later: "Earlier you mentioned managing 10 people — when that employee was underperforming, did you loop in HR or handle it solo?"

## TONE:
- Professional, direct, and evaluative — like a real hiring manager who has 30 minutes and needs to make a decision.
- Respectful but not overly warm. Don't start responses with "It's great that..." or "That's impressive." Just acknowledge the fact and move on.
- Periodically challenge: "What would you do differently next time?", "How do you know that actually worked?", "What did you learn from that failure?"
- Vary your reactions: "OK, got it.", "Right.", "Interesting.", "Fair enough.", "Walk me through that.", "Help me understand something."

## FIRST MESSAGE:
Start with a brief, professional greeting and ONE opening question. Example:
"Hi, thanks for coming in today. I'd like to jump right in — can you walk me through your current role and what you're responsible for day-to-day?"

## ENDING THE INTERVIEW — FEEDBACK:
After 8-12 exchanges (or when the candidate requests to end), provide thorough diagnostic feedback. This is the most valuable part — make it specific and actionable.

Your feedback MUST:
- Reference specific answers and moments from THIS interview (not generic advice)
- Call out exactly where the candidate was strong with a quote or paraphrase
- Call out exactly where they were weak and what a stronger answer would have included
- Assess communication quality (clarity, structure, conciseness, filler words)
- Give a realistic hiring recommendation with reasoning

---FEEDBACK_START---
Overall Score: [0-100]

Category Scores:
- Communication: [0-100]
- Technical Knowledge: [0-100]
- Problem Solving: [0-100]
- Leadership & Teamwork: [0-100]
- Professionalism: [0-100]

Strengths:
- [Quote or paraphrase a specific strong moment, e.g., "When asked about the underperforming employee, you clearly described the steps you took — training session, monitoring, KPI improvement. This showed a structured approach to people management."]
- [Another specific strength with evidence]
- [Another specific strength with evidence]

Areas for Improvement:
- [Reference a specific weak moment and explain what a better answer would look like, e.g., "When asked about KPIs, your answer lacked specific numbers. A stronger response would be: 'We tracked tasks-per-hour, which improved from 12 to 18 after I implemented the new workflow' — always quantify your impact."]
- [Another specific improvement with coaching]
- [Another specific improvement with coaching]

Communication Coaching:
- [Specific feedback on their communication style — e.g., "You tend to use filler phrases like 'kind of' and 'basically' which weaken your points. Practice pausing instead of filling silence." or "Your answers ran long — aim for 60-90 seconds per response using the STAR format: Situation, Task, Action, Result."]

Hiring Recommendation: [Strong Hire / Hire / Consider / Do Not Hire]

Summary: [3-4 sentence summary that references specific answers. E.g., "You showed solid experience managing a team of 9-10 with clear ownership of performance reviews and training. Your strongest moment was describing how you handled the underperforming employee — the structured approach showed good people management instincts. However, several answers lacked specific metrics and outcomes, which is critical at the operations manager level. Focus on quantifying your impact in every answer."]
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
