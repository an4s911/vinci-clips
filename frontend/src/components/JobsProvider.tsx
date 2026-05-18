"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { CheckCircle, X, XCircle } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export type JobKind = 'transcript' | 'bulk-apply' | 'reframe' | 'caption-render';
export type JobStatus = 'running' | 'completed' | 'failed';

export interface Job {
    id: string;
    kind: JobKind;
    label: string;
    transcriptId?: string;
    clipIndex?: number;
    parentId?: string;
    status: JobStatus;
    phase?: string;
    progress?: { done: number; total: number };
    error?: string;
    createdAt: number;
}

interface ToastItem {
    id: string;
    message: string;
    kind: 'success' | 'error';
}

interface JobsContextValue {
    jobs: Job[];
    enqueueJob: (job: Job) => void;
    updateJob: (id: string, updates: Partial<Job>) => void;
    removeJob: (id: string) => void;
    jobsByTranscript: (transcriptId: string) => Job[];
}

const JobsContext = createContext<JobsContextValue | null>(null);

export function useJobs() {
    const ctx = useContext(JobsContext);
    if (!ctx) throw new Error('useJobs must be used inside JobsProvider');
    return ctx;
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const jobsRef = useRef<Job[]>([]);

    const enqueueJob = useCallback((job: Job) => {
        setJobs(prev => {
            const next = [...prev.filter(j => j.id !== job.id), job];
            jobsRef.current = next;
            return next;
        });
    }, []);

    const updateJob = useCallback((id: string, updates: Partial<Job>) => {
        setJobs(prev => {
            const next = prev.map(j => j.id === id ? { ...j, ...updates } : j);
            jobsRef.current = next;
            return next;
        });
    }, []);

    const removeJob = useCallback((id: string) => {
        setJobs(prev => {
            const next = prev.filter(j => j.id !== id);
            jobsRef.current = next;
            return next;
        });
    }, []);

    const jobsByTranscript = useCallback((transcriptId: string) => {
        return jobsRef.current.filter(j => j.transcriptId === transcriptId);
    }, []);

    const addToast = useCallback((message: string, kind: 'success' | 'error') => {
        const id = crypto.randomUUID();
        setToasts(prev => [...prev, { id, message, kind }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    }, []);

    // Fire toasts on terminal state transitions
    const prevJobsRef = useRef<Job[]>([]);
    useEffect(() => {
        const prev = prevJobsRef.current;
        for (const job of jobs) {
            const prevJob = prev.find(j => j.id === job.id);
            if (prevJob?.status === 'running' && job.status !== 'running') {
                if (job.kind === 'bulk-apply') {
                    const { progress } = job;
                    const summary = progress ? `${progress.done}/${progress.total} clips` : job.label;
                    addToast(job.status === 'completed' ? `Done — ${summary}` : `Failed — ${summary}`, job.status === 'completed' ? 'success' : 'error');
                } else if (!job.parentId) {
                    addToast(job.label + (job.status === 'completed' ? ' — done' : ' — failed'), job.status === 'completed' ? 'success' : 'error');
                }
            }
        }
        prevJobsRef.current = jobs;
    }, [jobs, addToast]);

    // Shared poller: tracks transcript-level jobs
    useEffect(() => {
        const interval = setInterval(async () => {
            const active = jobsRef.current.filter(j => j.status === 'running' && j.transcriptId && j.kind === 'transcript');
            const seen = new Set<string>();
            for (const job of active) {
                if (!job.transcriptId || seen.has(job.transcriptId)) continue;
                seen.add(job.transcriptId);
                try {
                    const res = await axios.get(`${API_URL}/clips/transcripts/${job.transcriptId}`);
                    const pj = res.data?.processingJob;
                    if (!pj) continue;
                    const terminal = ['completed', 'failed', 'cancelled'].includes(pj.status);
                    setJobs(prev => {
                        const next = prev.map(j => {
                            if (j.id !== job.id) return j;
                            return {
                                ...j,
                                status: terminal ? (pj.status === 'completed' ? 'completed' : 'failed') : 'running',
                                phase: pj.phase || pj.progressMessage,
                            };
                        });
                        jobsRef.current = next;
                        return next;
                    });
                } catch {/* ignore — transient network error */}
            }
        }, 3000);
        return () => clearInterval(interval);
    }, []);

    return (
        <JobsContext.Provider value={{ jobs, enqueueJob, updateJob, removeJob, jobsByTranscript }}>
            {children}
            <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none" aria-live="polite">
                {toasts.map(t => (
                    <div
                        key={t.id}
                        className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg pointer-events-auto bg-background ${
                            t.kind === 'error' ? 'border-red-300 text-red-900' : 'border-green-300 text-green-900'
                        }`}
                    >
                        {t.kind === 'error'
                            ? <XCircle className="h-4 w-4 flex-shrink-0" />
                            : <CheckCircle className="h-4 w-4 flex-shrink-0" />}
                        <span className="flex-1">{t.message}</span>
                        <button
                            onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                            className="ml-1 opacity-50 hover:opacity-100"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                ))}
            </div>
        </JobsContext.Provider>
    );
}
