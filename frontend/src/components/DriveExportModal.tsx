"use client";

import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { Loader2, Search, HardDrive, UploadCloud } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDriveExports, ExportClip } from "@/components/DriveExportsProvider";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

interface SavedFolder {
  id: string;
  driveFolderId: string;
  name: string;
}

interface AuthStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
}

export default function DriveExportModal({
  open,
  onOpenChange,
  clips,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clips: ExportClip[];
}) {
  const { startExport } = useDriveExports();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [folders, setFolders] = useState<SavedFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setSelected(null);
    setFilter("");
    setLoading(true);
    Promise.all([
      axios.get(`${API_URL}/clips/google-drive/auth/status`).then((r) => r.data as AuthStatus),
      axios.get(`${API_URL}/clips/google-drive/folders`).then((r) => (r.data.folders || []) as SavedFolder[]),
    ])
      .then(([s, f]) => {
        setStatus(s);
        setFolders(f);
      })
      .catch(() => setError("Failed to load Google Drive folders."))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders;
  }, [folders, filter]);

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError("");
    try {
      await startExport(selected, clips);
      onOpenChange(false);
    } catch (err) {
      setError(
        axios.isAxiosError<{ error?: string }>(err)
          ? err.response?.data?.error || "Export failed to start."
          : "Export failed to start."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const notReady = status && (!status.configured || !status.connected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" /> Export to Google Drive
          </DialogTitle>
          <DialogDescription>
            {clips.length} clip{clips.length === 1 ? "" : "s"} will be uploaded to the selected folder.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : notReady ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Google Drive is not connected.{" "}
            <Link href="/clips/settings/google-drive" className="text-primary underline" onClick={() => onOpenChange(false)}>
              Connect it in Settings
            </Link>{" "}
            first.
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter folders…"
                className="pl-9"
              />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-lg border divide-y divide-border/50">
              {filtered.length ? (
                filtered.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setSelected(f.driveFolderId)}
                    className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                      selected === f.driveFolderId ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    <HardDrive className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="truncate">{f.name}</span>
                  </button>
                ))
              ) : (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {folders.length === 0 ? "No folders saved. Add some in Settings." : "No match."}
                </div>
              )}
            </div>
          </>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !selected || !!notReady}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UploadCloud className="h-4 w-4 mr-2" />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
