const express = require('express');
const router = express.Router();
const Transcript = require('../models/Transcript');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { generateJsonContent } = require('../utils/gemini');
const {
    buildGeneratedClipsMap,
    normalizeClipHook,
    normalizeTranscriptClips
} = require('../utils/clipVideos');
const {
    loadBlockedWordTerms,
    moderateClipLanguage
} = require('../utils/clipModeration');

router.post('/:transcriptId', async (req, res) => {
    try {
        const transcriptDoc = await Transcript.findById(req.params.transcriptId);
        if (!transcriptDoc) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }

        // Join transcript segments into a single string for analysis by the LLM
        const fullTranscriptText = transcriptDoc.transcript.map(segment => segment.text).join(' ');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const blockedTerms = loadBlockedWordTerms();
        const videoDurationText = transcriptDoc.duration ? ` The video is ${Math.floor(transcriptDoc.duration / 60)}:${String(Math.floor(transcriptDoc.duration % 60)).padStart(2, '0')} long.` : '';
        
        const maxTimeFormatted = Math.floor(transcriptDoc.duration / 60) + ':' + String(Math.floor(transcriptDoc.duration % 60)).padStart(2, '0');
        
        const prompt = `Given the following transcript, propose 3-5 video clips that would make engaging short content.${videoDurationText}

CRITICAL CONSTRAINTS:
- Video duration is EXACTLY ${videoDurationText ? maxTimeFormatted : 'unknown'} - DO NOT suggest any timestamps beyond this
- Each clip should be 30-90 seconds total duration
- All timestamps must be in MM:SS format and within 0:00 to ${maxTimeFormatted}

You can suggest two types of clips:

1. SINGLE SEGMENT clips: One continuous segment from start time to end time
2. MULTI-SEGMENT clips: Multiple segments that when combined tell a coherent story

For single segments: provide 'start' and 'end' times in MM:SS format.
For multi-segments: provide an array of segments in 'segments' field, each with 'start' and 'end' times.

VALIDATION RULES:
- Every timestamp must be ≤ ${maxTimeFormatted}
- Total duration must be 30-90 seconds
- Focus on complete thoughts or exchanges
- Ensure segments make sense when combined
- Include a short curiosity hook for each clip in the style of YouTube Shorts/TikTok setup text.
- Hooks should make the viewer want to see what happens next, not summarize the clip.
- Use a mix of hook shapes: setup lines, cliffhangers, reaction teases, bold claims, and occasional questions.
- Questions are allowed, but most hooks should not be questions unless the clip naturally fits one.
- Good hook examples: "look what this guy did:", "he instantly regretted this", "this should not have worked", "wait for his reaction", "then everything changed", "a $5 mouse can do this?"
- Avoid generic summaries like "Discussion about gaming strategy" or "A funny moment from the video".
- Keep hooks casual, specific, punchy, and written like creator overlay text.
- Also review each proposed clip for profanity, slurs, or sexually explicit language in the transcript window it uses.
- Set 'languageFlag' to true when the proposed clip should be hidden for language, and include a short 'languageReason'.

Output format: JSON array where each object has:
- 'title': descriptive title
- 'hook': curiosity-driven creator overlay text, 3-10 words. Prefer statements or setup phrases; use questions sparingly.
- 'languageFlag': boolean moderation signal for profanity/explicit language
- 'languageReason': short explanation when flagged
- For single segments: 'start' and 'end' fields  
- For multi-segments: 'segments' array with objects containing 'start' and 'end'

Transcript: ${fullTranscriptText}`;

        const { data: suggestedClips, model: resolvedModel } = await generateJsonContent({
            genAI,
            logLabel: `Clip analysis for ${transcriptDoc._id}`,
            contents: [{
                role: 'user',
                parts: [{ text: prompt }],
            }],
            responseSchema: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    properties: {
                        title: { type: 'STRING' },
                        hook: { type: 'STRING' },
                        languageFlag: { type: 'BOOLEAN' },
                        languageReason: { type: 'STRING' },
                        start: { type: 'STRING' },
                        end: { type: 'STRING' },
                        segments: {
                            type: 'ARRAY',
                            items: {
                                type: 'OBJECT',
                                properties: {
                                    start: { type: 'STRING' },
                                    end: { type: 'STRING' },
                                },
                                required: ['start', 'end'],
                            },
                        },
                    },
                    required: ['title'],
                    propertyOrdering: ['title', 'hook', 'languageFlag', 'languageReason', 'start', 'end', 'segments'],
                },
            },
            safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
            ],
        });
        console.log(`Clip analysis for ${transcriptDoc._id} used Gemini model: ${resolvedModel}`);
        
        // Convert MM:SS time format to seconds for database storage
        const convertTimeToSeconds = (timeString) => {
            const [minutes, seconds] = timeString.split(':').map(Number);
            return minutes * 60 + seconds;
        };

        // Validate and process clips
        const validatedClips = [];
        let filteredClipCount = 0;
        const videoDurationSeconds = transcriptDoc.duration || Infinity;
        
        console.log(`Video duration: ${videoDurationSeconds}s (${Math.floor(videoDurationSeconds / 60)}:${String(videoDurationSeconds % 60).padStart(2, '0')})`);
        console.log('Raw suggestions from Gemini:', JSON.stringify(suggestedClips, null, 2));

        for (const clip of suggestedClips) {
            try {
                let totalDuration = 0;
                const hookText = typeof clip.hook === 'string' ? clip.hook.trim() : '';
                let processedClip = {
                    title: clip.title,
                    hook: normalizeClipHook({
                        text: hookText,
                        enabled: Boolean(hookText),
                        updatedAt: hookText ? new Date().toISOString() : null
                    })
                };

                if (clip.segments && Array.isArray(clip.segments)) {
                    // Multi-segment clip
                    const processedSegments = [];
                    for (const segment of clip.segments) {
                        const startSeconds = convertTimeToSeconds(segment.start);
                        const endSeconds = convertTimeToSeconds(segment.end);
                        
                        // Validate segment is within video duration
                        if (startSeconds < 0 || endSeconds > videoDurationSeconds || startSeconds >= endSeconds) {
                            console.warn(`Invalid segment in clip "${clip.title}": ${segment.start}-${segment.end} (${startSeconds}s-${endSeconds}s vs max ${videoDurationSeconds}s)`);
                            continue;
                        }
                        
                        processedSegments.push({
                            start: startSeconds,
                            end: endSeconds
                        });
                        totalDuration += (endSeconds - startSeconds);
                    }
                    
                    if (processedSegments.length > 0 && totalDuration >= 30 && totalDuration <= 90) {
                        processedClip.segments = processedSegments;
                        processedClip.totalDuration = totalDuration;
                        const moderationResult = moderateClipLanguage({
                            transcriptSegments: transcriptDoc.transcript,
                            clip: processedClip,
                            blockedTerms,
                            geminiFlag: clip.languageFlag,
                            geminiReason: clip.languageReason
                        });

                        if (moderationResult.isBlocked) {
                            filteredClipCount += 1;
                            console.warn(`✗ Filtered multi-segment clip "${clip.title}" for language. Local matches: ${moderationResult.localMatches.join(', ') || 'none'}. Gemini flag: ${moderationResult.geminiFlag}. Reason: ${moderationResult.geminiReason || 'n/a'}`);
                            continue;
                        }

                        validatedClips.push(processedClip);
                        console.log(`✓ Valid multi-segment clip: "${clip.title}" - ${processedSegments.length} segments, ${totalDuration}s total`);
                    } else {
                        const reason = processedSegments.length === 0 ? 'no valid segments' : 
                                     totalDuration < 30 ? 'too short' : 'too long';
                        console.warn(`✗ Rejected multi-segment clip: "${clip.title}" - ${processedSegments.length} segments, ${totalDuration}s total (${reason})`);
                    }
                } else if (clip.start && clip.end) {
                    // Single segment clip
                    const startSeconds = convertTimeToSeconds(clip.start);
                    const endSeconds = convertTimeToSeconds(clip.end);
                    totalDuration = endSeconds - startSeconds;
                    
                    // Validate single segment
                    if (startSeconds >= 0 && endSeconds <= videoDurationSeconds && 
                        startSeconds < endSeconds && totalDuration >= 30 && totalDuration <= 90) {
                        processedClip.start = startSeconds;
                        processedClip.end = endSeconds;
                        processedClip.totalDuration = totalDuration;
                        const moderationResult = moderateClipLanguage({
                            transcriptSegments: transcriptDoc.transcript,
                            clip: processedClip,
                            blockedTerms,
                            geminiFlag: clip.languageFlag,
                            geminiReason: clip.languageReason
                        });

                        if (moderationResult.isBlocked) {
                            filteredClipCount += 1;
                            console.warn(`✗ Filtered single clip "${clip.title}" for language. Local matches: ${moderationResult.localMatches.join(', ') || 'none'}. Gemini flag: ${moderationResult.geminiFlag}. Reason: ${moderationResult.geminiReason || 'n/a'}`);
                            continue;
                        }

                        validatedClips.push(processedClip);
                    } else {
                        console.warn(`✗ Rejected single clip "${clip.title}": ${clip.start}-${clip.end} (duration: ${totalDuration}s, video: ${videoDurationSeconds}s)`);
                    }
                }
            } catch (error) {
                console.warn(`Error processing clip "${clip.title}":`, error);
            }
        }

        console.log(`Final result: ${validatedClips.length} visible clips out of ${suggestedClips.length} suggested (${filteredClipCount} filtered for language)`);

        transcriptDoc.clips = validatedClips;
        transcriptDoc.analysisMetadata = {
            filteredClipCount,
            visibleClipCount: validatedClips.length,
            suggestedClipCount: Array.isArray(suggestedClips) ? suggestedClips.length : 0,
            blockedWordSource: 'backend/config/blocked-words.json',
            analyzedAt: new Date().toISOString()
        };
        const updatedTranscript = await Transcript.findByIdAndUpdate(transcriptDoc._id, transcriptDoc);
        const normalizedClips = normalizeTranscriptClips(updatedTranscript);

        res.json({
            ...updatedTranscript,
            clips: normalizedClips,
            generatedClips: buildGeneratedClipsMap(normalizedClips)
        });

    } catch (err) {
        console.error(`Server error during analysis: ${err}`);
        res.status(500).json({ error: 'Failed to analyze transcript and generate clips.' });
    }
});

module.exports = router; 
