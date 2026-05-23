"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  Plus,
  Trash2,
  HardDrive,
  Search,
  CheckCircle2,
  Link2,
  Unlink,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface SavedFolder {
  id: string;
  driveFolderId: string;
  name: string;
  addedAt: string;
}

interface DriveFolder {
  id: string;
  name: string;
}

interface AuthStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
}

function getErrorMessage(error: unknown, fallback: string) {
  return axios.isAxiosError<{ error?: string; details?: string }>(error)
    ? error.response?.data?.error || error.response?.data?.details || fallback
    : fallback;
}

export default function GoogleDriveSettingsPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [folders, setFolders] = useState<SavedFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<DriveFolder[]>([]);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const searchSeq = useRef(0);

  const loadStatus = useCallback(async () => {
    const res = await axios.get(`${API_URL}/clips/google-drive/auth/status`);
    setStatus(res.data);
  }, []);

  const loadFolders = useCallback(async () => {
    const res = await axios.get(`${API_URL}/clips/google-drive/folders`);
    setFolders(res.data.folders || []);
  }, []);

  useEffect(() => {
    // Surface OAuth callback result from the redirect query string.
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setNotice("Google Drive connected.");
    const driveError = params.get("drive_error");
    if (driveError) setError(driveError);
    if (params.get("connected") || driveError) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    Promise.all([loadStatus(), loadFolders()])
      .catch((err) => setError(getErrorMessage(err, "Failed to load Drive settings.")))
      .finally(() => setLoading(false));
  }, [loadStatus, loadFolders]);

  const connect = async () => {
    setConnecting(true);
    setError("");
    try {
      const res = await axios.get(`${API_URL}/clips/google-drive/auth/url`);
      window.location.href = res.data.url;
    } catch (err) {
      setError(getErrorMessage(err, "Failed to start Google connection."));
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setError("");
    try {
      await axios.post(`${API_URL}/clips/google-drive/auth/disconnect`);
      await loadStatus();
      setNotice("Google Drive disconnected.");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to disconnect."));
    } finally {
      setDisconnecting(false);
    }
  };

  // Debounced live Drive search.
  useEffect(() => {
    if (!status?.connected) return;
    const term = query.trim();
    const seq = ++searchSeq.current;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await axios.get(`${API_URL}/clips/google-drive/folders/search`, {
          params: { q: term },
        });
        if (seq === searchSeq.current) setResults(res.data.folders || []);
      } catch (err) {
        if (seq === searchSeq.current) setError(getErrorMessage(err, "Drive search failed."));
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [query, status?.connected]);

  const addFolder = async (folder: DriveFolder) => {
    setAdding((p) => ({ ...p, [folder.id]: true }));
    setError("");
    try {
      const res = await axios.post(`${API_URL}/clips/google-drive/folders`, {
        driveFolderId: folder.id,
        name: folder.name,
      });
      setFolders(res.data.folders || []);
      setNotice(`Added "${folder.name}".`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to add folder."));
    } finally {
      setAdding((p) => ({ ...p, [folder.id]: false }));
    }
  };

  const removeFolder = async (id: string) => {
    setDeleting((p) => ({ ...p, [id]: true }));
    setError("");
    try {
      const res = await axios.delete(`${API_URL}/clips/google-drive/folders/${id}`);
      setFolders(res.data.folders || []);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove folder."));
    } finally {
      setDeleting((p) => ({ ...p, [id]: false }));
    }
  };

  const savedIds = new Set(folders.map((f) => f.driveFolderId));

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground animate-pulse">Loading Drive settings…</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Google Drive</h2>
        <p className="text-muted-foreground">
          Connect a Google account and pick the folders clips can be exported to.
        </p>
        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
        {notice ? <p className="text-sm font-medium text-green-600">{notice}</p> : null}
      </div>

      {/* Connection */}
      <div className="rounded-2xl border bg-card/50 p-6 shadow-sm">
        {!status?.configured ? (
          <p className="text-sm text-muted-foreground">
            Drive OAuth is not configured on the server. Set <code className="font-mono">GOOGLE_CLIENT_ID</code>,{" "}
            <code className="font-mono">GOOGLE_CLIENT_SECRET</code> and{" "}
            <code className="font-mono">GOOGLE_OAUTH_REDIRECT_URI</code>.
          </p>
        ) : status.connected ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-green-500/10 p-2.5">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold">Connected</span>
                <span className="text-xs text-muted-foreground">{status.email || "Google account"}</span>
              </div>
            </div>
            <Button variant="outline" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Unlink className="h-4 w-4 mr-2" />}
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-muted p-2.5">
                <HardDrive className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold">Not connected</span>
                <span className="text-xs text-muted-foreground">Authorize once to enable exports.</span>
              </div>
            </div>
            <Button onClick={connect} disabled={connecting}>
              {connecting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Link2 className="h-4 w-4 mr-2" />}
              Connect Google Drive
            </Button>
          </div>
        )}
      </div>

      {status?.connected ? (
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Search + add */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Find folders</h3>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your Drive folders…"
                className="pl-9 h-11 bg-background/50"
              />
              {searching ? (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            <div className="rounded-2xl border bg-card/50 overflow-hidden divide-y divide-border/50 max-h-[420px] overflow-y-auto">
              {results.length ? (
                results.map((folder) => {
                  const already = savedIds.has(folder.id);
                  return (
                    <div key={folder.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50">
                      <span className="text-sm truncate">{folder.name}</span>
                      <Button
                        size="sm"
                        variant={already ? "ghost" : "secondary"}
                        onClick={() => addFolder(folder)}
                        disabled={already || adding[folder.id]}
                      >
                        {adding[folder.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : already ? (
                          "Added"
                        ) : (
                          <>
                            <Plus className="h-4 w-4 mr-1" /> Add
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {searching ? "Searching…" : "No folders found."}
                </div>
              )}
            </div>
          </div>

          {/* Saved list */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Export folders ({folders.length})
            </h3>
            <div className="rounded-2xl border bg-card/50 overflow-hidden divide-y divide-border/50 max-h-[420px] overflow-y-auto">
              {folders.length ? (
                folders.map((folder) => (
                  <div key={folder.id} className="group flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/50">
                    <div className="flex items-center gap-2 min-w-0">
                      <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">{folder.name}</span>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeFolder(folder.id)}
                      disabled={deleting[folder.id]}
                      aria-label={`Remove "${folder.name}"`}
                      className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      {deleting[folder.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  No folders added yet. Search and add folders to enable exports.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
