"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  Loader2,
  Sparkles,
  CheckCircle2,
  Circle,
  Pencil,
} from "lucide-react";
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

interface PromptTemplate {
  id: string;
  kind: string;
  name: string;
  body: string;
  isActive: boolean;
  createdAt: string;
}

interface KindMeta {
  label: string;
  description: string;
  vars: string[];
}

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [kinds, setKinds] = useState<Record<string, KindMeta>>({});
  const [loading, setLoading] = useState(true);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");

  const fetchData = async () => {
    const [promptsRes, metaRes] = await Promise.all([
      axios.get(`${API_URL}/clips/prompts`),
      axios.get(`${API_URL}/clips/prompts/meta`),
    ]);
    setPrompts(promptsRes.data.prompts);
    setKinds(metaRes.data.kinds);
  };

  useEffect(() => {
    fetchData()
      .catch((e) => setError(getErrorMessage(e, "Failed to load prompts")))
      .finally(() => setLoading(false));
  }, []);

  const activate = async (id: string, kind: string) => {
    setActivatingId(id);
    try {
      await axios.post(`${API_URL}/clips/prompts/${id}/activate`);
      setPrompts((prev) =>
        prev.map((p) =>
          p.kind === kind ? { ...p, isActive: p.id === id } : p
        )
      );
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to activate prompt"));
    } finally {
      setActivatingId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.id);
    try {
      await axios.delete(`${API_URL}/clips/prompts/${confirmDelete.id}`);
      setPrompts((prev) => prev.filter((p) => p.id !== confirmDelete.id));
      setConfirmDelete(null);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to delete prompt"));
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading prompts…</p>
      </div>
    );
  }

  const kindOrder = ["transcription", "clipAnalysis", "hookRegen"];

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold tracking-tight">AI Prompts</h2>
          <p className="text-muted-foreground text-sm">
            Customize the prompts sent to Gemini for each AI operation.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {kindOrder.map((kind) => {
        const meta = kinds[kind];
        if (!meta) return null;
        const kindPrompts = prompts.filter((p) => p.kind === kind);

        return (
          <div key={kind} className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">{meta.label}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
              </div>
              <Link href={`/clips/settings/prompts/new?kind=${kind}`}>
                <Button variant="outline" size="sm" className="gap-1.5 rounded-full">
                  <Plus className="h-3.5 w-3.5" />
                  New
                </Button>
              </Link>
            </div>

            <div className="space-y-2">
              {kindPrompts.length === 0 && (
                <div className="rounded-xl border border-dashed border-muted-foreground/20 px-5 py-8 text-center text-sm text-muted-foreground">
                  No prompts. Using built-in default.
                </div>
              )}
              {kindPrompts.map((prompt) => (
                <div
                  key={prompt.id}
                  onClick={() => !prompt.isActive && activatingId !== prompt.id && activate(prompt.id, prompt.kind)}
                  className={`group flex items-center gap-4 rounded-xl border px-4 py-3 transition-all duration-200 ${
                    prompt.isActive
                      ? "border-primary/40 bg-primary/5 shadow-sm shadow-primary/10"
                      : "border-muted-foreground/10 bg-card/50 hover:border-muted-foreground/20 cursor-pointer"
                  }`}
                >
                  <div className="shrink-0 text-primary">
                    {activatingId === prompt.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : prompt.isActive ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate">{prompt.name}</span>
                      {prompt.isActive && (
                        <Badge className="text-[9px] font-black tracking-tighter uppercase px-1.5 py-0.5 border-none shadow-sm h-4">
                          Active
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {prompt.body.slice(0, 100).replace(/\n/g, " ")}…
                    </p>
                  </div>

                  <div
                    className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Link href={`/clips/settings/prompts/${prompt.id}`}>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5 bg-muted/60 border-muted-foreground/20 hover:bg-white/90 hover:border-muted-foreground/30 text-foreground">
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      disabled={deletingId === prompt.id}
                      onClick={() => setConfirmDelete({ id: prompt.id, name: prompt.name })}
                    >
                      {deletingId === prompt.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{confirmDelete?.name}&quot;? This cannot be undone. If it was active, the built-in default will be used until another prompt is activated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              disabled={!!deletingId}
            >
              {deletingId ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
