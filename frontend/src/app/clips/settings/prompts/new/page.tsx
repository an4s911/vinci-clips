"use client";

import React, { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft,
  Loader2,
  Sparkles,
} from "lucide-react";
import { PromptVariables } from "../PromptVariables";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface KindMeta {
  label: string;
  description: string;
  vars: string[];
  varDetails?: Record<string, { description: string; example: string }>;
}

const KIND_ORDER = ["transcription", "clipAnalysis", "hookRegen"];

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

function NewPromptForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [kinds, setKinds] = useState<Record<string, KindMeta>>({});
  const [prompts, setPrompts] = useState<{ kind: string; body: string; isActive: boolean }[]>([]);
  const [kind, setKind] = useState(searchParams.get("kind") || "transcription");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      axios.get(`${API_URL}/clips/prompts/meta`),
      axios.get(`${API_URL}/clips/prompts`),
    ])
      .then(([metaRes, promptsRes]) => {
        setKinds(metaRes.data.kinds);
        setPrompts(promptsRes.data.prompts);
      })
      .catch((e) => setError(getErrorMessage(e, "Failed to load")))
      .finally(() => setLoading(false));
  }, []);

  // Prefill body from active prompt for selected kind
  useEffect(() => {
    if (!prompts.length) return;
    const active = prompts.find((p) => p.kind === kind && p.isActive);
    if (active) setBody(active.body);
    else setBody("");
  }, [kind, prompts]);

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

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await axios.post(`${API_URL}/clips/prompts`, { kind, name, body });
      router.push("/clips/settings/prompts");
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to create prompt"));
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
      </div>
    );
  }

  const meta = kinds[kind];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-3">
        <Link href="/clips/settings/prompts">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h2 className="text-2xl font-bold tracking-tight">New Prompt</h2>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Kind</label>
        <div className="flex flex-wrap gap-2">
          {KIND_ORDER.map((k) => {
            const m = kinds[k];
            if (!m) return null;
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 ${
                  kind === k
                    ? "bg-primary text-primary-foreground border-primary shadow-lg shadow-primary/20"
                    : "border-muted-foreground/10 bg-card/50 text-muted-foreground hover:text-foreground hover:border-muted-foreground/20"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        {meta && <p className="text-xs text-muted-foreground">{meta.description}</p>}
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Aggressive Hook Style"
          className="bg-background/50"
        />
      </div>

      {meta && meta.vars.length > 0 && (
        <PromptVariables
          vars={meta.vars}
          varDetails={meta.varDetails}
          onInsert={insertVar}
        />
      )}

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Prompt body</label>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={20}
          className="w-full rounded-xl border border-muted-foreground/10 bg-background/50 px-4 py-3 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
          placeholder="Enter prompt…"
          spellCheck={false}
        />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button
          onClick={save}
          disabled={saving || !name.trim() || !body.trim()}
          className="shadow-lg shadow-primary/20"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Create Prompt
        </Button>
        <Link href="/clips/settings/prompts">
          <Button variant="ghost">Cancel</Button>
        </Link>
      </div>
    </div>
  );
}

export default function NewPromptPage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    }>
      <NewPromptForm />
    </Suspense>
  );
}
