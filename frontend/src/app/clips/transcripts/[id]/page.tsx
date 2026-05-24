"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useParams, useRouter } from 'next/navigation';
import SmartCropModal from '@/components/SmartCropModal';
import BulkEditModal from '@/components/BulkEditModal';
import DriveExportModal from '@/components/DriveExportModal';
import { AlertCircle, CheckSquare, Download, Eye, ExternalLink, Flame, HardDrive, Loader2, Pencil, RefreshCcw, Save, Square, StopCircle, Trash2, Wand2, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
const API_URL = process.env.NEXT_PUBLIC_API_URL;

function getApiErrorData(error: unknown) {
    return axios.isAxiosError<{ error?: string; details?: string }>(error)
        ? error.response?.data
        : undefined;
}

function getApiErrorMessage(error: unknown, fallback: string, preferDetails = false) {
    const data = getApiErrorData(error);
    return preferDetails
        ? data?.details || data?.error || fallback
        : data?.error || data?.details || fallback;
}

function getApiErrorDetails(error: unknown) {
    return getApiErrorData(error)?.details;
}

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
    thumbnailUrl?: string | null;
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

type SmartCropClipSelection = ClipVideo & {
    clipIndex: number;
    clipDefinition?: Clip;
};

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
    timeoutSeconds?: number | null;
    updatedAt: string | null;
}

interface ClipActiveJob {
    status: 'queued' | 'running' | 'completed' | 'failed';
    jobType?: string;
    progressMessage?: string;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
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
    activeJob?: ClipActiveJob | null;
}

interface Transcript {
    _id: string;
    title?: string | null;
    originalFilename: string;
    importUrl?: string | null;
    transcript: TranscriptSegment[];
    videoUrl?: string;
    thumbnailUrl?: string | null;
    mp3Url?: string;
    clips: Clip[];
    createdAt: string;
    status?: string;
    platform?: string | null;
    failureReason?: string | null;
    failedAt?: string | null;
    failedStage?: string | null;
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
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const [clearingClips, setClearingClips] = useState(false);
    const [generatingClips, setGeneratingClips] = useState<{[key: number]: boolean}>({});
    const [generatedClips, setGeneratedClips] = useState<NonNullable<Transcript['generatedClips']>>({});
    const [deletingVersions, setDeletingVersions] = useState<{[key: string]: boolean}>({});
    const [savingHooks, setSavingHooks] = useState<{[key: number]: boolean}>({});
    const [regeneratingHooks, setRegeneratingHooks] = useState<{[key: number]: boolean}>({});
    const [isSmartCropModalOpen, setIsSmartCropModalOpen] = useState(false);
    const [selectedClipForSmartCrop, setSelectedClipForSmartCrop] = useState<SmartCropClipSelection | null>(null);
    const [retryingTranscript, setRetryingTranscript] = useState(false);
    const [cancellingTranscript, setCancellingTranscript] = useState(false);
    const [cancellingClips, setCancellingClips] = useState<{[key: number]: boolean}>({});
    const [selectedClipIndexes, setSelectedClipIndexes] = useState<Set<number>>(new Set());
    const [bulkDownloading, setBulkDownloading] = useState(false);
    const [driveExportOpen, setDriveExportOpen] = useState(false);
    const [isCaptionModalOpen, setIsCaptionModalOpen] = useState(false);
    const [captionModalClipIndexes, setCaptionModalClipIndexes] = useState<number[]>([]);
    const [captionModalSourceOverrides, setCaptionModalSourceOverrides] = useState<{ [clipIndex: number]: ClipVideo }>({});
    const [sortOrder, setSortOrder] = useState<'virality' | 'order' | 'duration'>('virality');
    const [previewVideo, setPreviewVideo] = useState<{ clipIndex: number; video: ClipVideo } | null>(null);
    const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<{ clipIndex: number; video: ClipVideo } | null>(null);
    const [openVersionIndexes, setOpenVersionIndexes] = useState<Set<number>>(new Set());
    const [confirmDeleteClip, setConfirmDeleteClip] = useState<number | null>(null);
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
    const [deletingClip, setDeletingClip] = useState<{ [index: number]: boolean }>({});
    const [bulkDeleting, setBulkDeleting] = useState(false);
    const [confirmDeleteTranscript, setConfirmDeleteTranscript] = useState(false);
    const [deletingTranscript, setDeletingTranscript] = useState(false);
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
            : Boolean(value?.status && ['uploading', 'downloading', 'converting', 'transcribing', 'analyzing', 'generating'].includes(value.status))
    );

    const isClipGenerating = (clip?: Clip) => Boolean(
        clip?.generation && ['queued', 'running', 'cancelling'].includes(clip.generation.status)
    );

    // True during the silent gap between transcribe-complete and analyze writing clips
    const isAwaitingAnalysis =
        transcript?.processingJob?.status === 'completed'
        && (transcript?.transcript?.length ?? 0) > 0
        && !transcript?.analysisMetadata?.analyzedAt
        && !(transcript?.clips?.length);

    // True while clips exist but at least one is still missing a primary video (worker pending/running)
    const hasUnrenderedAutoClips =
        Array.isArray(transcript?.clips)
        && transcript!.clips.length > 0
        && transcript!.clips.some(c => !c.primaryVideoId && !c.generation?.status);

    const hasActiveRenderJobs = Boolean(
        transcript?.clips?.some(c => c.activeJob?.status === 'queued' || c.activeJob?.status === 'running')
    );

    const hasActiveJobs = Boolean(
        isTranscriptProcessing(transcript)
        || transcript?.clips?.some(isClipGenerating)
        || isAwaitingAnalysis
        || hasUnrenderedAutoClips
        || hasActiveRenderJobs
    );

    useEffect(() => {
        if (!transcript || !id) return;
        if (transcript.analysisMetadata?.filteredClipCount && !hasBannerBeenSeen('filtered')) {
            setTimeout(() => markBannerSeen('filtered'), 3000);
        }
        if (transcript.analysisMetadata?.analyzedAt && transcript.clips?.length && !hasBannerBeenSeen('analyzed')) {
            setTimeout(() => markBannerSeen('analyzed'), 3000);
        }
    }, [transcript, id]);

    const analysisGapStart = useRef<number | null>(null);
    useEffect(() => {
        if (isAwaitingAnalysis) {
            if (analysisGapStart.current === null) analysisGapStart.current = Date.now();
        } else {
            analysisGapStart.current = null;
        }
    }, [isAwaitingAnalysis]);

    const analysisGapTimedOut = isAwaitingAnalysis && analysisGapStart.current !== null && Date.now() - analysisGapStart.current > 5 * 60 * 1000;

    useEffect(() => {
        if (!id || !hasActiveJobs || analysisGapTimedOut) return;
        const interval = setInterval(() => {
            fetchTranscript().catch(err => console.error('Failed to poll transcript:', err));
        }, 3000);
        return () => clearInterval(interval);
    }, [id, hasActiveJobs, analysisGapTimedOut, fetchTranscript]);

    const generateClips = async () => {
        if (!transcript) return;
        
        setAnalyzing(true);
        setError('');
        
        try {
            const response = await axios.post(`${API_URL}/clips/analyze/${transcript._id}`);
            const updatedTranscript = response.data?.transcript || (response.data?._id ? response.data : null);
            if (updatedTranscript) {
                setTranscript(updatedTranscript);
                setGeneratedClips(updatedTranscript.generatedClips || {});
            } else {
                setNotice(response.data?.message || 'Re-analysis queued.');
                await fetchTranscript();
            }
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
            'thumbnail': 'Generating thumbnail',
            'convert-mp3': 'Converting audio',
            'persist-files': 'Saving files',
            'upload-gemini': 'Uploading audio',
            transcribe: 'Transcribing',
            analyze: 'Analyzing for clips',
            clips: 'Generating clips',
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
        } catch (err: unknown) {
            const errorMessage = getApiErrorMessage(err, `Failed to generate clip ${clipIndex + 1}. Please try again.`);
            const details = getApiErrorDetails(err);
            const errorDetails = details ? ` (${details})` : '';
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
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to generate remaining clips.', true));
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
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to cancel transcript processing.'));
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
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to cancel clip generation.'));
        } finally {
            setCancellingClips(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const markBulkRenderQueued = (
        clipIndexes: number[],
        job: { jobType: string; progressMessage: string }
    ) => {
        if (clipIndexes.length === 0) return;
        const selected = new Set(clipIndexes);
        const startedAt = new Date().toISOString();

        setTranscript(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                clips: prev.clips.map((clip, index) => {
                    if (!selected.has(index)) return clip;
                    return {
                        ...clip,
                        activeJob: {
                            ...(clip.activeJob || {}),
                            status: 'queued',
                            jobType: job.jobType,
                            progressMessage: job.progressMessage,
                            startedAt,
                            completedAt: null,
                            error: null,
                        },
                    };
                }),
            };
        });
    };

    const clearAnalyzedClips = async () => {
        if (!transcript || clearingClips) return;
        
        setClearingClips(true);
        setError('');
        try {
            const response = await axios.delete(`${API_URL}/clips/transcripts/${transcript._id}/clips`);
            if (response.data?.transcript) {
                setTranscript(response.data.transcript);
            } else {
                await fetchTranscript();
            }
            setGeneratedClips({});
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to clear clips. Please try again.', true));
            console.error(err);
        } finally {
            setClearingClips(false);
        }
    };

    const openSmartCropModal = (video: ClipVideo, clipIndex: number) => {
        // Pass the generated clip directly - it already contains the final video URL
        setSelectedClipForSmartCrop({
            ...video,
            clipIndex,
            clipDefinition: transcript?.clips?.[clipIndex],
            clipTimeline: video.clipTimeline
        });
        setIsSmartCropModalOpen(true);
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
                enabled: hook.enabled,
                timeoutSeconds: hook.timeoutSeconds ?? null
            });
            setTranscript(prev => prev ? { ...prev, clips: response.data.clips || prev.clips } : prev);
            setGeneratedClips(response.data.generatedClips || {});
        } catch (err: unknown) {
            const errorMessage = getApiErrorMessage(err, 'Failed to save clip hook.');
            const details = getApiErrorDetails(err);
            const errorDetails = details ? ` (${details})` : '';
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
        } catch (err: unknown) {
            const errorMessage = getApiErrorMessage(err, 'Failed to regenerate clip hook.');
            const details = getApiErrorDetails(err);
            const errorDetails = details ? ` (${details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip hook regeneration error:', err);
        } finally {
            setRegeneratingHooks(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const deleteClipVersion = (clipIndex: number, video: ClipVideo) => {
        setConfirmDeleteVersion({ clipIndex, video });
    };

    const handleConfirmDeleteVersion = async () => {
        if (!transcript || !confirmDeleteVersion) return;
        const { clipIndex, video } = confirmDeleteVersion;
        
        const deletionKey = `${clipIndex}:${video.id}`;
        setDeletingVersions(prev => ({ ...prev, [deletionKey]: true }));
        setError('');

        try {
            await axios.delete(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}/videos/${encodeURIComponent(video.id)}`);
            await fetchTranscript();
            setConfirmDeleteVersion(null);
        } catch (err: unknown) {
            const errorMessage = getApiErrorMessage(err, 'Failed to delete clip version.');
            const details = getApiErrorDetails(err);
            const errorDetails = details ? ` (${details})` : '';
            setError(errorMessage + errorDetails);
            console.error('Clip version deletion error:', err);
        } finally {
            setDeletingVersions(prev => ({ ...prev, [deletionKey]: false }));
        }
    };

    const closeSmartCropModal = () => {
        setIsSmartCropModalOpen(false);
        setSelectedClipForSmartCrop(null);
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
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to download clips.'));
        } finally {
            setBulkDownloading(false);
        }
    };

    const deleteClipItem = (index: number) => {
        setConfirmDeleteClip(index);
    };

    const handleConfirmDeleteClipItem = async () => {
        if (!transcript || confirmDeleteClip === null) return;
        const clipIndex = confirmDeleteClip;
        setDeletingClip(prev => ({ ...prev, [clipIndex]: true }));
        setError('');
        try {
            await axios.delete(`${API_URL}/clips/clips/${transcript._id}/${clipIndex}`);
            await fetchTranscript();
            setSelectedClipIndexes(prev => {
                const next = new Set(prev);
                next.delete(clipIndex);
                return next;
            });
            setConfirmDeleteClip(null);
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to delete clip.'));
        } finally {
            setDeletingClip(prev => ({ ...prev, [clipIndex]: false }));
        }
    };

    const bulkDeleteSelected = () => {
        setConfirmBulkDelete(true);
    };

    const handleConfirmBulkDelete = async () => {
        if (!transcript) return;
        setBulkDeleting(true);
        setError('');
        try {
            await axios.post(`${API_URL}/clips/clips/${transcript._id}/bulk-delete`, {
                clipIndexes: Array.from(selectedClipIndexes),
            });
            await fetchTranscript();
            clearClipSelection();
            setConfirmBulkDelete(false);
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to delete selected clips.'));
        } finally {
            setBulkDeleting(false);
        }
    };

    const handleDeleteTranscript = async () => {
        if (!transcript) return;
        setDeletingTranscript(true);
        setError('');
        try {
            await axios.delete(`${API_URL}/clips/transcripts/${transcript._id}`);
            router.push('/');
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to delete transcript.'));
            setDeletingTranscript(false);
        }
    };

    const openCaptionModal = (indexes: number[], sourceOverrides?: { [clipIndex: number]: ClipVideo }) => {
        setCaptionModalClipIndexes(indexes);
        setCaptionModalSourceOverrides(sourceOverrides || {});
        setIsCaptionModalOpen(true);
    };

    const openPreviewModal = (clipIndex: number, video: ClipVideo) => {
        setPreviewVideo({ clipIndex, video });
    };

    const closePreviewModal = () => setPreviewVideo(null);

    const deleteClipVersionFromPreview = async (clipIndex: number, video: ClipVideo) => {
        await deleteClipVersion(clipIndex, video);
        closePreviewModal();
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

    const getVideoLabel = (video: ClipVideo, isPrimary: boolean) => {
        const parts = [isPrimary ? 'Primary' : 'Version', video.type, video.platformName].filter(Boolean);
        return parts.join(' · ');
    };

    const retryContinue = async () => {
        if (!transcript || retryingTranscript) return;

        setRetryingTranscript(true);
        setError('');
        setNotice('');

        try {
            await axios.post(`${API_URL}/clips/retry/${transcript._id}`);
            await fetchTranscript();
        } catch (err: unknown) {
            setError(getApiErrorMessage(err, 'Failed to retry processing.', true));
        } finally {
            setRetryingTranscript(false);
        }
    };

    const startEditTitle = () => {
        if (!transcript) return;
        setTitleDraft(transcript.title || transcript.originalFilename);
        setEditingTitle(true);
    };

    const cancelEditTitle = () => {
        setEditingTitle(false);
        setTitleDraft('');
    };

    const saveTitle = async () => {
        if (!transcript || !titleDraft.trim() || savingTitle) return;
        setSavingTitle(true);
        try {
            await axios.put(`${API_URL}/clips/transcripts/${transcript._id}`, { title: titleDraft.trim() });
            await fetchTranscript();
            setEditingTitle(false);
        } catch {
            // silently ignore — title stays unchanged
        } finally {
            setSavingTitle(false);
        }
    };

    const hasTranscriptContent = Array.isArray(transcript?.transcript) && transcript.transcript.length > 0;
    const canRetryContinue = transcript?.status === 'failed' || transcript?.status === 'cancelled';
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

    const previewClip = previewVideo ? transcript.clips[previewVideo.clipIndex] : null;
    const previewIsPrimary = Boolean(
        previewVideo && generatedClips[previewVideo.clipIndex]?.id === previewVideo.video.id
    );

    return (
        <main className="container mx-auto p-8">
            <div className="flex items-center justify-between mb-8">
                <Button asChild><a href="/">Back to Transcripts</a></Button>
                <Button variant="destructive" size="sm" onClick={() => setConfirmDeleteTranscript(true)}>
                    <Trash2 className="mr-1 h-4 w-4" />
                    Delete transcript
                </Button>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle className="text-3xl">
                        {editingTitle ? (
                            <div className="flex items-center gap-2">
                                <Input
                                    className="text-3xl font-bold h-auto py-0 border-0 border-b rounded-none focus-visible:ring-0 focus-visible:border-b-2 px-0"
                                    value={titleDraft}
                                    onChange={e => setTitleDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') cancelEditTitle(); }}
                                    autoFocus
                                />
                                <button onClick={saveTitle} disabled={savingTitle} className="text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="Save title">
                                    {savingTitle ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                                </button>
                                <button onClick={cancelEditTitle} className="text-muted-foreground hover:text-foreground" aria-label="Cancel">
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 group">
                                <span>{transcript.title || transcript.originalFilename}</span>
                                <button
                                    onClick={startEditTitle}
                                    className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground"
                                    aria-label="Edit title"
                                >
                                    <Pencil className="h-4 w-4" />
                                </button>
                            </div>
                        )}
                    </CardTitle>
                    <CardDescription>
                        Processed on {new Date(transcript.createdAt).toLocaleString()}
                        {transcript.importUrl && (
                            <span className="ml-3">
                                Source:{' '}
                                <a
                                    href={transcript.importUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline underline-offset-2 hover:text-foreground max-w-xs inline-block truncate align-bottom"
                                >
                                    {transcript.importUrl}
                                </a>
                            </span>
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-8">
                    <div>
                        {notice && (
                            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                                {notice}
                            </div>
                        )}
                        {canRetryContinue && (
                            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                                    <div className="space-y-3">
                                        <div>
                                            <p className="font-semibold">
                                                {transcript.processingJob?.status === 'cancelled'
                                                    ? 'Processing was cancelled.'
                                                    : transcript.failedStage
                                                        ? `Failed at: ${formatPhase(transcript.failedStage)}`
                                                        : 'Processing failed.'}
                                            </p>
                                            <p className="text-sm mt-1">
                                                {transcript.failureReason || 'An error occurred during processing.'}
                                            </p>
                                        </div>
                                        <Button onClick={retryContinue} disabled={retryingTranscript}>
                                            {retryingTranscript ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Retrying...</> : 'Retry and continue'}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {(isTranscriptProcessing(transcript) && transcript.processingJob) && (
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
                        {isAwaitingAnalysis && (
                            <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-950">
                                <div className="mb-1 flex items-center gap-2">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    <p className="font-semibold">Analyzing transcript</p>
                                    <Badge variant="secondary">Analyzing</Badge>
                                </div>
                                <p className="text-sm text-blue-800">Finding the best moments to clip — this usually takes under a minute.</p>
                            </div>
                        )}
                        {!isAwaitingAnalysis && (transcript?.clips?.some(isClipGenerating) || hasUnrenderedAutoClips) && (
                            (() => {
                                const clips = transcript!.clips;
                                const total = clips.length;
                                const rendered = clips.filter(c => c.primaryVideoId).length;
                                const activeClip = clips.find(isClipGenerating);
                                const phase = activeClip?.generation?.phase;
                                const msg = activeClip?.generation?.progressMessage;
                                const hasAnyActive = clips.some(isClipGenerating);
                                return (
                                    <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-950">
                                        <div className="mb-1 flex items-center gap-2">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            <p className="font-semibold">
                                                {hasAnyActive
                                                    ? `Generating clips (${rendered} of ${total} done)`
                                                    : 'Queuing clip generation…'}
                                            </p>
                                            {phase && <Badge variant="secondary">{formatPhase(phase)}</Badge>}
                                        </div>
                                        {msg && <p className="text-sm text-blue-800">{msg}</p>}
                                    </div>
                                );
                            })()
                        )}
                        {transcript && transcript.videoUrl && (
                            <video
                                controls
                                src={`${API_URL}${transcript.videoUrl}`}
                                className="rounded-lg shadow-lg"
                                style={{ maxHeight: '280px', maxWidth: '100%' }}
                                preload="none"
                                poster={transcript.thumbnailUrl ? `${API_URL}${transcript.thumbnailUrl}` : undefined}
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
                                        disabled={analyzing || transcript?.status === 'analyzing' || !canAnalyzeTranscript || isAwaitingAnalysis || hasUnrenderedAutoClips}
                                        variant="outline"
                                    >
                                        {(analyzing || transcript?.status === 'analyzing') ? 'Analyzing...' : (isAwaitingAnalysis || hasUnrenderedAutoClips) ? 'Auto-generating…' : transcript.clips?.length ? 'Re-analyze Clips' : 'Analyze for Clips'}
                                    </Button>
                                    <Button
                                        onClick={generateRemainingClips}
                                        disabled={!remainingClipCount || isAwaitingAnalysis || hasUnrenderedAutoClips}
                                        variant="outline"
                                    >
                                        Generate Remaining{remainingClipCount ? ` (${remainingClipCount})` : ''}
                                    </Button>
                                    <Button
                                        onClick={clearAnalyzedClips}
                                        disabled={clearingClips || !canAnalyzeTranscript || !transcript?.clips || transcript.clips.length === 0}
                                        variant="destructive"
                                        size="sm"
                                    >
                                        {clearingClips ? 'Clearing...' : 'Clear Clips'}
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
                                            <Button size="sm" variant="outline" onClick={() => setDriveExportOpen(true)}>
                                                <HardDrive className="mr-1 h-3 w-3" />
                                                Export to Drive ({selectedClipIndexes.size})
                                            </Button>
                                            <Button size="sm" variant="destructive" onClick={bulkDeleteSelected} disabled={bulkDeleting}>
                                                {bulkDeleting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Trash2 className="mr-1 h-3 w-3" />}
                                                Delete ({selectedClipIndexes.size})
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
                                        <div key={index} onClick={() => toggleClipSelect(index)} className={`group flex flex-col rounded-xl border-2 bg-muted overflow-hidden transition-colors select-none ${isSelected ? 'border-primary' : 'border-transparent'}`}>

                                            {/* Video / placeholder */}
                                            <div className="relative bg-black" onClick={e => e.stopPropagation()}>
                                                {primaryVideo ? (
                                                    <video
                                                        controls
                                                        src={`${API_URL}${primaryVideo.url}`}
                                                        className="w-full"
                                                        style={{ maxHeight: '220px' }}
                                                        preload="none"
                                                        poster={primaryVideo.thumbnailUrl ? `${API_URL}${primaryVideo.thumbnailUrl}` : undefined}
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
                                                    <div className="flex items-start justify-between gap-1">
                                                        <div className="font-semibold text-sm leading-snug line-clamp-2 min-w-0">{clip.title}</div>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); deleteClipItem(index); }}
                                                            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 transition-all"
                                                            title="Delete entire clip"
                                                            disabled={deletingClip[index]}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    </div>
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

                                                {/* Reframe / caption render active job (persists across reload) */}
                                                {clip.activeJob && clip.activeJob.status !== 'completed' && !(
                                                    // Treat as stale if running/queued for more than 30 minutes (e.g. backend restarted)
                                                    (clip.activeJob.status === 'running' || clip.activeJob.status === 'queued')
                                                    && clip.activeJob.startedAt
                                                    && Date.now() - new Date(clip.activeJob.startedAt).getTime() > 30 * 60 * 1000
                                                ) && (
                                                    <div className={`rounded border px-2 py-1.5 text-xs flex items-center gap-1.5 ${clip.activeJob.status === 'failed' ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>
                                                        {(clip.activeJob.status === 'running' || clip.activeJob.status === 'queued') && (
                                                            <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
                                                        )}
                                                        <Badge variant={clip.activeJob.status === 'failed' ? 'destructive' : 'secondary'} className="mr-0.5 text-xs">
                                                            {clip.activeJob.jobType || clip.activeJob.status}
                                                        </Badge>
                                                        {clip.activeJob.status === 'failed'
                                                            ? (clip.activeJob.error || 'Render failed')
                                                            : (clip.activeJob.progressMessage || clip.activeJob.status)}
                                                    </div>
                                                )}

                                                {/* Primary actions */}
                                                <div className="flex flex-wrap items-center gap-1 mt-auto pt-1" onClick={e => e.stopPropagation()}>
                                                    {clipGenerating ? (
                                                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0"
                                                            onClick={() => cancelClipGeneration(index)}
                                                            disabled={cancellingClips[index] || clip.generation?.status === 'cancelling'}
                                                        >
                                                            <StopCircle className="mr-1 h-3 w-3" />
                                                            {clip.generation?.status === 'cancelling' ? 'Stopping…' : 'Stop'}
                                                        </Button>
                                                    ) : !primaryVideo ? (
                                                        <Button size="sm" className="h-7 px-2 text-xs shrink-0"
                                                            onClick={() => generateVideoClip(index)}
                                                            disabled={generatingClips[index]}
                                                        >
                                                            {generatingClips[index] ? 'Generating…' : 'Generate'}
                                                        </Button>
                                                    ) : null}
                                                    {primaryVideo && (
                                                        <>
                                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0"
                                                                onClick={() => openPreviewModal(index, primaryVideo)}
                                                            >
                                                                <Eye className="mr-1 h-3 w-3" />
                                                                Preview
                                                            </Button>
                                                            {!clipGenerating && (
                                                                <Button size="sm" className="h-7 px-2 text-xs shrink-0"
                                                                    onClick={() => generateVideoClip(index)}
                                                                    disabled={generatingClips[index]}
                                                                >
                                                                    {generatingClips[index] ? 'Generating…' : 'Regenerate'}
                                                                </Button>
                                                            )}
                                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0"
                                                                onClick={() => openCaptionModal([index])}
                                                            >
                                                                Edit
                                                            </Button>
                                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0"
                                                                onClick={() => openSmartCropModal(primaryVideo, index)}
                                                                aria-label="Smart Crop"
                                                                title="Smart Crop"
                                                            >
                                                                <Wand2 className="h-3 w-3" />
                                                            </Button>
                                                            <span className="inline-flex shrink-0 items-center gap-1">
                                                                <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                                                                    <a href={`${API_URL}${primaryVideo.url}`} download>
                                                                        <Download className="h-3 w-3" />
                                                                    </a>
                                                                </Button>
                                                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive transition-colors hover:bg-destructive hover:text-white focus-visible:ring-destructive"
                                                                    onClick={() => deleteClipVersion(index, primaryVideo)}
                                                                    disabled={deletingVersions[`${index}:${primaryVideo.id}`]}
                                                                >
                                                                    <Trash2 className="h-3 w-3" />
                                                                </Button>
                                                            </span>
                                                        </>
                                                    )}
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
                                                        <div className="space-y-1">
                                                            <p className="text-xs font-medium text-slate-600">Display duration</p>
                                                            <div className="flex flex-wrap gap-1">
                                                                {([null, 5, 10, 15] as (number | null)[]).map(val => (
                                                                    <button
                                                                        key={val ?? 'full'}
                                                                        type="button"
                                                                        onClick={() => updateClipHookDraft(index, { timeoutSeconds: val })}
                                                                        className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${
                                                                            clip.hook?.timeoutSeconds === val
                                                                                ? 'border-primary bg-primary text-primary-foreground'
                                                                                : 'border-slate-200 hover:border-slate-400 bg-white text-slate-700'
                                                                        }`}
                                                                    >
                                                                        {val === null ? 'Full clip' : `${val}s`}
                                                                    </button>
                                                                ))}
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        if (clip.hook?.timeoutSeconds == null || [5,10,15].includes(clip.hook.timeoutSeconds)) {
                                                                            updateClipHookDraft(index, { timeoutSeconds: 8 });
                                                                        }
                                                                    }}
                                                                    className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${
                                                                        clip.hook?.timeoutSeconds != null && ![5,10,15].includes(clip.hook.timeoutSeconds)
                                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                                            : 'border-slate-200 hover:border-slate-400 bg-white text-slate-700'
                                                                    }`}
                                                                >
                                                                    Custom
                                                                </button>
                                                                {clip.hook?.timeoutSeconds != null && ![5,10,15].includes(clip.hook.timeoutSeconds) && (
                                                                    <div className="flex items-center gap-1">
                                                                        <input
                                                                            type="number"
                                                                            min={0.5}
                                                                            step={0.5}
                                                                            value={clip.hook.timeoutSeconds}
                                                                            onChange={e => {
                                                                                const v = parseFloat(e.target.value);
                                                                                if (Number.isFinite(v) && v > 0) updateClipHookDraft(index, { timeoutSeconds: v });
                                                                            }}
                                                                            className="w-14 rounded border border-input bg-background px-2 py-0.5 text-xs"
                                                                        />
                                                                        <span className="text-xs text-slate-500">sec</span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
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
                                                    <details className="rounded-md border border-slate-200 bg-white text-sm" onClick={e => e.stopPropagation()} onToggle={e => {
                                                        const open = (e.currentTarget as HTMLDetailsElement).open;
                                                        setOpenVersionIndexes(prev => {
                                                            const next = new Set(prev);
                                                            open ? next.add(index) : next.delete(index);
                                                            return next;
                                                        });
                                                    }}>
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
                                                                    {openVersionIndexes.has(index) && (
                                                                        <video controls src={`${API_URL}${version.url}`} className="w-full rounded border bg-black" style={{ maxHeight: '100px' }} preload="none" poster={version.thumbnailUrl ? `${API_URL}${version.thumbnailUrl}` : undefined} />
                                                                    )}
                                                                    <div className="flex flex-wrap items-center gap-1">
                                                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs shrink-0" onClick={() => openCaptionModal([index], { [index]: version })}>
                                                                            Edit
                                                                        </Button>
                                                                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs shrink-0" onClick={() => openPreviewModal(index, version)}>
                                                                            <Eye className="mr-1 h-3 w-3" />Preview
                                                                        </Button>
                                                                        <span className="inline-flex shrink-0 items-center gap-1">
                                                                            <Button asChild size="sm" variant="outline" className="h-6 px-2 text-xs">
                                                                                <a href={`${API_URL}${version.url}`} download={version.filename}><Download className="mr-1 h-3 w-3" />Download</a>
                                                                            </Button>
                                                                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive transition-colors hover:bg-destructive hover:text-white hover:shadow-sm focus-visible:ring-destructive"
                                                                                onClick={() => deleteClipVersion(index, version)}
                                                                                disabled={deletingVersions[`${index}:${version.id}`]}
                                                                            >
                                                                                <Trash2 className="h-3 w-3" />
                                                                            </Button>
                                                                        </span>
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


            {/* Bulk Edit Modal */}
            {transcript && (
                <BulkEditModal
                    isOpen={isCaptionModalOpen}
                    onClose={() => setIsCaptionModalOpen(false)}
                    transcriptId={transcript._id}
                    clipIndexes={captionModalClipIndexes}
                    generatedClips={generatedClips}
                    sourceOverrides={captionModalSourceOverrides}
                    clips={transcript.clips}
                    onComplete={fetchTranscript}
                    onQueueStart={markBulkRenderQueued}
                />
            )}

            {transcript && (
                <DriveExportModal
                    open={driveExportOpen}
                    onOpenChange={setDriveExportOpen}
                    clips={Array.from(selectedClipIndexes).flatMap(idx => {
                        const v = generatedClips[idx];
                        return v ? [{ transcriptId: transcript._id, clipIndex: idx, videoId: v.id }] : [];
                    })}
                />
            )}

            {/* Clip Preview Modal */}
            {previewVideo && previewClip && (
                <Dialog open={Boolean(previewVideo)} onOpenChange={(open) => !open && closePreviewModal()}>
                    <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto p-0">
                        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
                            <div className="min-w-0 bg-black p-4 sm:p-6">
                                <video
                                    controls
                                    autoPlay
                                    src={`${API_URL}${previewVideo.video.url}`}
                                    className="h-auto max-h-[78vh] w-full rounded-md bg-black object-contain"
                                />
                            </div>
                            <aside className="space-y-4 border-t bg-background p-4 lg:border-l lg:border-t-0">
                                <DialogHeader className="pr-8">
                                    <DialogTitle className="text-base leading-snug">{previewClip.title}</DialogTitle>
                                    <DialogDescription>
                                        {getVideoLabel(previewVideo.video, previewIsPrimary)}
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="grid gap-2 text-xs text-muted-foreground">
                                    <div className="flex justify-between gap-3">
                                        <span>Duration</span>
                                        <span className="font-medium text-foreground">
                                            {formatTime(previewClip.totalDuration || (previewClip.end || 0) - (previewClip.start || 0))}
                                        </span>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                        <span>Created</span>
                                        <span className="text-right font-medium text-foreground">{formatVersionDate(previewVideo.video.createdAt)}</span>
                                    </div>
                                    {previewVideo.video.aspectRatio && (
                                        <div className="flex justify-between gap-3">
                                            <span>Aspect</span>
                                            <span className="font-medium text-foreground">{previewVideo.video.aspectRatio}</span>
                                        </div>
                                    )}
                                    {previewVideo.video.captions?.enabled && (
                                        <div className="flex justify-between gap-3">
                                            <span>Captions</span>
                                            <span className="font-medium text-foreground">{previewVideo.video.captions.style || 'Enabled'}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="grid gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            const { clipIndex, video } = previewVideo;
                                            closePreviewModal();
                                            openCaptionModal(
                                                [clipIndex],
                                                previewIsPrimary ? undefined : { [clipIndex]: video }
                                            );
                                        }}
                                    >
                                        Edit
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            const { clipIndex, video } = previewVideo;
                                            closePreviewModal();
                                            openSmartCropModal(video, clipIndex);
                                        }}
                                    >
                                        <Wand2 className="mr-2 h-4 w-4" />
                                        Smart Crop
                                    </Button>
                                    <Button asChild size="sm" variant="outline">
                                        <a href={`${API_URL}${previewVideo.video.url}`} download={previewVideo.video.filename}>
                                            <Download className="mr-2 h-4 w-4" />
                                            Download
                                        </a>
                                    </Button>
                                    {transcript.videoUrl && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                closePreviewModal();
                                                seekToClip(previewClip);
                                            }}
                                        >
                                            <ExternalLink className="mr-2 h-4 w-4" />
                                            Source segment
                                        </Button>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        className="transition-colors hover:bg-red-700 hover:text-white hover:shadow-sm focus-visible:ring-red-700"
                                        onClick={() => deleteClipVersionFromPreview(previewVideo.clipIndex, previewVideo.video)}
                                        disabled={deletingVersions[`${previewVideo.clipIndex}:${previewVideo.video.id}`]}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {deletingVersions[`${previewVideo.clipIndex}:${previewVideo.video.id}`] ? 'Deleting...' : 'Delete'}
                                    </Button>
                                </div>
                            </aside>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {/* Smart Crop Modal */}
            {transcript && selectedClipForSmartCrop && (
                <SmartCropModal
                    isOpen={isSmartCropModalOpen}
                    onClose={closeSmartCropModal}
                    transcriptId={transcript._id}
                    videoUrl={selectedClipForSmartCrop.url}
                    generatedClipUrl={selectedClipForSmartCrop.url}
                    sourceVideoId={selectedClipForSmartCrop.id}
                    clipDefinition={selectedClipForSmartCrop.clipDefinition}
                    clipTimeline={selectedClipForSmartCrop.clipTimeline}
                    clipIndex={selectedClipForSmartCrop.clipIndex}
                    onGenerationComplete={fetchTranscript}
                />
            )}

            <AlertDialog open={!!confirmDeleteVersion} onOpenChange={(open) => !open && setConfirmDeleteVersion(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Clip Version</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete this clip version? The video file will also be removed. This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={confirmDeleteVersion ? deletingVersions[`${confirmDeleteVersion.clipIndex}:${confirmDeleteVersion.video.id}`] : false}>
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                handleConfirmDeleteVersion();
                            }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={confirmDeleteVersion ? deletingVersions[`${confirmDeleteVersion.clipIndex}:${confirmDeleteVersion.video.id}`] : false}
                        >
                            {confirmDeleteVersion && deletingVersions[`${confirmDeleteVersion.clipIndex}:${confirmDeleteVersion.video.id}`] ? "Deleting..." : "Delete Version"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={confirmDeleteClip !== null} onOpenChange={(open) => !open && setConfirmDeleteClip(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Clip</AlertDialogTitle>
                        <AlertDialogDescription>
                            Delete this clip and all its generated videos? This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={confirmDeleteClip !== null && !!deletingClip[confirmDeleteClip]}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => { e.preventDefault(); handleConfirmDeleteClipItem(); }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={confirmDeleteClip !== null && !!deletingClip[confirmDeleteClip]}
                        >
                            {confirmDeleteClip !== null && deletingClip[confirmDeleteClip] ? "Deleting..." : "Delete Clip"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={confirmBulkDelete} onOpenChange={(open) => !open && setConfirmBulkDelete(false)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Selected Clips</AlertDialogTitle>
                        <AlertDialogDescription>
                            Delete {selectedClipIndexes.size} selected clip{selectedClipIndexes.size !== 1 ? 's' : ''} and all their generated videos? This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => { e.preventDefault(); handleConfirmBulkDelete(); }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={bulkDeleting}
                        >
                            {bulkDeleting ? "Deleting..." : `Delete ${selectedClipIndexes.size} Clip${selectedClipIndexes.size !== 1 ? 's' : ''}`}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={confirmDeleteTranscript} onOpenChange={(open) => !open && setConfirmDeleteTranscript(false)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Transcript</AlertDialogTitle>
                        <AlertDialogDescription>
                            Delete this transcript and all its clips and media? This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deletingTranscript}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => { e.preventDefault(); handleDeleteTranscript(); }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={deletingTranscript}
                        >
                            {deletingTranscript ? "Deleting..." : "Delete Transcript"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </main>
    );
}
