"use client";

import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { AlertCircle, CheckCircle, Clock, Download, Loader2, StopCircle, Trash2 } from 'lucide-react';
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

interface ProcessingJob {
    status: 'idle' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
    phase: string;
    progressMessage: string;
    error?: string | null;
}

interface Transcript {
    _id: string;
    originalFilename: string;
    createdAt: string;
    status?: string;
    failureReason?: string | null;
    failedAt?: string | null;
    failedStage?: string | null;
    platform?: string | null;
    processingJob?: ProcessingJob | null;
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    uploading:   { label: 'Uploading',        variant: 'secondary' },
    downloading: { label: 'Downloading',      variant: 'secondary' },
    converting:  { label: 'Converting',       variant: 'secondary' },
    transcribing:{ label: 'Transcribing',     variant: 'secondary' },
    analyzing:   { label: 'Analyzing',        variant: 'secondary' },
    generating:  { label: 'Generating clips', variant: 'secondary' },
    completed:   { label: 'Ready',            variant: 'default' },
    failed:      { label: 'Failed',           variant: 'destructive' },
    cancelled:   { label: 'Cancelled',        variant: 'outline' },
};

function getStatusBadge(status?: string) {
    const cfg = STATUS_CONFIG[status || ''] || { label: 'Ready', variant: 'default' as const };
    return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

function getStatusIcon(status?: string) {
    if (!status || status === 'completed') return <CheckCircle className="h-4 w-4 text-green-500" />;
    if (status === 'failed') return <AlertCircle className="h-4 w-4 text-red-500" />;
    if (status === 'cancelled') return <StopCircle className="h-4 w-4 text-amber-500" />;
    if (['uploading','downloading','converting','transcribing','analyzing','generating'].includes(status)) {
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    }
    return <Clock className="h-4 w-4 text-gray-500" />;
}

function isProcessing(t: Transcript) {
    return t.processingJob
        ? ['queued', 'running', 'cancelling'].includes(t.processingJob.status)
        : Boolean(t.status && !['completed', 'failed', 'cancelled'].includes(t.status));
}

export default function TranscriptsPage() {
    const [transcripts, setTranscripts] = useState<Transcript[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<{ id: string, name: string } | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchTranscripts = async () => {
        try {
            const response = await axios.get(`${API_URL}/clips/transcripts`);
            setTranscripts(response.data);
        } catch (err) {
            setError('Failed to fetch transcripts. Please try again later.');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTranscripts();
    }, []);

    // Poll while any transcript is processing
    useEffect(() => {
        const anyProcessing = transcripts.some(isProcessing);
        if (!anyProcessing) return;
        const interval = setInterval(fetchTranscripts, 3000);
        return () => clearInterval(interval);
    }, [transcripts]);

    const handleDeleteClick = (id: string, name: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setConfirmDelete({ id, name });
    };

    const handleConfirmDelete = async () => {
        if (!confirmDelete) return;
        setIsDeleting(true);
        try {
            await axios.delete(`${API_URL}/clips/transcripts/${confirmDelete.id}`);
            setTranscripts(prev => prev.filter(t => t._id !== confirmDelete.id));
            setConfirmDelete(null);
        } catch (err: unknown) {
            console.error('Error deleting video:', err);
            const message = axios.isAxiosError<{ error?: string; details?: string; message?: string }>(err)
                ? err.response?.data?.details || err.response?.data?.error || err.response?.data?.message || 'Failed to delete video.'
                : 'Failed to delete video.';
            setError(message);
        } finally {
            setIsDeleting(false);
        }
    };

    if (loading) return <div className="flex justify-center items-center h-screen">Loading...</div>;
    if (error) return <div className="flex justify-center items-center h-screen">{error}</div>;

    return (
        <main className="container mx-auto p-8">
            <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <h1 className="text-4xl font-bold">All Videos</h1>
                <Button asChild>
                    <Link href="/clips/bulk-download">
                        <Download className="mr-2 h-4 w-4" />
                        Bulk Download Clips
                    </Link>
                </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {transcripts.map((transcript) => (
                    <Card key={transcript._id}>
                        <CardHeader>
                            <div className="flex items-start justify-between gap-2">
                                <CardTitle className="truncate pr-1 flex-1 w-0 text-base">
                                    {transcript.originalFilename}
                                </CardTitle>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                    {getStatusIcon(transcript.status)}
                                    <Trash2
                                        className="h-4 w-4 text-red-500 cursor-pointer hover:text-red-700"
                                        onClick={(e) => handleDeleteClick(transcript._id, transcript.originalFilename, e)}
                                    />
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <div className="flex items-center gap-2">
                                {getStatusBadge(transcript.status)}
                            </div>
                            {transcript.processingJob && isProcessing(transcript) && (
                                <p className="text-xs text-muted-foreground">
                                    {transcript.processingJob.progressMessage}
                                </p>
                            )}
                            {transcript.status === 'failed' && transcript.failureReason && (
                                <p className="text-xs text-red-600">{transcript.failureReason}</p>
                            )}
                            <p className="text-sm text-muted-foreground">
                                {new Date(transcript.createdAt).toLocaleDateString()}
                            </p>
                            <Button asChild className="w-full mt-2">
                                <Link href={`/clips/transcripts/${transcript._id}`}>
                                    {isProcessing(transcript) ? 'View Progress' : 'View Details'}
                                </Link>
                            </Button>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Video</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete &quot;{confirmDelete?.name}&quot;? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => { e.preventDefault(); handleConfirmDelete(); }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={isDeleting}
                        >
                            {isDeleting ? "Deleting..." : "Delete Video"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </main>
    );
}
