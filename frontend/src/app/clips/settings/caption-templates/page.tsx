"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Copy, Trash2, Loader2, Palette } from "lucide-react";
import { CaptionTemplatePreview } from "@/components/CaptionTemplatePreview";

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
    isSeeded: boolean;
    usage?: "captions" | "hooks" | "both";
    fontName: string;
    fontColor: string;
    outlineColor: string;
    backColor?: string;
    outlineWidth: number;
    bold: boolean;
    italic: boolean;
    underline?: boolean;
    shadow: boolean;
    shadowDepth: number;
    alignment?: number;
    scaleX: number;
    scaleY: number;
    spacing?: number;
    uppercase: boolean;
    borderStyle: number;
    preview?: { backgroundColor?: string };
    layouts: { portrait: LayoutStyle; square: LayoutStyle; landscape: LayoutStyle };
}

function usageLabel(usage?: CaptionTemplate["usage"]) {
    if (usage === "captions") return "Captions only";
    if (usage === "hooks") return "Hooks only";
    return "Captions + hooks";
}

function getErrorMessage(error: unknown, fallback: string) {
    return axios.isAxiosError<{ error?: string }>(error)
        ? error.response?.data?.error || fallback
        : fallback;
}

export default function CaptionTemplatesPage() {
    const [templates, setTemplates] = useState<CaptionTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
    const [error, setError] = useState("");

    const fetchTemplates = async () => {
        const res = await axios.get(`${API_URL}/clips/caption-templates`);
        setTemplates(res.data.templates);
    };

    useEffect(() => {
        fetchTemplates()
            .catch((e) => setError(e.response?.data?.error || "Failed to load templates"))
            .finally(() => setLoading(false));
    }, []);

    const duplicate = async (id: string) => {
        setDuplicatingId(id);
        try {
            await axios.post(`${API_URL}/clips/caption-templates/${id}/duplicate`);
            await fetchTemplates();
        } catch (e: unknown) {
            setError(getErrorMessage(e, "Failed to duplicate"));
        } finally {
            setDuplicatingId(null);
        }
    };

    const deleteTemplate = async (id: string, name: string) => {
        if (!confirm(`Delete template "${name}"?`)) return;
        setDeletingId(id);
        try {
            await axios.delete(`${API_URL}/clips/caption-templates/${id}`);
            setTemplates((prev) => prev.filter((t) => t.id !== id));
        } catch (e: unknown) {
            setError(getErrorMessage(e, "Failed to delete"));
        } finally {
            setDeletingId(null);
        }
    };

    if (loading) {
        return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin" /></div>;
    }

    return (
        <main className="container mx-auto max-w-5xl p-8 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Palette className="h-6 w-6" />
                        Caption Templates
                    </h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Manage styles for burned-in captions and top hooks.
                    </p>
                </div>
                <Link href="/clips/settings/caption-templates/new">
                    <Button>
                        <Plus className="h-4 w-4 mr-2" />
                        New Template
                    </Button>
                </Link>
            </div>

            {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {templates.map((template) => (
                    <div key={template.id} className="flex flex-col gap-2">
                        <div className="relative rounded-lg overflow-hidden border border-gray-200 hover:border-gray-400 transition-colors"
                            style={{ aspectRatio: '9/16', maxHeight: 200 }}>
                            <CaptionTemplatePreview
                                template={template}
                                aspect="portrait"
                                text="SAMPLE TEXT"
                                className="h-full w-full"
                            />
                            {template.isSeeded && (
                                <div className="absolute top-1 left-1">
                                    <Badge variant="secondary" className="text-[10px] px-1 py-0">Default</Badge>
                                </div>
                            )}
                            <div className="absolute bottom-1 left-1">
                                <Badge variant="outline" className="bg-background/90 text-[10px] px-1 py-0">
                                    {usageLabel(template.usage)}
                                </Badge>
                            </div>
                        </div>
                        <div>
                            <p className="text-sm font-medium truncate">{template.name}</p>
                            {template.description && (
                                <p className="text-xs text-muted-foreground truncate">{template.description}</p>
                            )}
                        </div>
                        <div className="flex gap-1">
                            <Link href={`/clips/settings/caption-templates/${template.id}`} className="flex-1">
                                <Button size="sm" variant="outline" className="w-full">
                                    <Pencil className="h-3 w-3 mr-1" />
                                    Edit
                                </Button>
                            </Link>
                            <Button size="sm" variant="outline"
                                disabled={duplicatingId === template.id}
                                onClick={() => duplicate(template.id)}>
                                {duplicatingId === template.id
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <Copy className="h-3 w-3" />}
                            </Button>
                            <Button size="sm" variant="outline"
                                disabled={deletingId === template.id}
                                onClick={() => deleteTemplate(template.id, template.name)}
                                className="text-red-600 hover:text-red-700 hover:border-red-300">
                                {deletingId === template.id
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <Trash2 className="h-3 w-3" />}
                            </Button>
                        </div>
                    </div>
                ))}
            </div>

            {templates.length === 0 && (
                <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                        No templates yet.{" "}
                        <Link href="/clips/settings/caption-templates/new" className="underline">
                            Create one.
                        </Link>
                    </CardContent>
                </Card>
            )}
        </main>
    );
}
