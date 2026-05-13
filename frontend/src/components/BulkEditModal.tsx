"use client";

import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { CaptionTemplatePreview, CaptionPreviewTemplate, CaptionPreviewAspect } from '@/components/CaptionTemplatePreview';
import { Loader2, Monitor, Smartphone, Square, X } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

// ── Types ────────────────────────────────────────────────────────────────────

interface CaptionStyle extends CaptionPreviewTemplate {
    id: string;
    name: string;
    description?: string;
    hookOverrides?: {
        color?: string;
        position?: 'top' | 'center' | 'bottom';
        fontSizeMultiplier?: number;
        marginV?: number;
    };
}

interface ClipVideo {
    id: string;
    url: string;
    clipTimeline?: any[] | null;
}

interface Clip {
    title: string;
    start?: number;
    end?: number;
    segments?: { start: number; end: number }[];
    hook?: { text: string; enabled: boolean };
}

export interface BulkEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    transcriptId: string;
    clipIndexes: number[];
    generatedClips: { [key: number]: ClipVideo & { index?: number; title?: string } };
    clips: Clip[];
    onComplete: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORMS = [
    { id: 'tiktok',    name: 'TikTok / Shorts', aspectRatio: '9:16', icon: <Smartphone className="h-5 w-5" />, previewAspect: 'portrait'  as CaptionPreviewAspect },
    { id: 'instagram', name: 'Instagram Square', aspectRatio: '1:1',  icon: <Square      className="h-5 w-5" />, previewAspect: 'square'    as CaptionPreviewAspect },
    { id: 'youtube',   name: 'YouTube Wide',     aspectRatio: '16:9', icon: <Monitor     className="h-5 w-5" />, previewAspect: 'landscape' as CaptionPreviewAspect },
];

const POSITION_TO_ALIGNMENT: Record<string, number> = { top: 8, center: 5, bottom: 2 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function hookPreviewTemplate(style: CaptionStyle): CaptionPreviewTemplate {
    const ov = style.hookOverrides || {};
    const alignment = POSITION_TO_ALIGNMENT[ov.position ?? 'top'] ?? 8;
    const color = ov.color || style.fontColor;
    const marginV = ov.marginV ?? style.layouts?.portrait?.marginV ?? 50;
    const layouts = Object.fromEntries(
        Object.entries(style.layouts || {}).map(([k, v]) => [k, { ...v, marginV }])
    ) as CaptionPreviewTemplate['layouts'];
    return { ...style, alignment, fontColor: color, layouts };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, enabled, onToggle }: { title: string; enabled: boolean; onToggle: () => void }) {
    return (
        <button
            onClick={onToggle}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border-2 text-left transition-colors ${
                enabled ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/40'
            }`}
        >
            <span className="font-medium text-sm">{title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${enabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {enabled ? 'On' : 'Off'}
            </span>
        </button>
    );
}

function StyleGrid({ styles, value, onChange, disabled }: {
    styles: CaptionStyle[];
    value: string;
    onChange: (id: string) => void;
    disabled: boolean;
}) {
    return (
        <div className="grid grid-cols-3 gap-2 max-h-52 overflow-y-auto pr-1">
            {styles.map(s => (
                <button
                    key={s.id}
                    onClick={() => onChange(s.id)}
                    disabled={disabled}
                    className={`flex flex-col items-center gap-1 rounded-lg border-2 p-1 transition-colors ${
                        value === s.id ? 'border-primary bg-primary/5' : 'border-transparent hover:border-muted-foreground/30'
                    }`}
                >
                    <CaptionTemplatePreview
                        template={s}
                        aspect="portrait"
                        text="SAMPLE"
                        style={{ height: 72, width: '100%', borderRadius: 6 }}
                    />
                    <span className="text-xs font-medium truncate w-full text-center">{s.name}</span>
                </button>
            ))}
        </div>
    );
}

function CombinedPreview({
    captionStyle,
    hookStyle,
    aspect,
}: {
    captionStyle: CaptionStyle | null;
    hookStyle: CaptionStyle | null;
    aspect: CaptionPreviewAspect;
}) {
    const hookTemplate = hookStyle ? hookPreviewTemplate(hookStyle) : null;

    return (
        <div className="flex flex-col items-center gap-2 w-full">
            <p className="text-xs text-muted-foreground font-medium">Preview</p>
            <div
                className="relative w-full overflow-hidden rounded-xl border border-slate-700"
                style={{
                    aspectRatio: aspect === 'landscape' ? '16/9' : aspect === 'square' ? '1/1' : '9/16',
                }}
            >
                {captionStyle ? (
                    <CaptionTemplatePreview
                        template={captionStyle}
                        aspect={aspect}
                        text="CAPTION TEXT"
                        style={{ position: 'absolute', inset: 0, height: '100%', width: '100%', borderRadius: 0 }}
                    />
                ) : (
                    <div className="absolute inset-0 bg-slate-800 flex items-center justify-center">
                        <span className="text-slate-500 text-xs">no caption</span>
                    </div>
                )}
                {hookTemplate && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                        <CaptionTemplatePreview
                            template={hookTemplate}
                            aspect={aspect}
                            text="HOOK TEXT HERE"
                            style={{ height: '100%', width: '100%', background: 'transparent' }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export default function BulkEditModal({
    isOpen,
    onClose,
    transcriptId,
    clipIndexes,
    generatedClips,
    clips,
    onComplete,
}: BulkEditModalProps) {
    const [styles, setStyles] = useState<CaptionStyle[]>([]);
    const [fetching, setFetching] = useState(false);

    const [reframeEnabled, setReframeEnabled] = useState(true);
    const [captionsEnabled, setCaptionsEnabled] = useState(true);
    const [hookEnabled, setHookEnabled] = useState(true);

    const [platform, setPlatform] = useState('tiktok');
    const [captionStyleId, setCaptionStyleId] = useState('');
    const [hookStyleId, setHookStyleId] = useState('');

    const [applying, setApplying] = useState(false);
    const [progressMsg, setProgressMsg] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (!isOpen) return;
        setError('');
        setFetching(true);
        axios.get(`${API_URL}/clips/captions/styles`)
            .then(res => {
                const list: CaptionStyle[] = res.data.styles || [];
                setStyles(list);
                if (list.length > 0) {
                    if (!captionStyleId) setCaptionStyleId(list[0].id);
                    if (!hookStyleId) setHookStyleId(list[0].id);
                }
            })
            .catch(() => setError('Failed to load styles'))
            .finally(() => setFetching(false));
    }, [isOpen]);

    const isBulk = clipIndexes.length > 1;
    const selectedCaption = styles.find(s => s.id === captionStyleId) || null;
    const selectedHook = styles.find(s => s.id === hookStyleId) || null;
    const selectedPlatform = PLATFORMS.find(p => p.id === platform)!;
    const previewAspect: CaptionPreviewAspect = reframeEnabled
        ? (selectedPlatform?.previewAspect ?? 'portrait')
        : 'portrait';
    const nothingEnabled = !reframeEnabled && !captionsEnabled;

    const handleApply = async () => {
        if (nothingEnabled) return;
        setApplying(true);
        setError('');
        setProgressMsg('');

        const errors: string[] = [];
        let done = 0;

        for (const idx of clipIndexes) {
            setProgressMsg(`Processing clip ${done + 1} of ${clipIndexes.length}…`);
            const primaryVideo = generatedClips[idx];
            const clip = clips[idx];

            try {
                if (reframeEnabled) {
                    if (!primaryVideo) {
                        errors.push(`Clip ${idx + 1}: no generated video yet`);
                        continue;
                    }
                    const hookText = clip?.hook?.text || '';
                    await axios.post(`${API_URL}/clips/reframe/generate`, {
                        transcriptId,
                        clipIndex: idx,
                        generatedClipUrl: primaryVideo.url,
                        sourceVideoId: primaryVideo.id,
                        clipTimeline: primaryVideo.clipTimeline,
                        clipDefinition: clip,
                        targetPlatform: platform,
                        detections: [],
                        cropParameters: null,
                        captions: captionsEnabled ? { enabled: true, style: captionStyleId } : { enabled: false },
                        hookStyleId: hookEnabled ? hookStyleId : undefined,
                        hook: (hookEnabled && hookText) ? { enabled: true, text: hookText } : { enabled: false },
                    });
                } else if (captionsEnabled) {
                    await axios.post(`${API_URL}/clips/captions/render-clip`, {
                        transcriptId,
                        clipIndex: idx,
                        captionStyleId,
                        hookStyleId: hookEnabled ? hookStyleId : undefined,
                    });
                }
                done++;
            } catch (err: any) {
                errors.push(`Clip ${idx + 1}: ${err.response?.data?.error || err.message}`);
            }
        }

        setApplying(false);
        setProgressMsg('');

        if (errors.length > 0) {
            setError(`${done} done, ${errors.length} failed:\n${errors.join('\n')}`);
        } else {
            onComplete();
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-background rounded-xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh] overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0">
                    <h2 className="text-lg font-semibold">
                        {isBulk ? `Bulk Edit — ${clipIndexes.length} Clips` : 'Edit Clip'}
                    </h2>
                    <button onClick={onClose} disabled={applying} className="text-muted-foreground hover:text-foreground">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {fetching ? (
                    <div className="flex items-center justify-center py-16">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="flex flex-1 overflow-hidden min-h-0">

                        {/* Left: scrollable sections */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6 min-w-0">

                            {/* Reframe */}
                            <div className="space-y-3">
                                <SectionHeader title="Reframe" enabled={reframeEnabled} onToggle={() => setReframeEnabled(v => !v)} />
                                {reframeEnabled && (
                                    <div className="space-y-3 pl-1">
                                        <p className="text-xs text-muted-foreground">Center crop is applied automatically for all clips.</p>
                                        <div className="grid grid-cols-3 gap-2">
                                            {PLATFORMS.map(p => (
                                                <button
                                                    key={p.id}
                                                    onClick={() => setPlatform(p.id)}
                                                    disabled={applying}
                                                    className={`flex flex-col items-center gap-2 rounded-lg border-2 py-3 px-2 text-xs font-medium transition-colors ${
                                                        platform === p.id ? 'border-primary bg-primary/5' : 'border-muted hover:border-muted-foreground/40'
                                                    }`}
                                                >
                                                    {p.icon}
                                                    <span>{p.name}</span>
                                                    <span className="text-muted-foreground">{p.aspectRatio}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Captions */}
                            <div className="space-y-3">
                                <SectionHeader title="Caption Style" enabled={captionsEnabled} onToggle={() => setCaptionsEnabled(v => !v)} />
                                {captionsEnabled && (
                                    <div className="pl-1 space-y-2">
                                        <StyleGrid styles={styles} value={captionStyleId} onChange={setCaptionStyleId} disabled={applying} />
                                        {selectedCaption?.description && (
                                            <p className="text-xs text-muted-foreground">{selectedCaption.description}</p>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Hook */}
                            <div className="space-y-3">
                                <SectionHeader title="Hook Style" enabled={hookEnabled} onToggle={() => setHookEnabled(v => !v)} />
                                {hookEnabled && (
                                    <div className="pl-1 space-y-2">
                                        <p className="text-xs text-muted-foreground">Uses each clip's saved hook text. Edit per-clip before applying.</p>
                                        <StyleGrid styles={styles} value={hookStyleId} onChange={setHookStyleId} disabled={applying} />
                                        {selectedHook?.description && (
                                            <p className="text-xs text-muted-foreground">{selectedHook.description}</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Right: combined preview */}
                        <div className="w-52 flex-shrink-0 border-l p-5 flex flex-col items-center gap-4 bg-muted/20 overflow-y-auto">
                            <CombinedPreview
                                captionStyle={captionsEnabled ? selectedCaption : null}
                                hookStyle={hookEnabled ? selectedHook : null}
                                aspect={previewAspect}
                            />
                            <div className="text-xs text-muted-foreground text-center space-y-1 w-full">
                                {reframeEnabled && (
                                    <div className="truncate">Reframe: <span className="font-medium">{selectedPlatform?.name}</span></div>
                                )}
                                {captionsEnabled && (
                                    <div className="truncate">Captions: <span className="font-medium">{selectedCaption?.name || '—'}</span></div>
                                )}
                                {hookEnabled && (
                                    <div className="truncate">Hook: <span className="font-medium">{selectedHook?.name || '—'}</span></div>
                                )}
                                {nothingEnabled && (
                                    <div className="text-amber-600">Enable at least one option.</div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="border-t px-6 py-4 flex-shrink-0">
                    {error && (
                        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 whitespace-pre-wrap">{error}</div>
                    )}
                    {progressMsg && (
                        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />{progressMsg}
                        </div>
                    )}
                    <div className="flex justify-end gap-3">
                        <Button variant="outline" onClick={onClose} disabled={applying}>Cancel</Button>
                        <Button onClick={handleApply} disabled={applying || nothingEnabled || fetching}>
                            {applying
                                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Applying…</>
                                : `Apply to ${clipIndexes.length} clip${clipIndexes.length > 1 ? 's' : ''}`}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
