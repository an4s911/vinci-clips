"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Check, Copy, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string }>(error)
    ? error.response?.data?.error || fallback
    : fallback;
}

export default function ApiKeySettingsPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    axios
      .get(`${API_URL}/clips/settings/api-key`)
      .then((res) => {
        setConfigured(res.data.configured ?? false);
        setCreatedAt(res.data.createdAt ?? null);
      })
      .catch((err) => setError(getErrorMessage(err, "Failed to load API key status.")))
      .finally(() => setLoading(false));
  }, []);

  const generate = async () => {
    setGenerating(true);
    setError("");
    setNewKey(null);
    try {
      const res = await axios.post(`${API_URL}/clips/settings/api-key`);
      setNewKey(res.data.key);
      setConfigured(true);
      setCreatedAt(res.data.createdAt);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to generate API key."));
    } finally {
      setGenerating(false);
    }
  };

  const revoke = async () => {
    setRevoking(true);
    setError("");
    try {
      await axios.delete(`${API_URL}/clips/settings/api-key`);
      setConfigured(false);
      setCreatedAt(null);
      setNewKey(null);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to revoke API key."));
    } finally {
      setRevoking(false);
    }
  };

  const copy = async () => {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">External API Key</h2>
        <p className="text-muted-foreground">
          Allows external services to trigger the video pipeline and poll progress without a browser session.
        </p>
        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      </div>

      <div className="rounded-2xl border bg-card/50 p-6 shadow-sm space-y-6">
        {/* Status row */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`rounded-xl p-2.5 ${configured ? "bg-green-500/10" : "bg-muted"}`}>
              <KeyRound className={`h-5 w-5 ${configured ? "text-green-600" : "text-muted-foreground"}`} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">{configured ? "Key configured" : "No key configured"}</span>
              {configured && createdAt && (
                <span className="text-xs text-muted-foreground">
                  Generated {new Date(createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
                </span>
              )}
              {!configured && (
                <span className="text-xs text-muted-foreground">Generate a key to enable the API.</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {configured ? (
              <>
                {/* Regenerate with confirmation */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" disabled={generating}>
                      {generating ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      Regenerate
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The current key will stop working immediately. Any service using it must be updated with the new key.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={generate}>Regenerate</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {/* Revoke with confirmation */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" disabled={revoking} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                      {revoking ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <Trash2 className="h-4 w-4 mr-2" />
                      )}
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The key will be deleted permanently. The external API will return 401 until a new key is generated.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={revoke}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : (
              <Button onClick={generate} disabled={generating}>
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <KeyRound className="h-4 w-4 mr-2" />
                )}
                Generate key
              </Button>
            )}
          </div>
        </div>

        {/* New key banner — shown once after generate/regenerate */}
        {newKey && (
          <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-green-700 dark:text-green-400">
              Key generated — copy it now. It won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-background border px-3 py-2 text-xs font-mono break-all select-all">
                {newKey}
              </code>
              <Button size="icon" variant="outline" onClick={copy} className="shrink-0 h-9 w-9">
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Usage reference */}
      <div className="rounded-2xl border bg-card/50 p-6 shadow-sm space-y-6">
        <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Usage</h3>

        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">Pass the key on every request via either header:</p>
          <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`X-Api-Key: <your-key>
Authorization: Bearer <your-key>`}</pre>
        </div>

        <div className="space-y-4">
          {/* Trigger */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">Trigger pipeline</p>
              <p className="text-xs text-muted-foreground">Supported platforms: YouTube, Instagram, LinkedIn, TikTok, Facebook.</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Request</p>
                <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`POST /api/v1/pipeline
Content-Type: application/json

{
  "url": "https://youtube.com/watch?v=..."
}`}</pre>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Response 202</p>
                <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`{
  "id": "clx1abc...",
  "status": "uploading"
}`}</pre>
              </div>
            </div>
          </div>

          {/* Poll */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold">Poll progress</p>
              <p className="text-xs text-muted-foreground">
                Poll until <code className="font-mono">status</code> is <code className="font-mono">completed</code>, <code className="font-mono">failed</code>, or <code className="font-mono">cancelled</code>.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Request</p>
                <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`GET /api/v1/pipeline/:id`}</pre>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Response 200</p>
                <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`{
  "id": "clx1abc...",
  "status": "generating",
  "phase": "clips",
  "message": "Generating clips...",
  "failureReason": null,
  "failedStage": null,
  "clipCount": 0,
  "updatedAt": "2024-01-01T00:00:00Z"
}`}</pre>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Status progression</p>
              <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto">{`uploading → downloading → converting → transcribing
  → analyzing → generating → rendering → completed
                                        ↘ failed | cancelled`}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
