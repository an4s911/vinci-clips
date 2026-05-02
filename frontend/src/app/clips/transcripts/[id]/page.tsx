"use client";

import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { useParams, useRouter } from 'next/navigation';
import ReframeModal from '@/components/ReframeModal';
import CaptionGenerator from '@/components/CaptionGenerator';
import { AlertCircle, Download, ExternalLink, Loader2, RefreshCcw, Save, Trash2, Wand2 } from 'lucide-react';
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
    title?: string;
}

interface ClipHook {
    text: string;
    enabled: boolean;
    updatedAt: string | null;
}

interface Clip {
    title: string;
    start?: number; // For single segment clips
    end?: number;   // For single segment clips
    segments?: ClipSegment[]; // For multi-segment clips
    totalDuration?: number;
    hook: ClipHook;
    videos?: ClipVideo[];
    primaryVideoId?: string | null;
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
    failureReason?: string | null;
    failedAt?: string | null;
    analysisMetadata?: {
        filteredClipCount?: number;
        visibleClipCount?: number;
        suggestedClipCount?: number;
        blockedWordSource?: string;
        analyzedAt?: string;
    } | null;
    generatedClips?: {[key: number]: ClipVideo & { index: number; title: string }};
}

export default function TranscriptDetailPage() {
    const [transcript, setTranscript] = useState<Transcript | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [analyzing, setAnalyzing] = useState(false);
    const [generatingClips, setGeneratingClips] = useState<{[key: number]: boolean}>({});
    const [generatedClips, setGeneratedClips] = useState<{[key: number]: any}>({});
    const [deletingVersions, setDeletingVersions] = useState<{[key: string]: boolean}>({});
    const [savingHooks, setSavingHooks] = useState<{[key: number]: boolean}>({});
    const [regeneratingHooks, setRegeneratingHooks] = useState<{[key: number]: boolean}>({});
    const [isReframeModalOpen, setIsReframeModalOpen] = useState(false);
    const [selectedClipForReframe, setSelectedClipForReframe] = useState<any>(null);
    const [retryingTranscript, setRetryingTranscript] = useState(false);
    const params = useParams();
    const router = useRouter();
    const id = params.id;

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
    const isFailedWithoutTranscript = transcript?.status === 'failed' && !hasTranscriptContent;
    const canAnalyzeTranscript = hasTranscriptContent;

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
                <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="md:col-span-2">
                        {isFailedWithoutTranscript && (
                            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                                    <div className="space-y-3">
                                        <div>
                                            <p className="font-semibold">Video import/download succeeded, but transcription failed.</p>
                                            <p className="text-sm">{transcript.failureReason || 'Retry transcription to try again.'}</p>
                                        </div>
                                        <Button onClick={retryTranscription} disabled={retryingTranscript}>
                                            {retryingTranscript ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Retrying...</> : 'Retry Transcription'}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {transcript && transcript.videoUrl && (
                            <video 
                                controls 
                                src={`${API_URL}${transcript.videoUrl}`} 
                                className="w-full rounded-lg shadow-lg"
                            >
                            </video>
                        )}
                        <div className="mt-8">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-2xl font-bold">Clip Analysis & Generation</h3>
                                <div className="flex gap-2">
                                    <Button 
                                        onClick={generateClips} 
                                        disabled={analyzing || !canAnalyzeTranscript}
                                        variant="outline"
                                    >
                                        {analyzing ? 'Analyzing...' : 'Analyze for Clips'}
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
                            {error && transcript && (
                                <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded">
                                    {error}
                                </div>
                            )}
                            {transcript.analysisMetadata?.filteredClipCount ? (
                                <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                    {transcript.analysisMetadata.filteredClipCount} clip{transcript.analysisMetadata.filteredClipCount === 1 ? '' : 's'} hidden for language.
                                </div>
                            ) : null}
                            {!canAnalyzeTranscript ? (
                                <p className="mt-4 text-muted-foreground">Clip analysis is unavailable until transcript content exists.</p>
                            ) : transcript.clips && transcript.clips.length > 0 ? (
                                <div className="mt-4 space-y-4">
                                    {transcript.clips.map((clip, index) => {
                                        const primaryVideo = generatedClips[index] as ClipVideo | undefined;
                                        const previousVersions = getPreviousVersions(clip, primaryVideo);

                                        return (
                                        <div key={index} className="p-4 bg-muted rounded-lg transition-colors">
                                            <div className="flex items-start justify-between mb-2">
                                                <div className="font-semibold flex-1">{clip.title}</div>
                                                <Button 
                                                    onClick={() => generateVideoClip(index)}
                                                    disabled={generatingClips[index]}
                                                    size="sm"
                                                    className="ml-2"
                                                >
                                                    {generatingClips[index] ? 'Generating...' : 'Generate Clip'}
                                                </Button>
                                            </div>
                                            <div className="text-sm text-muted-foreground">
                                                {clip.segments && clip.segments.length > 0 ? (
                                                    // Multi-segment clip
                                                    <div>
                                                        <div className="font-medium text-xs text-primary mb-1">MIXED SEGMENTS:</div>
                                                        {clip.segments.map((segment, segIndex) => (
                                                            <div key={segIndex} className="ml-2">
                                                                • {formatTime(segment.start)} - {formatTime(segment.end)}
                                                            </div>
                                                        ))}
                                                        <div className="mt-1 text-xs font-medium">
                                                            Total Duration: {clip.totalDuration ? formatTime(clip.totalDuration) : 'Unknown'}
                                                        </div>
                                                    </div>
                                                ) : (
                                                    // Single segment clip
                                                    <div>
                                                        <div>{formatTime(clip.start || 0)} - {formatTime(clip.end || 0)}</div>
                                                        <div className="text-xs">
                                                            Duration: {clip.totalDuration ? formatTime(clip.totalDuration) : formatTime((clip.end || 0) - (clip.start || 0))}
                                                        </div>
                                                    </div>
                                                )}
                                                <Button 
                                                    onClick={() => seekToClip(clip)}
                                                    variant="ghost"
                                                    size="sm"
                                                    className="mt-2 h-6 px-2 text-xs"
                                                >
                                                    Preview in Player
                                                </Button>
                                            </div>

                                            <div className="mt-3 rounded-md border border-slate-200 bg-white p-3">
                                                <div className="mb-2 flex items-center justify-between gap-3">
                                                    <label className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(clip.hook?.enabled)}
                                                            onChange={(event) => updateClipHookDraft(index, { enabled: event.target.checked })}
                                                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                        />
                                                        Hook
                                                    </label>
                                                    <div className="flex flex-wrap justify-end gap-2">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() => regenerateClipHook(index)}
                                                            disabled={regeneratingHooks[index]}
                                                            className="h-7 px-2 text-xs"
                                                        >
                                                            {regeneratingHooks[index] ? (
                                                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                                            ) : (
                                                                <RefreshCcw className="mr-1 h-3 w-3" />
                                                            )}
                                                            {regeneratingHooks[index] ? 'Regenerating...' : 'Regenerate Hook'}
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() => saveClipHook(index)}
                                                            disabled={savingHooks[index]}
                                                            className="h-7 px-2 text-xs"
                                                        >
                                                            <Save className="mr-1 h-3 w-3" />
                                                            {savingHooks[index] ? 'Saving...' : 'Save'}
                                                        </Button>
                                                    </div>
                                                </div>
                                                <textarea
                                                    value={clip.hook?.text || ''}
                                                    onChange={(event) => updateClipHookDraft(index, { text: event.target.value })}
                                                    rows={2}
                                                    maxLength={120}
                                                    placeholder="Short top overlay hook"
                                                    className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-slate-900 shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                                />
                                                {clip.hook?.enabled && !clip.hook.text.trim() && (
                                                    <p className="mt-1 text-xs text-amber-700">Hook is enabled but will be skipped until text is added.</p>
                                                )}
                                            </div>

                                            {/* Generated clip video player */}
                                            {generatedClips[index] && (
                                                <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div>
                                                            <h4 className="text-sm font-semibold text-green-800">Primary Video</h4>
                                                            <p className="text-xs text-green-700">
                                                                {primaryVideo?.type === 'reframed' ? 'Reframed' : 'Generated'}
                                                                {primaryVideo?.platformName ? ` for ${primaryVideo.platformName}` : ''}
                                                                {primaryVideo?.createdAt ? ` · ${formatVersionDate(primaryVideo.createdAt)}` : ''}
                                                            </p>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <Button 
                                                                size="sm" 
                                                                variant="outline"
                                                                onClick={() => primaryVideo && openReframeModal(primaryVideo, index)}
                                                                className="flex items-center gap-1"
                                                            >
                                                                <Wand2 className="w-3 h-3" />
                                                                Reframe
                                                            </Button>
                                                            <Button asChild size="sm" variant="outline">
                                                                <a href={`${API_URL}${generatedClips[index].url}`} download target="_blank" rel="noopener noreferrer">
                                                                    <Download className="w-3 h-3 mr-1" />
                                                                    Download
                                                                </a>
                                                            </Button>
                                                            {primaryVideo && (
                                                                <Button
                                                                    size="sm"
                                                                    variant="destructive"
                                                                    onClick={() => deleteClipVersion(index, primaryVideo)}
                                                                    disabled={deletingVersions[`${index}:${primaryVideo.id}`]}
                                                                    className="flex items-center gap-1"
                                                                >
                                                                    <Trash2 className="w-3 h-3" />
                                                                    Delete
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <video 
                                                        controls 
                                                        src={`${API_URL}${generatedClips[index].url}`} 
                                                        className="w-full rounded"
                                                        style={{maxHeight: '300px'}}
                                                    />
                                                    {previousVersions.length > 0 && (
                                                        <details className="mt-3 rounded-md border border-green-200 bg-white">
                                                            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-green-900">
                                                                Previous versions ({previousVersions.length})
                                                            </summary>
                                                            <div className="divide-y divide-green-100">
                                                                {previousVersions.map((version) => (
                                                                    <div key={version.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_180px]">
                                                                        <div className="space-y-1 text-sm">
                                                                            <div className="font-medium capitalize text-slate-900">
                                                                                {version.type}
                                                                                {version.platformName ? ` · ${version.platformName}` : ''}
                                                                            </div>
                                                                            <div className="text-xs text-slate-600">{formatVersionDate(version.createdAt)}</div>
                                                                            {version.aspectRatio && (
                                                                                <div className="text-xs text-slate-600">Aspect ratio: {version.aspectRatio}</div>
                                                                            )}
                                                                            <div className="flex flex-wrap gap-2 pt-1">
                                                                                <Button
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    className="h-7 px-2 text-xs"
                                                                                    onClick={() => openReframeModal(version, index)}
                                                                                >
                                                                                    <Wand2 className="mr-1 h-3 w-3" />
                                                                                    Reframe
                                                                                </Button>
                                                                                <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                                                                                    <a href={`${API_URL}${version.url}`} target="_blank" rel="noopener noreferrer">
                                                                                        <ExternalLink className="mr-1 h-3 w-3" />
                                                                                        Preview
                                                                                    </a>
                                                                                </Button>
                                                                                <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                                                                                    <a href={`${API_URL}${version.url}`} download={version.filename}>
                                                                                        <Download className="mr-1 h-3 w-3" />
                                                                                        Download
                                                                                    </a>
                                                                                </Button>
                                                                                <Button
                                                                                    size="sm"
                                                                                    variant="destructive"
                                                                                    className="h-7 px-2 text-xs"
                                                                                    onClick={() => deleteClipVersion(index, version)}
                                                                                    disabled={deletingVersions[`${index}:${version.id}`]}
                                                                                >
                                                                                    <Trash2 className="mr-1 h-3 w-3" />
                                                                                    Delete
                                                                                </Button>
                                                                            </div>
                                                                        </div>
                                                                        <video
                                                                            controls
                                                                            src={`${API_URL}${version.url}`}
                                                                            className="w-full rounded border bg-black"
                                                                            style={{maxHeight: '120px'}}
                                                                        />
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </details>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="mt-4 text-muted-foreground">No clips analyzed yet. Click "Analyze for Clips" to get clip suggestions.</p>
                            )}
                        </div>
                    </div>
                    <div>
                        <h3 className="text-2xl font-bold mb-4">Transcript</h3>
                        <div className="h-[600px] overflow-y-auto space-y-4 pr-4">
                            {hasTranscriptContent ? transcript.transcript.map((segment, index) => (
                                <div key={index}>
                                    <p className="font-semibold text-primary">{segment.speaker || 'Unknown Speaker'}: {segment.start} - {segment.end}</p>
                                    <p>{segment.text}</p>
                                </div>
                            )) : (
                                <p className="text-muted-foreground">No transcript content is available yet.</p>
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
                    clipHook={selectedClipForReframe.clipHook}
                    clipIndex={selectedClipForReframe.clipIndex}
                    onGenerationComplete={fetchTranscript}
                />
            )}
        </main>
    );
} 
