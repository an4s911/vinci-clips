"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import axios from "axios";
import { CheckCircle, X, XCircle, HardDrive, Loader2 } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export type ExportStatus = "running" | "completed" | "failed" | "partial";

export interface DriveExport {
  id: string;
  folderId: string;
  folderName: string;
  status: ExportStatus;
  total: number;
  completed: number;
  failed: number;
  items?: { status: string; error?: string }[];
}

export interface ExportClip {
  transcriptId: string;
  clipIndex: number;
  videoId: string;
}

interface ToastItem {
  id: string;
  message: string;
  kind: "success" | "error";
}

interface DriveExportsContextValue {
  exports: DriveExport[];
  startExport: (folderId: string, clips: ExportClip[]) => Promise<string>;
  dismissExport: (id: string) => void;
}

const DriveExportsContext = createContext<DriveExportsContextValue | null>(null);

export function useDriveExports() {
  const ctx = useContext(DriveExportsContext);
  if (!ctx) throw new Error("useDriveExports must be used inside DriveExportsProvider");
  return ctx;
}

const TERMINAL: ExportStatus[] = ["completed", "failed", "partial"];

export function DriveExportsProvider({ children }: { children: React.ReactNode }) {
  const [exports, setExports] = useState<DriveExport[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const prevRef = useRef<DriveExport[]>([]);

  const addToast = useCallback((message: string, kind: "success" | "error") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  // Merge a fresh server snapshot with locally-known exports (so a just-started
  // export is not dropped before the next poll surfaces it).
  const mergeExports = useCallback((incoming: DriveExport[]) => {
    setExports((prev) => {
      const map = new Map<string, DriveExport>();
      for (const e of prev) map.set(e.id, e);
      for (const e of incoming) map.set(e.id, e);
      return Array.from(map.values());
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      // Pull active exports + any locally-tracked ones still considered running
      // so terminal transitions are observed for the toast.
      const res = await axios.get(`${API_URL}/clips/google-drive/exports`, {
        params: { status: "active" },
      });
      const active: DriveExport[] = res.data.exports || [];

      // Also refresh locally-known exports that the active query no longer returns
      // (they just went terminal) to capture their final state once.
      const activeIds = new Set(active.map((e) => e.id));
      const justFinished = prevRef.current.filter(
        (e) => e.status === "running" && !activeIds.has(e.id)
      );
      const finals = await Promise.all(
        justFinished.map((e) =>
          axios
            .get(`${API_URL}/clips/google-drive/exports/${e.id}`)
            .then((r) => r.data.export as DriveExport)
            .catch(() => null)
        )
      );

      mergeExports([...active, ...finals.filter(Boolean) as DriveExport[]]);
    } catch {
      /* ignore — not logged in / transient */
    }
  }, [mergeExports]);

  // Poll fast (1.5s) while exports are running; slow (8s) when idle so an export
  // started on another page/tab still surfaces without hammering the server.
  const hasRunning = exports.some((e) => e.status === "running");
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, hasRunning ? 1500 : 8000);
    return () => clearInterval(interval);
  }, [refresh, hasRunning]);

  // Fire toasts on terminal transitions.
  useEffect(() => {
    const prev = prevRef.current;
    for (const exp of exports) {
      const before = prev.find((e) => e.id === exp.id);
      if (before && before.status === "running" && TERMINAL.includes(exp.status)) {
        if (exp.status === "completed") {
          addToast(`Drive export done — ${exp.completed}/${exp.total} to "${exp.folderName}"`, "success");
        } else {
          addToast(
            `Drive export ${exp.status} — ${exp.completed}/${exp.total} (${exp.failed} failed) to "${exp.folderName}"`,
            "error"
          );
        }
      }
    }
    prevRef.current = exports;
  }, [exports, addToast]);

  const startExport = useCallback(
    async (folderId: string, clips: ExportClip[]) => {
      const res = await axios.post(`${API_URL}/clips/google-drive/export`, { folderId, clips });
      const exportId: string = res.data.exportId;
      // Optimistically add so the tray shows it immediately.
      setExports((prev) => [
        ...prev,
        {
          id: exportId,
          folderId,
          folderName: "",
          status: "running",
          total: clips.length,
          completed: 0,
          failed: 0,
        },
      ]);
      refresh();
      return exportId;
    },
    [refresh]
  );

  const dismissExport = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  const trayExports = exports.filter((e) => !dismissed.has(e.id));

  return (
    <DriveExportsContext.Provider value={{ exports, startExport, dismissExport }}>
      {children}

      {/* Exports tray — visible on every page */}
      {trayExports.length > 0 && (
        <div className="fixed bottom-4 left-4 z-[100] flex w-80 flex-col gap-2">
          {trayExports.map((exp) => {
            const pct = exp.total ? Math.round((exp.completed / exp.total) * 100) : 0;
            const done = TERMINAL.includes(exp.status);
            return (
              <div key={exp.id} className="rounded-lg border bg-background px-4 py-3 shadow-lg text-sm">
                <div className="flex items-center gap-2">
                  {done ? (
                    exp.status === "completed" ? (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-600" />
                    )
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate font-medium">
                    {exp.folderName || "Google Drive"}
                  </span>
                  {done && (
                    <button onClick={() => dismissExport(exp.id)} className="opacity-50 hover:opacity-100">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full transition-all ${
                      exp.status === "failed" ? "bg-red-500" : exp.status === "partial" ? "bg-amber-500" : "bg-primary"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>
                    {exp.completed}/{exp.total} uploaded
                  </span>
                  {exp.failed > 0 && <span className="text-red-600">{exp.failed} failed</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg pointer-events-auto bg-background ${
              t.kind === "error" ? "border-red-300 text-red-900" : "border-green-300 text-green-900"
            }`}
          >
            {t.kind === "error" ? (
              <XCircle className="h-4 w-4 flex-shrink-0" />
            ) : (
              <CheckCircle className="h-4 w-4 flex-shrink-0" />
            )}
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="ml-1 opacity-50 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </DriveExportsContext.Provider>
  );
}
