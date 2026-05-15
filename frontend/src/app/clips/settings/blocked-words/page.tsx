"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  Loader2, 
  Plus, 
  Trash2, 
  ShieldAlert, 
  Search
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface BlockedWord {
  id: string;
  term: string;
  createdAt: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

export default function BlockedWordsPage() {
  const [blockedWords, setBlockedWords] = useState<BlockedWord[]>([]);
  const [newTerm, setNewTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const fetchBlockedWords = async () => {
    const response = await axios.get(`${API_URL}/clips/settings/blocked-words`);
    setBlockedWords(response.data.blockedWords || []);
  };

  useEffect(() => {
    fetchBlockedWords()
      .catch((err) => {
        setError(getErrorMessage(err, "Failed to load settings."));
      })
      .finally(() => setLoading(false));
  }, []);

  const addTerm = async (event: React.FormEvent) => {
    event.preventDefault();
    const term = newTerm.trim();
    if (!term) return;

    setSaving(true);
    setError("");
    try {
      const response = await axios.post(`${API_URL}/clips/settings/blocked-words`, { term });
      setBlockedWords(response.data.blockedWords || []);
      setNewTerm("");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to save blocked word."));
    } finally {
      setSaving(false);
    }
  };

  const deleteTerm = async (id: string) => {
    setDeleting((prev) => ({ ...prev, [id]: true }));
    setError("");
    try {
      await axios.delete(`${API_URL}/clips/settings/blocked-words/${id}`);
      setBlockedWords((prev) => prev.filter((word) => word.id !== id));
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to delete blocked word."));
    } finally {
      setDeleting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const filteredWords = blockedWords.filter(w => 
    w.term.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading content filters…</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Content Filter</h2>
        <p className="text-muted-foreground">
          Exclude specific words and phrases from being analyzed by the AI.
        </p>
        {error ? (
          <p className="text-sm font-medium text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
        <div className="space-y-6">
          <form onSubmit={addTerm} className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="blocked-word"
                value={newTerm}
                onChange={(event) => setNewTerm(event.target.value)}
                placeholder="Add a word or phrase…"
                className="bg-background/50 border-muted-foreground/20 focus-visible:ring-primary/30 h-11"
              />
            </div>
            <Button type="submit" disabled={saving || !newTerm.trim()} className="px-6 h-11 shadow-md shadow-primary/10">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Add Term
            </Button>
          </form>

          <div className="rounded-2xl border bg-card/50 overflow-hidden shadow-sm">
            <div className="bg-muted/30 px-6 py-4 border-b flex justify-between items-center">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input 
                  placeholder="Search blocked terms…" 
                  className="pl-9 h-9 bg-background/50 border-none text-xs"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <span className="text-xs bg-muted px-2.5 py-1 rounded-full font-bold text-muted-foreground">
                {filteredWords.length} TOTAL
              </span>
            </div>
            
            <div className="max-h-[500px] overflow-y-auto divide-y divide-border/50">
              {filteredWords.length ? (
                filteredWords.map((word) => (
                  <div 
                    key={word.id} 
                    className="group flex items-center justify-between gap-3 px-6 py-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm">{word.term}</span>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
                        Added {new Date(word.createdAt).toLocaleDateString(undefined, { 
                          month: 'short', 
                          day: 'numeric', 
                          year: 'numeric' 
                        })}
                      </span>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteTerm(word.id)}
                      disabled={deleting[word.id]}
                      aria-label={`Delete "${word.term}"`}
                      className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      {deleting[word.id] ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center px-6">
                  <div className="h-16 w-16 rounded-3xl bg-muted flex items-center justify-center mb-4 rotate-12">
                    <ShieldAlert className="h-8 w-8 text-muted-foreground/40" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    {searchQuery ? `No terms match "${searchQuery}"` : "Your content filter is empty"}
                  </p>
                  <p className="text-xs text-muted-foreground/60 mt-2 max-w-[200px]">
                    {searchQuery ? "Try a different search term." : "AI will use standard safety protocols for generation."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="p-6 rounded-2xl border border-muted bg-muted/10 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Quick Stats</h4>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Active Filters</span>
                <span className="font-mono font-bold">{blockedWords.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Last Update</span>
                <span className="font-mono font-bold text-[10px]">
                  {blockedWords.length > 0 
                    ? new Date(Math.max(...blockedWords.map(w => new Date(w.createdAt).getTime()))).toLocaleDateString()
                    : "N/A"
                  }
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
