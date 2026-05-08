"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2, Palette, ChevronRight } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface BlockedWord {
  id: string;
  term: string;
  createdAt: string;
}

export default function ClipSettingsPage() {
  const [blockedWords, setBlockedWords] = useState<BlockedWord[]>([]);
  const [newTerm, setNewTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  const fetchBlockedWords = async () => {
    const response = await axios.get(`${API_URL}/clips/settings/blocked-words`);
    setBlockedWords(response.data.blockedWords || []);
  };

  useEffect(() => {
    fetchBlockedWords()
      .catch((err) => {
        setError(err.response?.data?.error || "Failed to load settings.");
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
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to save blocked word.");
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
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to delete blocked word.");
    } finally {
      setDeleting((prev) => ({ ...prev, [id]: false }));
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  return (
    <main className="container mx-auto max-w-4xl p-8 space-y-6">
      <Link href="/clips/settings/caption-templates">
        <Card className="cursor-pointer hover:border-gray-400 transition-colors">
          <CardContent className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <Palette className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-medium">Caption Templates</div>
                <div className="text-sm text-muted-foreground">Create and manage caption styles for videos</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">Clip Settings</CardTitle>
          <CardDescription>
            Configure the global blocked-word list used when analyzing clip candidates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {error}
            </div>
          ) : null}

          <form onSubmit={addTerm} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="blocked-word">Blocked word or phrase</Label>
              <Input
                id="blocked-word"
                value={newTerm}
                onChange={(event) => setNewTerm(event.target.value)}
                placeholder="Add a word or phrase"
              />
            </div>
            <Button type="submit" disabled={saving || !newTerm.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add
            </Button>
          </form>

          <div className="rounded-md border">
            <div className="border-b px-4 py-3 text-sm font-medium">
              Blocked words ({blockedWords.length})
            </div>
            {blockedWords.length ? (
              <div className="divide-y">
                {blockedWords.map((word) => (
                  <div key={word.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <div className="font-medium">{word.term}</div>
                      <div className="text-xs text-muted-foreground">
                        Added {new Date(word.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteTerm(word.id)}
                      disabled={deleting[word.id]}
                    >
                      {deleting[word.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No blocked words configured.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
