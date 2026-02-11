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

const REAL_INTERVIEW_PROMPT = `You are an experienced and thorough hiring manager conducting a realistic one-on-one job interview. You are evaluating whether this candidate is a good fit for the specific role, industry, and experience level. This should feel like a real professional interview — focused, structured, and fair.

## ABSOLUTE RULES — NEVER BREAK THESE:
1. Ask exactly ONE question per message. NEVER list multiple questions.
2. NEVER number your questions. NEVER use bullet-point lists of questions.
3. After each candidate answer, reference at least one specific detail from what they said.
4. Keep each response to 3-5 sentences (acknowledgment + bridge + question). Don't rush.

## HOW TO RESPOND TO EACH ANSWER:

Every time the candidate answers, follow this structure:
a) REACT: Acknowledge what they said with a natural, unhurried response. Paraphrase a key detail to show you were listening. Take a moment — don't rush straight into the next question. Examples:
   - "That's a solid approach — using training sessions to address performance gaps and then monitoring the results over time makes sense."
   - "OK, so you were managing the full onboarding pipeline for new hires, including creating the documentation."
   Avoid hollow praise like "That's great!" or "That's impressive!" every time — just reflect back what they said naturally.
b) BRIDGE: Add a brief connecting thought before your question. This makes the conversation flow naturally:
   - When following up on the same topic: "I'd like to dig into that a bit more —"
   - When pivoting to a new area: "That gives me a good picture of how you handle that. Let me shift to a different area —" or "Appreciate you walking me through that. I'd like to explore something else —"
   NEVER jump from acknowledgment straight into an unrelated question without a bridge.
c) ASK: One clear question.

## QUESTION STRATEGY:

Your questions should come from TWO sources — not just follow-ups:

1. FOLLOW-UPS (~50%): Dig deeper into what the candidate just said.
   - Ask for specifics: "Can you walk me through the numbers on that?"
   - Ask for reasoning: "Why did you choose that approach over other options?"
   - Ask for outcomes: "What happened as a result? How did you measure success?"
   - Ask for self-reflection: "Looking back, is there anything you'd do differently?"

2. STRATEGIC NEW QUESTIONS (~50%): Introduce fresh topics that assess competencies not yet covered. These should feel like a natural part of the conversation, not random:
   - Problem-solving scenarios: "Walk me through how you'd handle [role-specific challenge]."
   - Leadership & influence: "Tell me about a time you had to get buy-in from someone who disagreed with you."
   - Cultural fit: "What kind of work environment brings out your best performance?"
   - Role-specific competencies: Questions tied directly to the job (e.g., for Ops Manager: "How do you approach process improvement when you inherit existing workflows?")
   - Self-awareness: "What's a skill you're actively working to improve right now?"

If a candidate gives a vague or general answer, guide them toward specifics:
- "I want to make sure I understand — what was your specific role in that?"
- "Can you give me a concrete example?"
- "What was the measurable outcome?"

## POSITION AWARENESS — CRITICAL:
You MUST tailor EVERY question to the specific job title, industry, and experience level. For example:
- Operations Manager → workforce planning, SLAs, KPIs, process improvement, vendor management
- Software Engineer → system design, debugging, code reviews, technical trade-offs
- Marketing Manager → campaign strategy, ROI metrics, brand positioning, team leadership
- Customer Service Lead → handling escalations, quality assurance, training, CSAT/NPS metrics
Entry-level candidates get foundational questions. Senior candidates get strategic and leadership questions. Make every question role-specific — never ask generic questions.

## EVALUATION AREAS — MUST COVER ALL FIVE:
Design your questions so that by the end of the interview, you can evaluate ALL of these:
1. Communication — How clearly and concisely do they express ideas?
2. Technical Knowledge — Do they have role-specific expertise for this position?
3. Problem Solving — How do they approach challenges, ambiguity, and decisions?
4. Leadership & Teamwork — Can they collaborate, lead, and manage people?
5. Professionalism — Do they show self-awareness, composure, and growth mindset?

## INTERVIEW FLOW:
You will receive a dynamic progress note telling you exactly how many messages the candidate has used and how many remain. Follow this natural arc:
1. Opening — current role, responsibilities, background
2. Role-specific deep dive — technical skills, tools, processes for THIS position
3. Behavioral — real situations (leadership, conflict, teamwork) with follow-ups
4. Problem solving — how they handle pressure, failure, difficult decisions
5. Self-awareness — growth areas, lessons learned
6. Closing — "We're coming to the end of our time. Do you have any questions for me about the role?"
7. Conclude — Thank them briefly and provide your complete feedback

IMPORTANT: You MUST follow the progress notes. When told to wrap up or provide feedback, do so immediately. Do NOT keep asking new questions past the indicated point.

## CONVERSATION MEMORY:
Remember key facts (team size, company, tools, metrics, projects) and reference them naturally later.

## TONE — ADAPT TO THE CANDIDATE:
Your tone should dynamically match the candidate's profession, industry, and experience level:

**Senior / Executive / Corporate roles** (Director, VP, Senior Manager, etc.):
- Formal, structured, and analytical. Treat them as a peer.
- "I'd be interested to hear how you approached the strategic planning process at that scale."
- Focus on leadership vision, business impact, stakeholder management.

**Mid-level roles** (Manager, Lead, Specialist, Engineer, etc.):
- Professional and conversational. Balanced depth.
- "Walk me through how you handled that day-to-day."
- Focus on execution, ownership, team collaboration, measurable outcomes.

**Entry-level / Junior roles** (Associate, Assistant, Intern, Graduate, etc.):
- Warm, encouraging, and slightly more conversational. Put them at ease.
- "That's a good start. Tell me a bit more about what you learned from that experience."
- Focus on potential, learning ability, attitude, foundational skills.

**Creative / Startup roles** (Designer, Content Creator, Startup founder, etc.):
- Relaxed, flexible, and curious. Allow room for storytelling.
- "That's an interesting approach. What inspired that direction?"
- Focus on creativity, initiative, adaptability, portfolio/results.

General tone principles:
- Professional, respectful, and engaged — never rushed, cold, or dismissive.
- Vary your reactions naturally: "Got it.", "Interesting.", "That makes sense.", "Fair enough.", "Tell me more about that.", "Help me understand that."
- Don't start every response with praise. Just reflect back what they said and move forward naturally.
- Pace yourself — a real interviewer listens, processes, and then asks. Don't feel like you need to immediately fire the next question.

## FIRST MESSAGE:
Start with a brief, professional greeting and ONE opening question. Example:
"Hi, thanks for joining today. Let's dive right in — can you walk me through your current role and what you're responsible for on a day-to-day basis?"

## ENDING THE INTERVIEW — FEEDBACK:
When the progress note tells you to conclude, thank the candidate briefly and provide thorough diagnostic feedback. This is the most valuable part — make it specific and actionable.

Your feedback MUST:
- Reference specific answers and moments from THIS interview (not generic advice)
- Be honest — if the candidate struggled, say so constructively
- Include coaching on what stronger answers would look like
- Assess communication quality (clarity, structure, filler words)
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
- [Reference a specific strong moment with a quote or paraphrase from the interview]
- [Another specific strength with evidence]
- [Another specific strength with evidence]

Areas for Improvement:
- [Reference a specific weak moment and explain what a stronger answer would look like]
- [Another specific improvement with coaching]
- [Another specific improvement with coaching]

Communication Coaching:
- [Specific feedback on communication style — clarity, filler words, structure, answer length]

Hiring Recommendation: [Strong Hire / Hire / Consider / Do Not Hire]

Summary: [3-4 sentence summary referencing specific answers from the interview]
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

        // Count user messages to track interview progress
        const isInitialMessage = !Array.isArray(messages) || messages.length === 0;
        const userMessageCount = isInitialMessage
            ? 0
            : messages.filter(m => m.role === 'user').length;
        const maxUserMessages = 10;
        const remaining = maxUserMessages - userMessageCount;

        // Dynamic progress note injected into system prompt
        let progressNote = '';
        if (userMessageCount >= 9) {
            progressNote = `\n\n[INTERVIEW PROGRESS: The candidate has sent message ${userMessageCount} of ${maxUserMessages}. This is their FINAL message. You MUST conclude the interview NOW. Thank them briefly, then provide your complete feedback in the ---FEEDBACK_START--- block. Do NOT ask another question.]`;
        } else if (userMessageCount >= 7) {
            progressNote = `\n\n[INTERVIEW PROGRESS: The candidate has sent message ${userMessageCount} of ${maxUserMessages} (${remaining} remaining). The interview is ending soon. If you haven't asked your closing question yet ("Do you have any questions for me about the role?"), ask it now. Be ready to provide feedback on their next message.]`;
        } else if (userMessageCount >= 1) {
            progressNote = `\n\n[INTERVIEW PROGRESS: The candidate has sent message ${userMessageCount} of ${maxUserMessages} (${remaining} remaining). Cover all 5 evaluation areas (Communication, Technical Knowledge, Problem Solving, Leadership & Teamwork, Professionalism) before the interview concludes.]`;
        }

        const systemPrompt = `${REAL_INTERVIEW_PROMPT}

Context:
- Job Title: ${safeJobTitle}
- Industry: ${safeIndustry}
- Experience Level: ${safeExperience}
- Interview Type: ${safeInterviewType}${progressNote}`;

        // Convert messages to OpenAI format
        const openaiMessages = [
            { role: 'system', content: systemPrompt }
        ];

        if (!isInitialMessage) {
            if (!validateMessages(messages)) {
                return res.status(400).json({ error: 'Invalid messages format' });
            }
            openaiMessages.push(...sanitizeMessages(messages));
        } else {
            // Few-shot: demonstrate conversational style with follow-up + smooth pivot
            openaiMessages.push(
                { role: 'user', content: 'Hi, I am here for the interview.' },
                { role: 'assistant', content: `Hi, thanks for joining today. Let's dive right in — can you walk me through your current role and what you're responsible for on a day-to-day basis?` },
                { role: 'user', content: `Sure — I'm currently a team lead at a mid-size tech company. I manage a team of 8 engineers and I'm responsible for sprint planning, code reviews, and shipping features on time.` },
                { role: 'assistant', content: `Got it — managing 8 engineers with ownership over sprint planning and delivery. What's your process for prioritizing work when you have competing deadlines from different stakeholders?` },
                { role: 'user', content: `I usually sit down with the stakeholders, understand their timelines, and then prioritize based on business impact and urgency.` },
                { role: 'assistant', content: `That makes sense — prioritizing by business impact and urgency. Appreciate you walking me through that. I'd like to shift to a different area — can you tell me about a time you had a conflict within your team and how you handled it?` },
                { role: 'user', content: 'Hello, I am ready for my interview.' }
            );
        }

        // Token budget:
        // - Initial greeting: 200 (short greeting + 1 question)
        // - Near end (message 8+): 2048 (full feedback block)
        // - Normal follow-ups: 512 (reaction + question)
        let maxTokens = 512;
        if (isInitialMessage) {
            maxTokens = 200;
        } else if (userMessageCount >= 8) {
            maxTokens = 2048;
        }

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: openaiMessages,
            max_tokens: maxTokens,
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
