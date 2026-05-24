"use client";

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Download, Film, Loader2, Square, SquareCheckBig, HardDrive } from 'lucide-react';
import DriveExportModal from '@/components/DriveExportModal';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface PrimaryClipVideo {
    id: string;
    type: 'generated' | 'reframed';
    url: string;
    filename: string;
    createdAt: string;
    platform: string | null;
    platformName: string | null;
    aspectRatio: string | null;
    captions: { enabled: boolean; style?: string };
    thumbnailUrl?: string | null;
}

interface PrimaryClip {
    transcriptId: string;
    clipIndex: number;
    clipTitle: string;
    duration: number | null;
    video: PrimaryClipVideo;
}

interface VideoGroup {
    transcriptId: string;
    originalFilename: string;
    createdAt: string;
    clipCount: number;
    clips: PrimaryClip[];
}

interface BulkResponse {
    videos: VideoGroup[];
    totalVideos: number;
    totalClips: number;
}

function getClipKey(clip: PrimaryClip) {
    return `${clip.transcriptId}:${clip.clipIndex}:${clip.video.id}`;
}

function formatDuration(seconds: number | null) {
    if (seconds === null || Number.isNaN(seconds)) return null;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getDownloadFilename(disposition?: string) {
    const match = disposition?.match(/filename="?([^"]+)"?/i);
    return match?.[1] || 'vinci-primary-clips.zip';
}

function isErrorPayload(value: unknown): value is { details?: string; error?: string } {
    return typeof value === 'object' && value !== null;
}

async function getDownloadErrorMessage(error: unknown) {
    const data = axios.isAxiosError(error) ? error.response?.data : undefined;
    if (data instanceof Blob) {
        const text = await data.text();
        try {
            const parsed: unknown = JSON.parse(text);
            if (isErrorPayload(parsed)) {
                return parsed.details || parsed.error || 'Failed to download selected clips.';
            }
            return 'Failed to download selected clips.';
        } catch {
            return text || 'Failed to download selected clips.';
        }
    }
    return isErrorPayload(data)
        ? data.details || data.error || 'Failed to download selected clips.'
        : 'Failed to download selected clips.';
}

export default function BulkClipDownloadPage() {
    const [videos, setVideos] = useState<VideoGroup[]>([]);
    const [totalClips, setTotalClips] = useState(0);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState('');
    const [exportOpen, setExportOpen] = useState(false);

    useEffect(() => {
        const fetchPrimaryClips = async () => {
            try {
                const response = await axios.get<BulkResponse>(`${API_URL}/clips/clips/primary`);
                setVideos(response.data.videos || []);
                setTotalClips(response.data.totalClips || 0);
            } catch (err) {
                setError('Failed to load primary clips.');
                console.error(err);
            } finally {
                setLoading(false);
            }
        };

        fetchPrimaryClips();
    }, []);

    const allClipKeys = useMemo(() => (
        videos.flatMap(video => video.clips.map(getClipKey))
    ), [videos]);

    const selectedClips = useMemo(() => (
        videos.flatMap(video => video.clips.filter(clip => selectedKeys.has(getClipKey(clip))))
    ), [videos, selectedKeys]);

    const toggleClip = (clip: PrimaryClip) => {
        const key = getClipKey(clip);
        setSelectedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const selectAll = () => {
        setSelectedKeys(new Set(allClipKeys));
    };

    const clearAll = () => {
        setSelectedKeys(new Set());
    };

    const selectVideo = (video: VideoGroup) => {
        setSelectedKeys(prev => {
            const next = new Set(prev);
            video.clips.forEach(clip => next.add(getClipKey(clip)));
            return next;
        });
    };

    const clearVideo = (video: VideoGroup) => {
        setSelectedKeys(prev => {
            const next = new Set(prev);
            video.clips.forEach(clip => next.delete(getClipKey(clip)));
            return next;
        });
    };

    const downloadSelected = async () => {
        if (selectedClips.length === 0) return;

        setDownloading(true);
        setError('');

        try {
            const response = await axios.post(
                `${API_URL}/clips/clips/download-zip`,
                {
                    clips: selectedClips.map(clip => ({
                        transcriptId: clip.transcriptId,
                        clipIndex: clip.clipIndex,
                        videoId: clip.video.id
                    }))
                },
                { responseType: 'blob' }
            );

            const url = URL.createObjectURL(response.data);
            const link = document.createElement('a');
            link.href = url;
            link.download = getDownloadFilename(response.headers['content-disposition']);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (err: unknown) {
            setError(await getDownloadErrorMessage(err));
            console.error(err);
        } finally {
            setDownloading(false);
        }
    };

    if (loading) {
        return <div className="flex h-screen items-center justify-center">Loading clips...</div>;
    }

    return (
        <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 md:px-8">
            <div className="mx-auto max-w-7xl space-y-6">
                <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 md:flex-row md:items-end md:justify-between">
                    <div>
                        <Button asChild variant="ghost" className="mb-3 px-0">
                            <Link href="/clips/transcripts">Back to Transcripts</Link>
                        </Button>
                        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Bulk Download Clips</h1>
                        <p className="mt-2 text-sm text-slate-600">
                            Select primary clips across videos and download them as one ZIP.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" onClick={selectAll} disabled={allClipKeys.length === 0}>
                            <SquareCheckBig className="mr-2 h-4 w-4" />
                            Select All
                        </Button>
                        <Button variant="outline" onClick={clearAll} disabled={selectedKeys.size === 0}>
                            <Square className="mr-2 h-4 w-4" />
                            Unselect All
                        </Button>
                        <Button onClick={downloadSelected} disabled={selectedClips.length === 0 || downloading}>
                            {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                            Download Selected
                        </Button>
                        <Button variant="outline" onClick={() => setExportOpen(true)} disabled={selectedClips.length === 0}>
                            <HardDrive className="mr-2 h-4 w-4" />
                            Export to Drive
                        </Button>
                    </div>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                    <Card className="border-slate-200 bg-white">
                        <CardContent className="p-4">
                            <div className="text-sm text-slate-500">Videos with clips</div>
                            <div className="mt-1 text-2xl font-semibold">{videos.length}</div>
                        </CardContent>
                    </Card>
                    <Card className="border-slate-200 bg-white">
                        <CardContent className="p-4">
                            <div className="text-sm text-slate-500">Primary clips</div>
                            <div className="mt-1 text-2xl font-semibold">{totalClips}</div>
                        </CardContent>
                    </Card>
                    <Card className="border-slate-200 bg-white">
                        <CardContent className="p-4">
                            <div className="text-sm text-slate-500">Selected</div>
                            <div className="mt-1 text-2xl font-semibold">{selectedClips.length}</div>
                        </CardContent>
                    </Card>
                </div>

                {error && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {error}
                    </div>
                )}

                {videos.length === 0 ? (
                    <Card className="border-dashed border-slate-300 bg-white">
                        <CardContent className="flex flex-col items-center justify-center px-6 py-16 text-center">
                            <Film className="mb-4 h-10 w-10 text-slate-400" />
                            <h2 className="text-xl font-semibold">No primary clips yet</h2>
                            <p className="mt-2 max-w-md text-sm text-slate-600">
                                Generate clips from transcript details first. Only current primary clip versions appear here.
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-6">
                        {videos.map(video => {
                            const selectedInVideo = video.clips.filter(clip => selectedKeys.has(getClipKey(clip))).length;

                            return (
                                <section key={video.transcriptId} className="rounded-xl border border-slate-200 bg-white shadow-sm">
                                    <div className="flex flex-col gap-3 border-b border-slate-100 p-4 md:flex-row md:items-center md:justify-between">
                                        <div className="min-w-0">
                                            <h2 className="truncate text-lg font-semibold">{video.originalFilename}</h2>
                                            <p className="text-sm text-slate-500">
                                                {selectedInVideo} selected of {video.clipCount} primary clips
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                            <Button size="sm" variant="outline" onClick={() => selectVideo(video)}>
                                                Select video clips
                                            </Button>
                                            <Button size="sm" variant="outline" onClick={() => clearVideo(video)}>
                                                Clear video clips
                                            </Button>
                                            <Button asChild size="sm" variant="ghost">
                                                <Link href={`/clips/transcripts/${video.transcriptId}`}>Open Details</Link>
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                        {video.clips.map(clip => {
                                            const key = getClipKey(clip);
                                            const selected = selectedKeys.has(key);
                                            const duration = formatDuration(clip.duration);

                                            return (
                                                <button
                                                    key={key}
                                                    type="button"
                                                    onClick={() => toggleClip(clip)}
                                                    className={`group overflow-hidden rounded-lg border text-left transition ${
                                                        selected
                                                            ? 'border-teal-500 bg-teal-50 shadow-sm ring-2 ring-teal-200'
                                                            : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                                                    }`}
                                                >
                                                    <div className="relative bg-black">
                                                        <video
                                                            src={`${API_URL}${clip.video.url}`}
                                                            className="aspect-video w-full object-contain"
                                                            preload="none"
                                                            muted
                                                            poster={clip.video.thumbnailUrl ? `${API_URL}${clip.video.thumbnailUrl}` : undefined}
                                                        />
                                                        <div className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border ${
                                                            selected
                                                                ? 'border-teal-600 bg-teal-600 text-white'
                                                                : 'border-white/70 bg-black/40 text-white'
                                                        }`}>
                                                            {selected ? <Check className="h-4 w-4" /> : null}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-2 p-3">
                                                        <div className="line-clamp-2 text-sm font-semibold leading-snug">
                                                            {clip.clipTitle}
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                                            <span>Clip {clip.clipIndex + 1}</span>
                                                            {duration && <span>{duration}</span>}
                                                            {clip.video.platformName && <span>{clip.video.platformName}</span>}
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>

            <DriveExportModal
                open={exportOpen}
                onOpenChange={setExportOpen}
                clips={selectedClips.map(clip => ({
                    transcriptId: clip.transcriptId,
                    clipIndex: clip.clipIndex,
                    videoId: clip.video.id,
                }))}
            />
        </main>
    );
}
