"use client";

import React, { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, Wand2, Video, Eye, ExternalLink } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface LayoutStyle {
    fontSize: number;
    maxWordsPerPhrase: number;
    marginV: number;
    marginL: number;
    marginR: number;
    previewFontSize: number;
}

interface CaptionTemplate {
    id: string;
    name: string;
    description?: string;
    usage?: 'captions' | 'hooks' | 'both';
    fontName: string;
    fontColor: string;
    outlineColor: string;
    backColor?: string;
    outlineWidth: number;
    bold: boolean;
    italic: boolean;
    shadow: boolean;
    shadowDepth: number;
    scaleX: number;
    scaleY: number;
    spacing: number;
    uppercase: boolean;
    borderStyle: number;
    layouts: {
        portrait: LayoutStyle;
        square: LayoutStyle;
        landscape: LayoutStyle;
    };
}

function fontFamilyCSS(fontName: string): string {
    const lower = fontName.toLowerCase();
    if (lower.includes("mono") || lower === "courier") return `"${fontName}", monospace`;
    return `"${fontName}", sans-serif`;
}

function getErrorMessage(error: unknown, fallback: string) {
    return axios.isAxiosError<{ error?: string }>(error)
        ? error.response?.data?.error || fallback
        : fallback;
}

interface CaptionGeneratorProps {
    transcriptId: string;
    videoUrl: string;
}

export default function CaptionGenerator({ transcriptId, videoUrl }: CaptionGeneratorProps) {
    const [templates, setTemplates] = useState<CaptionTemplate[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<string>('');
    const [generating, setGenerating] = useState(false);
    const [generatedVideo, setGeneratedVideo] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [showPreview, setShowPreview] = useState(false);
    const [previewText, setPreviewText] = useState('Hello world');
    const [previewAspectRatio, setPreviewAspectRatio] = useState('9 / 16');

    useEffect(() => {
        fetchTemplates();
    }, []);

    const fetchTemplates = async () => {
        try {
            const response = await axios.get(`${API_URL}/clips/captions/styles`);
            const captionTemplates = response.data.captionStyles || [];
            setTemplates(captionTemplates);
            if (captionTemplates.length > 0) setSelectedTemplate(captionTemplates[0].id);
        } catch (err) {
            console.error('Failed to fetch caption templates:', err);
            setError('Failed to load caption templates');
        }
    };

    const generateCaptionedVideo = async () => {
        if (!selectedTemplate) { setError('Please select a caption template'); return; }
        setGenerating(true);
        setError('');
        setGeneratedVideo(null);

        try {
            const response = await axios.post(
                `${API_URL}/clips/captions/generate/${transcriptId}`,
                { style: selectedTemplate }
            );
            if (response.data.success) {
                setGeneratedVideo(`${API_URL}${response.data.captionedVideoUrl}`);
            } else {
                setError(response.data.error || 'Failed to generate captioned video');
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err, 'Failed to generate captioned video'));
        } finally {
            setGenerating(false);
        }
    };

    const downloadVideo = () => {
        if (!generatedVideo) return;
        const link = document.createElement('a');
        link.href = generatedVideo;
        link.download = `captioned-video-${selectedTemplate}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const getSelectedTemplate = () => templates.find((t) => t.id === selectedTemplate);

    const getPreviewLayout = () => {
        const [width, height] = previewAspectRatio.split('/').map((p) => Number(p.trim()));
        if (!width || !height) return 'portrait';
        const aspect = width / height;
        if (aspect < 0.9) return 'portrait';
        if (aspect > 1.2) return 'landscape';
        return 'square';
    };

    const getCaptionStyleCSS = (tmpl: CaptionTemplate): React.CSSProperties => {
        const layout = getPreviewLayout();
        const layoutData = tmpl.layouts[layout as keyof typeof tmpl.layouts];
        const shadowDepth = tmpl.shadowDepth ?? 1;
        const shadow = tmpl.shadow
            ? `${shadowDepth}px ${shadowDepth}px ${shadowDepth * 2}px rgba(0,0,0,0.8)` : 'none';
        const bg = tmpl.borderStyle === 3 && tmpl.backColor ? tmpl.backColor : 'transparent';
        return {
            position: 'absolute',
            bottom: layoutData.marginV,
            left: '50%',
            transform: `translateX(-50%) scale(${tmpl.scaleX ?? 1}, ${tmpl.scaleY ?? 1})`,
            transformOrigin: 'bottom center',
            textAlign: 'center',
            fontSize: 11,
            fontWeight: tmpl.bold ? 800 : 400,
            fontStyle: tmpl.italic ? 'italic' : 'normal',
            fontFamily: fontFamilyCSS(tmpl.fontName),
            color: tmpl.fontColor,
            background: bg,
            textShadow: shadow,
            lineHeight: 1.2,
            textTransform: tmpl.uppercase ? 'uppercase' : 'none',
            WebkitTextStroke: tmpl.outlineWidth > 0
                ? `${tmpl.outlineWidth}px ${tmpl.outlineColor}` : undefined,
            paintOrder: 'stroke fill',
            zIndex: 10,
            whiteSpace: 'nowrap',
        } as React.CSSProperties;
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                        <Video className="h-5 w-5" />
                        TikTok/Reels Caption Generator
                    </span>
                    <Link href="/clips/settings/caption-templates">
                        <Button variant="ghost" size="sm" className="text-xs">
                            <ExternalLink className="h-3 w-3 mr-1" />
                            Manage templates
                        </Button>
                    </Link>
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {error && (
                    <div className="p-3 bg-red-100 border border-red-300 text-red-700 rounded">{error}</div>
                )}

                <div>
                    <label className="block text-sm font-medium mb-2">Caption Template</label>
                    <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                        <SelectTrigger>
                            <SelectValue placeholder="Select a template" />
                        </SelectTrigger>
                        <SelectContent>
                            {templates.map((tmpl) => (
                                <SelectItem key={tmpl.id} value={tmpl.id}>
                                    <div className="flex flex-col">
                                        <span className="font-medium">{tmpl.name}</span>
                                        {tmpl.description && (
                                            <span className="text-xs text-muted-foreground">{tmpl.description}</span>
                                        )}
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex gap-2">
                    <Button onClick={() => setShowPreview(!showPreview)} disabled={!selectedTemplate}
                        variant="outline" className="flex-1">
                        <Eye className="h-4 w-4 mr-2" />
                        {showPreview ? 'Hide Preview' : 'Preview Style'}
                    </Button>
                    <Button onClick={generateCaptionedVideo} disabled={generating || !selectedTemplate}
                        className="flex-1">
                        <Wand2 className="h-4 w-4 mr-2" />
                        {generating ? 'Generating Captions...' : 'Generate Captioned Video'}
                    </Button>
                </div>

                {showPreview && selectedTemplate && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium mb-2">Preview Text</label>
                            <input type="text" value={previewText} onChange={(e) => setPreviewText(e.target.value)}
                                className="w-full p-2 border rounded-md" placeholder="Enter text to preview..." />
                        </div>
                        <div className="relative">
                            <div className="relative bg-gray-900 overflow-hidden" style={{ aspectRatio: previewAspectRatio, height: '300px' }}>
                                <video src={videoUrl} className="w-full h-full object-cover" muted
                                    onLoadedMetadata={(event) => {
                                        const v = event.currentTarget;
                                        if (v.videoWidth && v.videoHeight) {
                                            setPreviewAspectRatio(`${v.videoWidth} / ${v.videoHeight}`);
                                        }
                                    }} />
                                {getSelectedTemplate() && (
                                    <div style={getCaptionStyleCSS(getSelectedTemplate()!)}>
                                        {previewText}
                                    </div>
                                )}
                                <div className="absolute top-2 left-2">
                                    <Badge variant="secondary" className="text-xs">
                                        Preview: {getSelectedTemplate()?.name}
                                    </Badge>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {generatedVideo && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <Badge variant="secondary" className="bg-green-100 text-green-800">
                                Captioned video generated
                            </Badge>
                            <Button onClick={downloadVideo} variant="outline" size="sm">
                                <Download className="h-4 w-4 mr-2" />
                                Download
                            </Button>
                        </div>
                        <video controls src={generatedVideo} className="w-full rounded-lg shadow-lg max-h-96">
                            Your browser does not support the video tag.
                        </video>
                    </div>
                )}

                {templates.length > 0 && (
                    <div className="mt-6">
                        <h4 className="text-sm font-medium mb-3">Available Templates</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                            {templates.map((tmpl) => (
                                <div key={tmpl.id}
                                    className={`p-2 border rounded transition-colors cursor-pointer ${selectedTemplate === tmpl.id ? 'border-primary bg-primary/10' : 'border-gray-200 hover:border-gray-300'}`}
                                    onClick={() => setSelectedTemplate(tmpl.id)}>
                                    <div className="font-medium">{tmpl.name}</div>
                                    {tmpl.description && (
                                        <div className="text-muted-foreground">{tmpl.description}</div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
