# InterviewPro AI Backend

Backend server for the InterviewPro AI iOS app. 100% powered by OpenAI - GPT-4o for interview AI and TTS for natural voice synthesis.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        iOS App                                   │
│                    (InterviewPro AI)                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend Server                               │
│                  (Node.js + Express)                             │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐   │
│  │ /api/real-      │  │ /api/mock-      │  │ /api/quick-    │   │
│  │ interview       │  │ interview       │  │ answer         │   │
│  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘   │
│           │                    │                    │            │
│           └────────────────────┼────────────────────┘            │
│                                ▼                                 │
│                    ┌───────────────────────┐                     │
│                    │     OpenAI GPT-4o     │                     │
│                    │                       │                     │
│                    │ • Interview questions │                     │
│                    │ • Feedback & scoring  │                     │
│                    │ • Coaching responses  │                     │
│                    └───────────────────────┘                     │
│                                                                  │
│  ┌─────────────────┐                                             │
│  │   /api/tts      │                                             │
│  └────────┬────────┘                                             │
│           ▼                                                      │
│  ┌───────────────────────┐                                       │
│  │    OpenAI TTS API     │                                       │
│  │                       │                                       │
│  │ • Natural voices      │                                       │
│  │ • MP3 audio output    │                                       │
│  │ • 6 voice options     │                                       │
│  └───────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

## How It Works

### Interview Flow

1. **User speaks** → iOS app converts speech to text
2. **Text sent to backend** → `/api/real-interview` or `/api/mock-interview`
3. **Backend calls Claude** → AI generates response
4. **Response sent to iOS** → Text displayed in chat
5. **iOS calls TTS** → `/api/tts` with response text
6. **Backend calls OpenAI** → Generates natural audio
7. **Audio sent to iOS** → Played through speakers

### TTS (Text-to-Speech)

The `/api/tts` endpoint converts text to natural speech:

```
POST /api/tts
Content-Type: application/json

{
  "text": "Hello! Let's begin your interview.",
  "voice": "nova"
}

Response: audio/mpeg (binary MP3 data)
```

**Available Voices:**

| Voice | Description | Best For |
|-------|-------------|----------|
| `nova` | Female, warm and friendly | **Recommended** - Interviewer |
| `alloy` | Neutral, balanced | General use |
| `echo` | Male, warm | Friendly coach |
| `fable` | Male, British accent | Professional |
| `onyx` | Male, deep and authoritative | Serious interviews |
| `shimmer` | Female, clear and expressive | Energetic |

## Setup

### 1. Install Dependencies

```bash
cd interviewpro-backend
npm install
```

### 2. Set Environment Variables

Create a `.env` file or set these in your hosting platform:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

**Get API Key:**
- OpenAI: https://platform.openai.com/api-keys

### 3. Run Locally

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

### 4. Test Endpoints

```bash
# Health check
curl http://localhost:3000/

# Test TTS
curl -X POST http://localhost:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test.", "voice": "nova"}' \
  --output test.mp3
```

## Deploy to Render

### 1. Create New Web Service

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New** → **Web Service**
3. Connect your GitHub repo (or use manual deploy)

### 2. Configure Service

- **Name:** `interviewpro-backend`
- **Region:** Choose closest to your users
- **Branch:** `main`
- **Runtime:** `Node`
- **Build Command:** `npm install`
- **Start Command:** `npm start`

### 3. Add Environment Variables

In Render Dashboard → Environment:

| Key | Value |
|-----|-------|
| `OPENAI_API_KEY` | `sk-xxxx...` |
| `NODE_ENV` | `production` |

### 4. Deploy

Click **Deploy** and wait for build to complete.

Your API will be available at:
```
https://interviewpro-backend-xxxx.onrender.com
```

## Update iOS App

Update the base URL in your iOS app's `APIService.swift`:

```swift
private let baseURL = "https://interviewpro-backend-xxxx.onrender.com"
```

And in `TTSService.swift`:

```swift
private let baseURL = "https://interviewpro-backend-xxxx.onrender.com"
```

## Cost Estimation

### OpenAI GPT-4o (Chat/Interview AI)

- **Model:** gpt-4o
- **Cost:** ~$2.50 per million input tokens, ~$10 per million output tokens
- **Per interview (10 exchanges):** ~$0.03 - $0.08

### OpenAI TTS

- **Model:** tts-1
- **Cost:** $0.015 per 1,000 characters
- **Per interview (10 responses, ~500 words each):** ~$0.50

### Monthly Estimate (1,000 users, 5 interviews each)

| Service | Usage | Cost |
|---------|-------|------|
| GPT-4o | 5,000 interviews | ~$250 |
| OpenAI TTS | 5,000 interviews | ~$2,500 |
| **Total** | | ~$2,750/month |

**Tip:** Consider caching common responses or using `tts-1` (standard) instead of `tts-1-hd` to reduce costs.

## API Reference

### POST /api/real-interview

Formal interview with scoring.

```json
{
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "interviewer", "content": "Hi, let's begin..."}
  ],
  "jobTitle": "Software Engineer",
  "industry": "Technology",
  "experienceLevel": "Mid-level",
  "interviewType": "Behavioral and Technical"
}
```

### POST /api/mock-interview

Casual practice with AI coach.

```json
{
  "messages": [...],
  "jobTitle": "Product Manager",
  "industry": "Finance",
  "experienceLevel": "Senior"
}
```

### POST /api/quick-answer

Get answer to any interview question.

```json
{
  "question": "Tell me about yourself",
  "jobTitle": "Data Scientist",
  "industry": "Healthcare"
}
```

### POST /api/tts

Convert text to speech.

```json
{
  "text": "Your interview response here...",
  "voice": "nova"
}
```

Returns: `audio/mpeg` binary data
