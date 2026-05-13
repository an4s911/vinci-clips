"use client";

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useParams, useRouter } from 'next/navigation';
import ReframeModal from '@/components/ReframeModal';
import CaptionGenerator from '@/components/CaptionGenerator';
import BulkEditModal from '@/components/BulkEditModal';
import { AlertCircle, CheckSquare, Download, ExternalLink, Flame, Loader2, RefreshCcw, Save, Square, StopCircle, Trash2, Wand2 } from 'lucide-react';
import StreamerGameplayCrop from '@/components/StreamerGameplayCrop';
const API_URL = process.env.NEXT_PUBLIC_API_URL;
interface TranscriptSegment {
    start: string;
    end: string;
    text: string;
    speaker?: string;
}

interface ClipSegment {
    start: number;
    end: number;
}

interface ClipVideo {
    id: string;
    type: 'generated' | 'reframed';
    url: string;
    filename: string;
    createdAt: string;
    sourceVideoId: string | null;
    platform: string | null;
    platformName: string | null;
    aspectRatio: string | null;
    captions: { enabled: boolean; style?: string };
    hook?: { enabled: boolean; text?: string };
    clipTimeline?: Array<{
        sourceStart: number;
        sourceEnd: number;
        outputStart: number;
        outputEnd: number;
    }> | null;
    title?: string;
}

interface ProcessingJob {
    status: 'idle' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
    phase: string;
    progressMessage: string;
    error?: string | null;
    errorCode?: string | null;
}

interface ClipGeneration extends ProcessingJob {
    activeOutputUrl?: string | null;
}

interface ClipHook {
    text: string;
    enabled: boolean;
    updatedAt: string | null;
}

interface Clip {
    title: string;
    start?: number;
    end?: number;
    segments?: ClipSegment[];
    totalDuration?: number;
    viralityScore?: number;
    subScores?: { hook?: number; payoff?: number; emotion?: number; novelty?: number; clarity?: number } | null;
    tags?: string[];
    hook: ClipHook;
    videos?: ClipVideo[];
    primaryVideoId?: string | null;
    generation?: ClipGeneration | null;
}

interface Transcript {
    _id: string;
    originalFilename: string;
    transcript: TranscriptSegment[];
    videoUrl?: string;
    mp3Url?: string;
    clips: Clip[];
    createdAt: string;
    status?: 'uploading' | 'converting' | 'transcribing' | 'completed' | 'failed';
    platform?: string | null;
    failureReason?: string | null;
    failedAt?: string | null;
    processingJob?: ProcessingJob | null;
    analysisMetadata?: {
        filteredClipCount?: number;
        visibleClipCount?: number;
        suggestedClipCount?: number;
        blockedWordSource?: string;
        autoGenerateLimit?: number;
        analyzedAt?: string;
    } | null;
    generatedClips?: {[key: number]: ClipVideo & { index: number; title: string }};
}

export default function TranscriptDetailPage() {
    const [transcript, setTranscript] = useState<Transcript | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [analyzing, setAnalyzing] = useState(false);
    const [generatingClips, setGeneratingClips] = useState<{[key: number]: boolean}>({});
    const [generatedClips, setGeneratedClips] = useState<{[key: number]: any}>({});
    const [deletingVersions, setDeletingVersions] = useState<{[key: string]: boolean}>({});
    const [savingHooks, setSavingHooks] = useState<{[key: number]: boolean}>({});
    const [regeneratingHooks, setRegeneratingHooks] = useState<{[key: number]: boolean}>({});
    const [isReframeModalOpen, setIsReframeModalOpen] = useState(false);
    const [selectedClipForReframe, setSelectedClipForReframe] = useState<any>(null);
    const [retryingTranscript, setRetryingTranscript] = useState(false);
    const [cancellingTranscript, setCancellingTranscript] = useState(false);
    const [cancellingClips, setCancellingClips] = useState<{[key: number]: boolean}>({});
    const [selectedClipIndexes, setSelectedClipIndexes] = useState<Set<number>>(new Set());
    const [bulkDownloading, setBulkDownloading] = useState(false);
    const [isCaptionModalOpen, setIsCaptionModalOpen] = useState(false);
    const [captionModalClipIndexes, setCaptionModalClipIndexes] = useState<number[]>([]);
    const [sortOrder, setSortOrder] = useState<'virality' | 'order' | 'duration'>('virality');
    const params = useParams();
    const router = useRouter();
    const id = params.id;

    const seenBannerKey = (key: string) => `seen-banner:${id}:${key}`;
    const hasBannerBeenSeen = (key: string) => localStorage.getItem(seenBannerKey(key)) === '1';
    const markBannerSeen = (key: string) => localStorage.setItem(seenBannerKey(key), '1');

    const fetchTranscript = useCallback(async () => {
        const response = await axios.get(`${API_URL}/clips/transcripts/${id}`);
        setTranscript(response.data);
        setGeneratedClips(response.data.generatedClips || {});
    }, [id]);

    useEffect(() => {
        if (id) {
            const loadTranscript = async () => {
                try {
                    await fetchTranscript();
                } catch (err) {
                    setError('Failed to fetch transcript details.');
                    console.error(err);
                } finally {
                    setLoading(false);
                }
            };
            loadTranscript();
        }
    }, [id, fetchTranscript]);

    const isTranscriptProcessing = (value: Transcript | null) => (
        value?.processingJob
            ? ['queued', 'running', 'cancelling'].includes(value.processingJob.status)
            : Boolean(value?.status && ['uploading', 'converting', 'transcribing'].includes(value.status))
    );

    const isClipGenerating = (clip?: Clip) => Boolean(
        clip?.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status)
    );

    const hasActiveJobs = Boolean(isTranscriptProcessing(transcript) || transcript?.clips?.some(isClipGenerating));

    useEffect(() => {
        if (!transcript || !id) return;
        if (transcript.analysisMetadata?.filteredClipCount && !hasBannerBeenSeen('filtered')) {
            setTimeout(() => markBannerSeen('filtered'), 3000);
        }
        if (transcript.analysisMetadata?.analyzedAt && transcript.clips?.length && !hasBannerBeenSeen('analyzed')) {
            setTimeout(() => markBannerSeen('analyzed'), 3000);
        }
    }, [transcript, id]);

    useEffect(() => {
        if (!id || !hasActiveJobs) return;
        const interval = setInterval(() => {
            fetchTranscript().catch(err => console.error('Failed to poll transcript:', err));
        }, 3000);
        return () => clearInterval(interval);
    }, [id, hasActiveJobs, fetchTranscript]);

    const generateClips = async () => {
        if (!transcript) return;
        
        setAnalyzing(true);
        setError('');
        
        try {
            const response = await axios.post(`${API_URL}/clips/analyze/${transcript._id}`);
            setTranscript(response.data);
            setGeneratedClips(response.data.generatedClips || {});
        } catch (err) {
            setError('Failed to generate clips. Please try again.');
            console.error(err);
        } finally {
            setAnalyzing(false);
        }
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const formatPhase = (phase?: string, segmentCount?: number) => {
        if (!phase) return 'Processing';
        const segmentMatch = phase.match(/^cut-segment-(\d+)$/);
        if (segmentMatch) {
            return segmentCount ? `Cutting segment ${segmentMatch[1]}/${segmentCount}` : `Cutting segment ${segmentMatch[1]}`;
        }
        const labels: Record<string, string> = {
            'extract-metadata': 'Extracting metadata',
            'download-video': 'Downloading video',
            'probe-duration': 'Reading duration',
            'convert-mp3': 'Converting audio',
            'persist-files': 'Saving files',
            'upload-gemini': 'Uploading audio',
            transcribe: 'Transcribing',
            prepare: 'Preparing',
            'cut-segment': 'Cutting segment',
            'stitch-segments': 'Stitching segments',
            'cleanup-temp': 'Cleaning temporary files',
            'save-video': 'Saving video',
            completed: 'Completed',
        };
        return labels[phase] || phase.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
    };

    const seekToClip = (clip: Clip) => {
        const video = document.querySelector('video') as HTMLVideoElement;
        if (video) {
            const startTime = clip.start || (clip.segments && clip.segments[0]?.start) || 0;
            video.currentTime = startTime;
            video.play();
        }
    };

    const generateVideoClip = async (clipIndex: number) => {
        if (!transcript) return;
        
        setGeneratingClips(prev => ({...prev, [clipIndex]: true}));
        setError('');
        
        try {
            await axios.post(`${API_URL}/clips/clips/generate/${transcript._id}`, {
                clipIndex: clipIndex
            });
            await fetchTranscript();
        } catch (err: any) {
            const errorMessage = err.response?.data?.error || `Failed to generate clip ${clipIndex + 1}. Please try again.`;
            const errorDetails = err.response?.data?.details ? ` (${err.response.data.details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip generation error:', err);
        } finally {
            setGeneratingClips(prev => ({...prev, [clipIndex]: false}));
        }
    };

    const generateRemainingClips = async () => {
        if (!transcript) return;

        const clipIndexes = transcript.clips
            .map((clip, index) => ({ clip, index }))
            .filter(({ clip, index }) => !generatedClips[index] && !isClipGenerating(clip))
            .map(({ index }) => index);

        if (clipIndexes.length === 0) return;

        setError('');
        try {
            await axios.post(`${API_URL}/clips/clips/generate-batch/${transcript._id}`, {
                clipIndexes
            });
            await fetchTranscript();
        } catch (err: any) {
            const errorMessage = err.response?.data?.details || err.response?.data?.error || 'Failed to generate remaining clips.';
            setError(errorMessage);
        }
    };

    const cancelTranscriptProcessing = async () => {
        if (!transcript || cancellingTranscript) return;
        setCancellingTranscript(true);
        setError('');
        setNotice('');
        try {
            const response = await axios.post(`${API_URL}/clips/transcripts/${transcript._id}/cancel-processing`);
            if (response.data?.transcript) {
                setTranscript(response.data.transcript);
            }
            setNotice('Processing was cancelled.');
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to cancel transcript processing.');
        } finally {
            setCancellingTranscript(false);
        }
    };

    const cancelClipGeneration = async (clipIndex: number) => {
        if (!transcript) return;
        setCancellingClips(prev => ({ ...prev, [clipIndex]: true }));
        setError('');
        try {
            const response = await axios.post(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}/cancel-generation`);
            if (response.data?.transcript) {
                setTranscript(response.data.transcript);
            }
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to cancel clip generation.');
        } finally {
            setCancellingClips(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const clearAnalyzedClips = async () => {
        if (!transcript) return;
        
        try {
            // Update transcript to remove clips
            const updatedTranscript = { ...transcript, clips: [] };
            await axios.put(`${API_URL}/clips/transcripts/${transcript._id}`, {
                clips: []
            });
            setTranscript(updatedTranscript);
            setGeneratedClips({});
        } catch (err) {
            setError('Failed to clear clips. Please try again.');
            console.error(err);
        }
    };

    const openReframeModal = (video: ClipVideo, clipIndex: number) => {
        // Pass the generated clip directly - it already contains the final video URL
        setSelectedClipForReframe({
            ...video,
            clipIndex,
            clipDefinition: transcript?.clips?.[clipIndex],
            clipTimeline: video.clipTimeline,
            clipHook: transcript?.clips?.[clipIndex]?.hook
        });
        setIsReframeModalOpen(true);
    };

    const updateClipHookDraft = (clipIndex: number, updates: Partial<ClipHook>) => {
        setTranscript(prev => {
            if (!prev) return prev;
            const clips = prev.clips.map((clip, index) => {
                if (index !== clipIndex) return clip;
                const currentHook = clip.hook || { text: '', enabled: false, updatedAt: null };
                const nextText = updates.text ?? currentHook.text;
                return {
                    ...clip,
                    hook: {
                        ...currentHook,
                        ...updates,
                        text: nextText,
                        enabled: updates.enabled ?? currentHook.enabled
                    }
                };
            });
            return { ...prev, clips };
        });
    };

    const saveClipHook = async (clipIndex: number) => {
        if (!transcript) return;
        const hook = transcript.clips[clipIndex]?.hook || { text: '', enabled: false, updatedAt: null };
        setSavingHooks(prev => ({ ...prev, [clipIndex]: true }));
        setError('');

        try {
            const response = await axios.patch(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}/hook`, {
                text: hook.text,
                enabled: hook.enabled
            });
            setTranscript(prev => prev ? { ...prev, clips: response.data.clips || prev.clips } : prev);
            setGeneratedClips(response.data.generatedClips || {});
        } catch (err: any) {
            const errorMessage = err.response?.data?.error || 'Failed to save clip hook.';
            const errorDetails = err.response?.data?.details ? ` (${err.response.data.details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip hook save error:', err);
        } finally {
            setSavingHooks(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const regenerateClipHook = async (clipIndex: number) => {
        if (!transcript) return;

        setRegeneratingHooks(prev => ({ ...prev, [clipIndex]: true }));
        setError('');

        try {
            const response = await axios.post(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}/hook/regenerate`);
            setTranscript(prev => prev ? { ...prev, clips: response.data.clips || prev.clips } : prev);
            setGeneratedClips(response.data.generatedClips || {});
        } catch (err: any) {
            const errorMessage = err.response?.data?.error || 'Failed to regenerate clip hook.';
            const errorDetails = err.response?.data?.details ? ` (${err.response.data.details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip hook regeneration error:', err);
        } finally {
            setRegeneratingHooks(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const deleteClipVersion = async (clipIndex: number, video: ClipVideo) => {
        if (!transcript) return;
        const confirmed = confirm('Delete this clip version? The video file will also be removed.');
        if (!confirmed) return;

        const deletionKey = `${clipIndex}:${video.id}`;
        setDeletingVersions(prev => ({ ...prev, [deletionKey]: true }));
        setError('');

        try {
            await axios.delete(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}/videos/${encodeURIComponent(video.id)}`);
            await fetchTranscript();
        } catch (err: any) {
            const errorMessage = err.response?.data?.error || 'Failed to delete clip version.';
            const errorDetails = err.response?.data?.details ? ` (${err.response.data.details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip version deletion error:', err);
        } finally {
            setDeletingVersions(prev => ({ ...prev, [deletionKey]: false }));
        }
    };

    const closeReframeModal = () => {
        setIsReframeModalOpen(false);
        setSelectedClipForReframe(null);
    };

    const toggleClipSelect = (index: number) => {
        setSelectedClipIndexes(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const selectAllClips = () => {
        if (!transcript) return;
        setSelectedClipIndexes(new Set(transcript.clips.map((_, i) => i)));
    };

    const clearClipSelection = () => setSelectedClipIndexes(new Set());

    const bulkDownload = async () => {
        if (!transcript || selectedClipIndexes.size === 0) return;
        setBulkDownloading(true);
        setError('');
        try {
            const clips = Array.from(selectedClipIndexes)
                .flatMap(idx => {
                    const v = generatedClips[idx];
                    return v ? [{ transcriptId: transcript._id, clipIndex: idx, videoId: v.id }] : [];
                });
            if (clips.length === 0) {
                setError('No generated videos in selection.');
                return;
            }
            const res = await axios.post(`${API_URL}/clips/clips/download-zip`, { clips }, { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${transcript.originalFilename}_clips.zip`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to download clips.');
        } finally {
            setBulkDownloading(false);
        }
    };

    const openCaptionModal = (indexes: number[]) => {
        setCaptionModalClipIndexes(indexes);
        setIsCaptionModalOpen(true);
    };

    const getViralityBadgeClass = (score?: number) => {
        if (!score) return 'bg-slate-100 text-slate-600';
        if (score >= 80) return 'bg-red-100 text-red-700';
        if (score >= 60) return 'bg-orange-100 text-orange-700';
        return 'bg-slate-100 text-slate-600';
    };

    const getSortedClipIndexes = () => {
        if (!transcript) return [];
        const indexes = transcript.clips.map((_, i) => i);
        if (sortOrder === 'virality') {
            return indexes.sort((a, b) => (transcript.clips[b].viralityScore || 0) - (transcript.clips[a].viralityScore || 0));
        }
        if (sortOrder === 'duration') {
            const dur = (clip: Clip) => clip.totalDuration || (clip.end || 0) - (clip.start || 0);
            return indexes.sort((a, b) => dur(transcript.clips[a]) - dur(transcript.clips[b]));
        }
        return indexes;
    };

    const getPreviousVersions = (clip: Clip, primaryVideo?: ClipVideo) => {
        if (!clip.videos || clip.videos.length === 0 || !primaryVideo) return [];
        return clip.videos
            .filter(video => video.id !== primaryVideo.id)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    };

    const formatVersionDate = (value: string) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
    };

    const retryTranscription = async () => {
        if (!transcript || retryingTranscript) return;

        setRetryingTranscript(true);
        setError('');
        setNotice('');

        try {
            await axios.post(`${API_URL}/clips/retry/${transcript._id}`);
            await fetchTranscript();
        } catch (err: any) {
            const errorMessage = err.response?.data?.details || err.response?.data?.error || 'Failed to retry transcription.';
            setError(errorMessage);
        } finally {
            setRetryingTranscript(false);
        }
    };

    const hasTranscriptContent = Array.isArray(transcript?.transcript) && transcript.transcript.length > 0;
    const canRetryTranscription = transcript?.status === 'failed' && !hasTranscriptContent && Boolean(transcript.mp3Url);
    const canAnalyzeTranscript = hasTranscriptContent;
    const remainingClipCount = transcript?.clips?.filter((clip, index) => !generatedClips[index] && !isClipGenerating(clip)).length || 0;

    if (loading) {
        return <div className="flex justify-center items-center h-screen">Loading...</div>;
    }

    if (error && !transcript) {
        return <div className="flex justify-center items-center h-screen">{error}</div>;
    }

    if (!transcript) {
        return <div className="flex justify-center items-center h-screen">Transcript not found.</div>;
    }

    return (
        <main className="container mx-auto p-8">
            <Button onClick={() => router.back()} className="mb-8">Back to Transcripts</Button>
            <Card>
                <CardHeader>
                    <CardTitle className="text-3xl">{transcript.originalFilename}</CardTitle>
                    <CardDescription>
                        Processed on {new Date(transcript.createdAt).toLocaleString()}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    <div>
                        {notice && (
                            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                                {notice}
                            </div>
                        )}
                        {canRetryTranscription && (
                            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                                    <div className="space-y-3">
                                        <div>
                                            <p className="font-semibold">
                                                {transcript.processingJob?.status === 'cancelled'
                                                    ? 'Transcription was cancelled.'
                                                    : 'Video import/download succeeded, but transcription failed.'}
                                            </p>
                                            <p className="text-sm">{transcript.failureReason || 'Retry transcription to try again.'}</p>
                                        </div>
                                        <Button onClick={retryTranscription} disabled={retryingTranscript}>
                                            {retryingTranscript ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Retrying...</> : 'Retry Transcription'}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {isTranscriptProcessing(transcript) && transcript.processingJob && (
                            <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-950">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                    <div>
                                        <div className="mb-1 flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            <p className="font-semibold">Processing video</p>
                                            <Badge variant="secondary">{formatPhase(transcript.processingJob.phase)}</Badge>
                                        </div>
                                        <p className="text-sm text-blue-800">{transcript.processingJob.progressMessage}</p>
                                    </div>
                                    <Button
                                        onClick={cancelTranscriptProcessing}
                                        disabled={cancellingTranscript || transcript.processingJob.status === 'cancelling'}
                                        variant="outline"
                                        size="sm"
                                    >
                                        <StopCircle className="mr-2 h-4 w-4" />
                                        {cancellingTranscript || transcript.processingJob.status === 'cancelling' ? 'Stopping...' : 'Stop'}
                                    </Button>
                                </div>
                            </div>
                        )}
                        {transcript && transcript.videoUrl && (
                            <video
                                controls
                                src={`${API_URL}${transcript.videoUrl}`}
                                className="rounded-lg shadow-lg"
                                style={{ maxHeight: '280px', maxWidth: '100%' }}
                            />
                        )}
                        <details className="mt-4 rounded-lg border bg-muted/30">
                            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                                More · Transcript generated
                            </summary>
                            <div className="max-h-[360px] overflow-y-auto space-y-4 border-t bg-background px-4 py-4">
                                {hasTranscriptContent ? transcript.transcript.map((segment, index) => (
                                    <div key={index}>
                                        <p className="font-semibold text-primary">{segment.speaker || 'Unknown Speaker'}: {segment.start} - {segment.end}</p>
                                        <p>{segment.text}</p>
                                    </div>
                                )) : (
                                    <p className="text-muted-foreground">No transcript content is available yet.</p>
                                )}
                            </div>
                        </details>
                        <div className="mt-8">
                            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                                <h3 className="text-2xl font-bold">Clip Analysis & Generation</h3>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        onClick={generateClips}
                                        disabled={analyzing || !canAnalyzeTranscript}
                                        variant="outline"
                                    >
                                        {analyzing ? 'Analyzing...' : transcript.clips?.length ? 'Re-analyze Clips' : 'Analyze for Clips'}
                                    </Button>
                                    <Button
                                        onClick={generateRemainingClips}
                                        disabled={!remainingClipCount}
                                        variant="outline"
                                    >
                                        Generate Remaining{remainingClipCount ? ` (${remainingClipCount})` : ''}
                                    </Button>
                                    <Button
                                        onClick={clearAnalyzedClips}
                                        disabled={!canAnalyzeTranscript || !transcript?.clips || transcript.clips.length === 0}
                                        variant="destructive"
                                        size="sm"
                                    >
                                        Clear Clips
                                    </Button>
                                </div>
                            </div>
                            {transcript.clips && transcript.clips.length > 0 && (
                                <div className="flex flex-wrap items-center gap-3 mb-4 pb-4 border-b">
                                    <div className="flex items-center gap-2">
                                        <select
                                            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                                            value={sortOrder}
                                            onChange={e => setSortOrder(e.target.value as 'virality' | 'order' | 'duration')}
                                        >
                                            <option value="virality">Sort: Virality</option>
                                            <option value="order">Sort: Timeline order</option>
                                            <option value="duration">Sort: Duration</option>
                                        </select>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Button size="sm" variant="outline" onClick={selectAllClips}>
                                            <CheckSquare className="mr-1 h-3 w-3" />
                                            Select all
                                        </Button>
                                        {selectedClipIndexes.size > 0 && (
                                            <Button size="sm" variant="ghost" onClick={clearClipSelection}>
                                                <Square className="mr-1 h-3 w-3" />
                                                Clear ({selectedClipIndexes.size})
                                            </Button>
                                        )}
                                    </div>
                                    {selectedClipIndexes.size > 0 && (
                                        <div className="flex items-center gap-2">
                                            <Button size="sm" variant="outline" onClick={bulkDownload} disabled={bulkDownloading}>
                                                {bulkDownloading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}
                                                Download ({selectedClipIndexes.size})
                                            </Button>
                                            <Button size="sm" variant="outline" onClick={() => openCaptionModal(Array.from(selectedClipIndexes))}>
                                                Bulk Edit ({selectedClipIndexes.size})
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                            {error && transcript && (
                                <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded">
                                    {error}
                                </div>
                            )}
                            {transcript.analysisMetadata?.filteredClipCount && !hasBannerBeenSeen('filtered') ? (
                                <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                    {transcript.analysisMetadata.filteredClipCount} clip{transcript.analysisMetadata.filteredClipCount === 1 ? '' : 's'} hidden for language.
                                </div>
                            ) : null}
                            {transcript.analysisMetadata?.analyzedAt && transcript.clips?.length && !hasBannerBeenSeen('analyzed') ? (
                                <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950">
                                    Clips analyzed automatically. All {transcript.clips.length} are queued for generation.
                                </div>
                            ) : null}
                            {!canAnalyzeTranscript ? (
                                <p className="mt-4 text-muted-foreground">Clip analysis is unavailable until transcript content exists.</p>
                            ) : transcript.clips && transcript.clips.length > 0 ? (
                                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                                    {getSortedClipIndexes().map((index) => {
                                        const clip = transcript.clips[index];
                                        const primaryVideo = generatedClips[index] as ClipVideo | undefined;
                                        const previousVersions = getPreviousVersions(clip, primaryVideo);
                                        const clipGenerating = isClipGenerating(clip);
                                        const isSelected = selectedClipIndexes.has(index);
                                        const duration = clip.totalDuration || (clip.end || 0) - (clip.start || 0);

                                        return (
                                        <div key={index} onClick={() => toggleClipSelect(index)} className={`flex flex-col rounded-xl border-2 bg-muted overflow-hidden transition-colors select-none ${isSelected ? 'border-primary' : 'border-transparent'}`}>

                                            {/* Video / placeholder */}
                                            <div className="relative bg-black" onClick={e => e.stopPropagation()}>
                                                {primaryVideo ? (
                                                    <video
                                                        controls
                                                        src={`${API_URL}${primaryVideo.url}`}
                                                        className="w-full"
                                                        style={{ maxHeight: '220px' }}
                                                    />
                                                ) : (
                                                    <div className="flex items-center justify-center bg-slate-900 text-slate-500" style={{ height: '140px' }}>
                                                        {clipGenerating ? (
                                                            <div className="flex flex-col items-center gap-2 text-xs text-slate-400">
                                                                <Loader2 className="h-6 w-6 animate-spin" />
                                                                <span>{formatPhase(clip.generation?.phase)}</span>
                                                            </div>
                                                        ) : (
                                                            <span className="text-xs">No video yet</span>
                                                        )}
                                                    </div>
                                                )}
                                                {/* Select checkbox overlay */}
                                                <button
                                                    onClick={e => { e.stopPropagation(); toggleClipSelect(index); }}
                                                    className={`absolute top-2 left-2 rounded p-0.5 transition-colors ${isSelected ? 'bg-primary text-primary-foreground' : 'bg-black/60 text-white hover:bg-black/80'}`}
                                                >
                                                    {isSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                                                </button>
                                                {/* Virality badge overlay */}
                                                {clip.viralityScore !== undefined && (
                                                    <span className={`absolute top-2 right-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold ${getViralityBadgeClass(clip.viralityScore)}`}>
                                                        {clip.viralityScore >= 80 && <Flame className="h-3 w-3" />}
                                                        {clip.viralityScore}
                                                    </span>
                                                )}
                                            </div>

                                            {/* Card body */}
                                            <div className="flex flex-col flex-1 p-3 gap-2">

                                                {/* Title + meta */}
                                                <div>
                                                    <div className="font-semibold text-sm leading-snug line-clamp-2">{clip.title}</div>
                                                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                                        <span className="text-xs text-muted-foreground">{formatTime(duration)}</span>
                                                        {clip.tags?.map(tag => (
                                                            <span key={tag} className="px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground text-xs">{tag}</span>
                                                        ))}
                                                    </div>
                                                </div>

                                                {/* Generation status (if relevant) */}
                                                {clip.generation && clip.generation.status !== 'idle' && !primaryVideo && (
                                                    <div className={`rounded border px-2 py-1.5 text-xs ${clip.generation.status === 'failed' ? 'border-red-200 bg-red-50 text-red-800' : clip.generation.status === 'cancelled' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
                                                        <Badge variant={clip.generation.status === 'failed' ? 'destructive' : 'secondary'} className="mr-1 text-xs">{clip.generation.status}</Badge>
                                                        {clip.generation.progressMessage}
                                                        {clip.generation.error ? <span className="block mt-0.5 text-xs opacity-75">{clip.generation.error}</span> : null}
                                                    </div>
                                                )}

                                                {/* Primary actions */}
                                                <div className="flex flex-wrap gap-1.5 mt-auto pt-1" onClick={e => e.stopPropagation()}>
                                                    {clipGenerating ? (
                                                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                                            onClick={() => cancelClipGeneration(index)}
                                                            disabled={cancellingClips[index] || clip.generation?.status === 'cancelling'}
                                                        >
                                                            <StopCircle className="mr-1 h-3 w-3" />
                                                            {clip.generation?.status === 'cancelling' ? 'Stopping…' : 'Stop'}
                                                        </Button>
                                                    ) : (
                                                        <Button size="sm" className="h-7 px-2 text-xs"
                                                            onClick={() => generateVideoClip(index)}
                                                            disabled={generatingClips[index]}
                                                        >
                                                            {generatingClips[index] ? 'Generating…' : primaryVideo ? 'Regenerate' : 'Generate'}
                                                        </Button>
                                                    )}
                                                    {primaryVideo && (
                                                        <>
                                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                                                onClick={() => openCaptionModal([index])}
                                                            >
                                                                Edit
                                                            </Button>
                                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                                                onClick={() => openReframeModal(primaryVideo, index)}
                                                            >
                                                                <Wand2 className="h-3 w-3" />
                                                            </Button>
                                                            <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                                                                <a href={`${API_URL}${primaryVideo.url}`} download>
                                                                    <Download className="h-3 w-3" />
                                                                </a>
                                                            </Button>
                                                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                                                onClick={() => deleteClipVersion(index, primaryVideo)}
                                                                disabled={deletingVersions[`${index}:${primaryVideo.id}`]}
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                            </Button>
                                                        </>
                                                    )}
                                                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                                                        onClick={() => seekToClip(clip)}
                                                    >
                                                        Preview
                                                    </Button>
                                                </div>

                                                {/* Hook — collapsible */}
                                                <details className="rounded-md border border-slate-200 bg-white text-sm" onClick={e => e.stopPropagation()}>
                                                    <summary className="cursor-pointer px-3 py-2 font-medium text-slate-800 select-none flex items-center justify-between">
                                                        <span className="flex items-center gap-2">
                                                            Hook
                                                            {clip.hook?.enabled && <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />}
                                                        </span>
                                                    </summary>
                                                    <div className="px-3 pb-3 space-y-2">
                                                        <label className="flex items-center gap-2 text-xs text-slate-700">
                                                            <input
                                                                type="checkbox"
                                                                checked={Boolean(clip.hook?.enabled)}
                                                                onChange={e => updateClipHookDraft(index, { enabled: e.target.checked })}
                                                                className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                                                            />
                                                            Enabled
                                                        </label>
                                                        <textarea
                                                            value={clip.hook?.text || ''}
                                                            onChange={e => updateClipHookDraft(index, { text: e.target.value })}
                                                            rows={2}
                                                            maxLength={120}
                                                            placeholder="Short top overlay hook"
                                                            className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                                        />
                                                        <div className="flex gap-1.5">
                                                            <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                                                                onClick={() => regenerateClipHook(index)}
                                                                disabled={regeneratingHooks[index]}
                                                            >
                                                                {regeneratingHooks[index] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
                                                            </Button>
                                                            <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                                                                onClick={() => saveClipHook(index)}
                                                                disabled={savingHooks[index]}
                                                            >
                                                                <Save className="h-3 w-3 mr-1" />
                                                                {savingHooks[index] ? 'Saving…' : 'Save'}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                </details>

                                                {/* Previous versions — collapsible */}
                                                {previousVersions.length > 0 && (
                                                    <details className="rounded-md border border-slate-200 bg-white text-sm" onClick={e => e.stopPropagation()}>
                                                        <summary className="cursor-pointer px-3 py-2 font-medium text-slate-800 select-none">
                                                            Versions ({previousVersions.length})
                                                        </summary>
                                                        <div className="divide-y divide-slate-100">
                                                            {previousVersions.map(version => (
                                                                <div key={version.id} className="p-3 space-y-1.5">
                                                                    <div className="flex items-center justify-between text-xs">
                                                                        <span className="font-medium capitalize text-slate-800">
                                                                            {version.type}{version.platformName ? ` · ${version.platformName}` : ''}
                                                                        </span>
                                                                        <span className="text-slate-500">{formatVersionDate(version.createdAt)}</span>
                                                                    </div>
                                                                    <video controls src={`${API_URL}${version.url}`} className="w-full rounded border bg-black" style={{ maxHeight: '100px' }} />
                                                                    <div className="flex flex-wrap gap-1">
                                                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => openReframeModal(version, index)}>
                                                                            <Wand2 className="mr-1 h-3 w-3" />Reframe
                                                                        </Button>
                                                                        <Button asChild size="sm" variant="outline" className="h-6 px-2 text-xs">
                                                                            <a href={`${API_URL}${version.url}`} download={version.filename}><Download className="mr-1 h-3 w-3" />Download</a>
                                                                        </Button>
                                                                        <Button size="sm" variant="destructive" className="h-6 px-2 text-xs"
                                                                            onClick={() => deleteClipVersion(index, version)}
                                                                            disabled={deletingVersions[`${index}:${version.id}`]}
                                                                        >
                                                                            <Trash2 className="h-3 w-3" />
                                                                        </Button>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </details>
                                                )}
                                            </div>
                                        </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="mt-4 text-muted-foreground">Clip analysis will run automatically when transcription finishes.</p>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Caption Generator */}
            {transcript && transcript.videoUrl && hasTranscriptContent && (
                <div className="grid gap-6">
                    <CaptionGenerator 
                        transcriptId={transcript._id} 
                        videoUrl={`${API_URL}${transcript.videoUrl}`} 
                    />
                    <StreamerGameplayCrop transcriptId={transcript._id} videoUrl={`${API_URL}${transcript.videoUrl}`} />
                </div>
            )}

            {/* Bulk Edit Modal */}
            {transcript && (
                <BulkEditModal
                    isOpen={isCaptionModalOpen}
                    onClose={() => setIsCaptionModalOpen(false)}
                    transcriptId={transcript._id}
                    clipIndexes={captionModalClipIndexes}
                    generatedClips={generatedClips}
                    clips={transcript.clips as any}
                    onComplete={fetchTranscript}
                />
            )}

            {/* Reframe Modal */}
            {transcript && selectedClipForReframe && (
                <ReframeModal
                    isOpen={isReframeModalOpen}
                    onClose={closeReframeModal}
                    transcriptId={transcript._id}
                    videoUrl={selectedClipForReframe.url} 
                    originalFilename={selectedClipForReframe.filename || transcript.originalFilename}
                    generatedClipUrl={selectedClipForReframe.url}
                    sourceVideoId={selectedClipForReframe.id}
                    clipDefinition={selectedClipForReframe.clipDefinition}
                    clipTimeline={selectedClipForReframe.clipTimeline}
                    clipHook={selectedClipForReframe.clipHook}
                    clipIndex={selectedClipForReframe.clipIndex}
                    onGenerationComplete={fetchTranscript}
                />
            )}
        </main>
    );
} 
