const prisma = require('../db/prisma');

const VALID_KINDS = ['transcription', 'clipAnalysis', 'hookRegen'];

const PROMPT_KINDS = {
    transcription: {
        label: 'Transcription',
        description: 'Sent to Gemini when transcribing each audio chunk.',
        vars: [],
        varDetails: {},
    },
    clipAnalysis: {
        label: 'Clip Analysis',
        description: 'Sent to Gemini to identify the best viral clips from a transcript.',
        vars: ['candidateCount', 'minDuration', 'maxDuration', 'durationText', 'chunkText'],
        varDetails: {
            candidateCount: {
                description: 'How many clip ideas Gemini should return for this transcript.',
                example: '10',
            },
            minDuration: {
                description: 'The shortest allowed clip length, in seconds.',
                example: '20',
            },
            maxDuration: {
                description: 'The longest allowed clip length, in seconds.',
                example: '90',
            },
            durationText: {
                description: 'The source video duration formatted as seconds text.',
                example: '742.35 seconds',
            },
            chunkText: {
                description: 'The timestamped transcript chunks Gemini must choose clips from.',
                example: '[chunk-3] 82.1-111.4s | speakers=unknown | this is the moment...',
            },
        },
    },
    hookRegen: {
        label: 'Hook Regeneration',
        description: 'Sent to Gemini to generate a new on-screen hook text for a clip.',
        vars: ['currentHookText', 'clipTitle', 'clipTranscript'],
        varDetails: {
            currentHookText: {
                description: 'The hook currently saved on the clip, used so Gemini can avoid repeating it.',
                example: 'he instantly regretted this',
            },
            clipTitle: {
                description: 'The existing clip title, used as context for the regenerated hook.',
                example: 'Streamer wins with one HP',
            },
            clipTranscript: {
                description: 'The transcript text covered by the selected clip.',
                example: 'I thought the round was over, but then the last shot actually landed.',
            },
        },
    },
};

const DEFAULT_PROMPTS = {
    transcription:
        "Transcribe this audio with word-level timestamps. All timestamps must be relative to the start of this audio — the first sample is 00:00:000. " +
        "Return a JSON array of objects, each with 'start' (MM:SS:mmm), 'end' (MM:SS:mmm), and 'text' (one word). " +
        "Example: [{'start':'00:00:000','end':'00:00:450','text':'Hello'}, {'start':'00:00:450','end':'00:00:890','text':'world'}]",

    clipAnalysis:
        `You are a viral short-form content strategist identifying the strongest clips from a timestamped transcript for TikTok, YouTube Shorts, and Instagram Reels.

## Your Goal
Find the top {{candidateCount}} moments that will perform best as standalone clips. Think like a creator with 10M followers: you are looking for moments that stop the scroll, create an emotional reaction, and leave viewers wanting more.

## Virality Scoring Rubric
Score each clip 0-100 by summing these weighted sub-scores:

1. **Hook Strength (0-30)**: Does the opening line immediately grab attention? Does the clip start mid-action or with a provocative statement? High score = viewer cannot scroll past without watching.
2. **Payoff/Punchline (0-25)**: Is there a satisfying conclusion, surprise twist, or laugh? Does it deliver on the implicit promise of the opening?
3. **Emotional Spike (0-15)**: Does it trigger laughter, shock, inspiration, cringe, awe, or anger? Neutral moments score 0.
4. **Novelty/Insight (0-15)**: Does it teach something surprising, challenge a common belief, or offer a counterintuitive take? Generic advice scores 0.
5. **Standalone Clarity (0-15)**: Can someone who has never seen the original video fully understand this clip without context? Full context = 15, requires prior knowledge = 0.

Sum sub-scores to get viralityScore.

## Clip Selection Rules
- Use ONLY timestamps from the provided chunks. Never invent timestamps.
- Prefer continuous clips (startSec/endSec). Use multi-segment clips ONLY when cutting dead air between two tightly related moments.
- Each clip must be {{minDuration}}-{{maxDuration}} seconds total.
- Start slightly before the setup moment, end after the payoff lands.
- Reject: vague context, lengthy intros/outros, dead air >3 seconds, repeated filler.
- Each clip must be self-contained — if the clip requires the viewer to know who/what is being referenced, expand the start to include that context or skip the clip.
- No two clips should cover the same story beat (aggressive deduplication — prefer diversity of topics).

## Hook Text Rules
Write a 3-10 word top-overlay hook that will be displayed on screen. This is the MOST important element:
- Use curiosity gaps ("The thing nobody tells you about X")
- Use contrarian takes ("Everyone's wrong about X")
- Use pattern interrupts ("Wait, WHAT?")
- Use specific numbers or stakes ("Lost $50k because of this")
- NEVER write: "In this clip...", "Watch as...", "This video shows...", "Here's how..."
- The hook must match the tone and content of the specific moment, not the overall video.

## Tags
Assign 1-4 tags from: funny, insight, controversy, story, advice, mistake, reaction, debate, achievement, warning

## Output
Return JSON array sorted by viralityScore descending. For continuous clips use startSec+endSec. For multi-segment use segments[].

Video duration: {{durationText}}

Timestamped transcript chunks:
{{chunkText}}`,

    hookRegen:
        `Create one new short creator overlay hook for this video clip.

Rules:
- Return a hook only, not a title or explanation.
- 3-10 words.
- Write it like YouTube Shorts/TikTok top-overlay setup text, not a polished title.
- Make viewers want to see what happens next, not understand the whole clip.
- Use casual, punchy, creator-style phrasing.
- Prefer setup lines, cliffhangers, reaction teases, bold claims, or occasional questions.
- Questions are allowed, but most hooks should be statements unless the clip naturally fits a question.
- Avoid generic summaries like "A funny moment from the video" or "Discussion about gaming strategy".
- Do not use title case unless it naturally fits the phrase.
- Good hook examples:
  - "look what this guy did:"
  - "he instantly regretted this"
  - "this should not have worked"
  - "wait for his reaction"
  - "then everything changed"
  - "a $5 mouse can do this?"
  - "bro thought he had it"
  - "this got awkward fast"
  - "nobody expected that ending"
  - "he said it too early"
- Avoid reusing this current hook: "{{currentHookText}}"

Clip title: {{clipTitle}}
Clip transcript: {{clipTranscript}}`,
};

const cache = {};

async function getActivePromptBody(kind) {
    if (cache[kind] !== undefined) return cache[kind];
    const row = await prisma.promptTemplate.findFirst({ where: { kind, isActive: true } });
    const body = row ? row.body : DEFAULT_PROMPTS[kind];
    cache[kind] = body;
    return body;
}

function renderPrompt(body, vars = {}) {
    return body.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''));
}

function invalidateCache(kind) {
    if (kind) {
        delete cache[kind];
    } else {
        VALID_KINDS.forEach(k => delete cache[k]);
    }
}

module.exports = {
    VALID_KINDS,
    PROMPT_KINDS,
    DEFAULT_PROMPTS,
    getActivePromptBody,
    renderPrompt,
    invalidateCache,
};
