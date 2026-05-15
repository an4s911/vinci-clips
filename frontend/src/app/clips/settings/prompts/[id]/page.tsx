"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Loader2,
  Trash2,
  CheckCircle2,
  Sparkles,
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
}

interface KindMeta {
  label: string;
  vars: string[];
}

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

export default function PromptEditorPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [prompt, setPrompt] = useState<PromptTemplate | null>(null);
  const [kindMeta, setKindMeta] = useState<KindMeta | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      axios.get(`${API_URL}/clips/prompts/${id}`),
      axios.get(`${API_URL}/clips/prompts/meta`),
    ])
      .then(([promptRes, metaRes]) => {
        const p = promptRes.data.prompt as PromptTemplate;
        setPrompt(p);
        setName(p.name);
        setBody(p.body);
        setKindMeta(metaRes.data.kinds[p.kind] || null);
      })
      .catch((e) => setError(getErrorMessage(e, "Failed to load prompt")))
      .finally(() => setLoading(false));
  }, [id]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await axios.put(`${API_URL}/clips/prompts/${id}`, { name, body });
      setPrompt(res.data.prompt);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  const activate = async () => {
    setActivating(true);
    setError("");
    try {
      const res = await axios.post(`${API_URL}/clips/prompts/${id}/activate`);
      setPrompt(res.data.prompt);
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to activate"));
    } finally {
      setActivating(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`${API_URL}/clips/prompts/${id}`);
      router.push("/clips/settings/prompts");
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to delete"));
      setDeleting(false);
    }
  };

  const insertVar = (varName: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const inserted = `{{${varName}}}`;
    const next = body.slice(0, start) + inserted + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
      </div>
    );
  }

  if (!prompt) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Prompt not found.{" "}
        <Link href="/clips/settings/prompts" className="underline">Back</Link>
      </div>
    );
  }

  const isDirty = name !== prompt.name || body !== prompt.body;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-3">
        <Link href="/clips/settings/prompts">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold tracking-tight truncate">{prompt.name}</h2>
            {prompt.isActive && (
              <Badge className="text-[9px] font-black tracking-tighter uppercase px-1.5 py-0.5 border-none h-4">
                Active
              </Badge>
            )}
            {kindMeta && (
              <Badge variant="outline" className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5">
                {kindMeta.label}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Prompt name"
          className="bg-background/50"
        />
      </div>

      {kindMeta && kindMeta.vars.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Available variables — click to insert at cursor
          </label>
          <div className="flex flex-wrap gap-2">
            {kindMeta.vars.map((v) => (
              <button
                key={v}
                onClick={() => insertVar(v)}
                className="font-mono text-xs px-2.5 py-1 rounded-lg bg-muted hover:bg-primary/10 hover:text-primary border border-muted-foreground/10 transition-colors"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Prompt body</label>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={20}
          className="w-full rounded-xl border border-muted-foreground/30 bg-background/50 px-4 py-3 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
          placeholder="Enter prompt…"
          spellCheck={false}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Button onClick={save} disabled={saving || !isDirty} className="shadow-lg shadow-primary/20">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : saved ? <CheckCircle2 className="h-4 w-4 mr-2" /> : null}
          {saved ? "Saved" : "Save"}
        </Button>

        {!prompt.isActive && (
          <Button variant="outline" onClick={activate} disabled={activating}>
            {activating && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Set Active
          </Button>
        )}

        <Button
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Prompt</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{prompt.name}&quot;? This cannot be undone.
              {prompt.isActive && " Since it's active, the built-in default will be used until another prompt is activated."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
