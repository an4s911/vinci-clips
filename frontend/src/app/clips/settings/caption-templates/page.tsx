"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Plus, 
  Copy, 
  Trash2, 
  Loader2, 
  Search,
  Sparkles,
  Type
} from "lucide-react";
import { CaptionTemplatePreview } from "@/components/CaptionTemplatePreview";
import { Input } from "@/components/ui/input";
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
    if (usage === "captions") return "Captions Only";
    if (usage === "hooks") return "Hooks Only";
    return "Captions + Hooks";
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
    const [searchQuery, setSearchQuery] = useState("");
    const [confirmDelete, setConfirmDelete] = useState<{ id: string, name: string } | null>(null);

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

    const handleDelete = async () => {
        if (!confirmDelete) return;
        setDeletingId(confirmDelete.id);
        try {
            await axios.delete(`${API_URL}/clips/caption-templates/${confirmDelete.id}`);
            setTemplates((prev) => prev.filter((t) => t.id !== confirmDelete.id));
            setConfirmDelete(null);
        } catch (e: unknown) {
            setError(getErrorMessage(e, "Failed to delete"));
        } finally {
            setDeletingId(null);
        }
    };

    const filteredTemplates = templates.filter(t => 
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.description?.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground animate-pulse">Loading templates…</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                <div className="space-y-1">
                    <h2 className="text-2xl font-bold tracking-tight">Caption Templates</h2>
                    <p className="text-muted-foreground">
                        Manage your custom burned-in caption styles.
                    </p>
                </div>
                <Link href="/clips/settings/caption-templates/new">
                    <Button className="shadow-lg shadow-primary/20">
                        <Plus className="h-4 w-4 mr-2" />
                        New Template
                    </Button>
                </Link>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 items-center justify-between bg-muted/30 p-4 rounded-2xl border border-muted-foreground/10">
                <div className="relative w-full sm:max-w-xs">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input 
                        placeholder="Search templates…" 
                        className="pl-10 bg-background/50 border-none h-10 text-sm"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>
                <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground uppercase tracking-widest">
                    <Type className="h-4 w-4" />
                    <span>{filteredTemplates.length} Styles</span>
                </div>
            </div>

            {error && (
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredTemplates.map((template) => (
                    <div key={template.id} className="group relative flex flex-col gap-3">
                        <Link 
                            href={`/clips/settings/caption-templates/${template.id}`}
                            className="relative rounded-2xl overflow-hidden border border-muted-foreground/10 bg-card shadow-sm hover:shadow-xl hover:border-primary/30 transition-all duration-300 aspect-[9/16] max-h-[280px] cursor-pointer"
                        >
                            <CaptionTemplatePreview
                                template={template}
                                aspect="portrait"
                                text="STYLE PREVIEW"
                                className="h-full w-full"
                            />
                            
                            {/* Badges */}
                            <div className="absolute top-3 left-3 flex flex-col gap-1.5 pointer-events-none">
                                {template.isSeeded && (
                                    <Badge className="bg-primary text-[9px] font-black tracking-tighter uppercase px-1.5 py-0.5 border-none shadow-sm">
                                        Default
                                    </Badge>
                                )}
                                <Badge variant="outline" className="bg-black/40 backdrop-blur-md text-[9px] text-white border-white/10 px-1.5 py-0.5 font-bold uppercase tracking-tight">
                                    {usageLabel(template.usage)}
                                </Badge>
                            </div>

                            {/* Hover Overlay Actions */}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 gap-2 backdrop-blur-[2px]">
                                <Button 
                                    variant="secondary" 
                                    size="sm"
                                    className="w-full bg-white/90 hover:bg-white text-black border-none font-bold h-9"
                                    disabled={duplicatingId === template.id}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        duplicate(template.id);
                                    }}
                                >
                                    {duplicatingId === template.id
                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        : <Copy className="h-3.5 w-3.5 mr-2" />}
                                    Duplicate
                                </Button>
                                <Button 
                                    variant="destructive" 
                                    size="sm"
                                    className="w-full h-9 font-bold bg-red-600 hover:bg-red-700 transition-colors duration-200 shadow-lg shadow-red-900/10"
                                    disabled={deletingId === template.id}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        setConfirmDelete({ id: template.id, name: template.name });
                                    }}
                                >
                                    {deletingId === template.id
                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        : <Trash2 className="h-3.5 w-3.5 mr-2" />}
                                    Delete
                                </Button>
                            </div>
                        </Link>

                        <div className="px-1">
                            <h3 className="text-sm font-bold truncate group-hover:text-primary transition-colors">
                                {template.name}
                            </h3>
                            <p className="text-[11px] text-muted-foreground truncate leading-relaxed">
                                {template.description || "No description provided."}
                            </p>
                        </div>
                    </div>
                ))}
            </div>

            {filteredTemplates.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 bg-muted/10 rounded-3xl border border-dashed border-muted-foreground/20">
                    <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
                        <Search className="h-8 w-8 text-muted-foreground/40" />
                    </div>
                    <div className="space-y-1">
                        <h3 className="font-bold">No templates found</h3>
                        <p className="text-xs text-muted-foreground max-w-[200px] mx-auto leading-relaxed">
                            {searchQuery ? `We couldn't find any results for "${searchQuery}".` : "You haven't created any custom templates yet."}
                        </p>
                    </div>
                    {!searchQuery && (
                        <Link href="/clips/settings/caption-templates/new">
                            <Button variant="outline" size="sm" className="rounded-full px-6">
                                <Plus className="h-4 w-4 mr-2" />
                                Create First Template
                            </Button>
                        </Link>
                    )}
                </div>
            )}

            <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Template</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete &quot;{confirmDelete?.name}&quot;? This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={!!deletingId}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={(e) => {
                                e.preventDefault();
                                handleDelete();
                            }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                            disabled={!!deletingId}
                        >
                            {deletingId ? "Deleting..." : "Delete Template"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
