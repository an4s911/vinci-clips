"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import axios from "axios";
import { Loader2, CheckCircle, XCircle, X } from "lucide-react";
import { useJobs, type Job } from "@/components/JobsProvider";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

function JobsPopover({ jobs, onClose, onRemove }: { jobs: Job[]; onClose: () => void; onRemove: (id: string) => void }) {
  const grouped = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = j.transcriptId || j.id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(j);
  }

  return (
    <div
      style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 320, background: "#fff", border: "1px solid rgba(0,0,0,0.12)", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", zIndex: 200, padding: "12px 0" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px 8px", borderBottom: "1px solid rgba(0,0,0,0.08)", marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Background Jobs</span>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.5, padding: 2 }}><X size={14} /></button>
      </div>
      {jobs.length === 0 && (
        <div style={{ padding: "12px", fontSize: "0.8rem", color: "rgba(0,0,0,0.4)", textAlign: "center" }}>No active jobs</div>
      )}
      {Array.from(grouped.entries()).map(([key, group]) => (
        <div key={key} style={{ padding: "8px 12px", borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
          {group.map(job => (
            <div key={job.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
              <div style={{ paddingTop: 2, flexShrink: 0 }}>
                {job.status === 'running' && <Loader2 size={13} className="animate-spin" />}
                {job.status === 'completed' && <CheckCircle size={13} style={{ color: "#16a34a" }} />}
                {job.status === 'failed' && <XCircle size={13} style={{ color: "#dc2626" }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {job.transcriptId
                    ? <Link href={`/clips/transcripts/${job.transcriptId}`} onClick={onClose} style={{ color: "inherit", textDecoration: "none" }}>{job.label}</Link>
                    : job.label}
                </div>
                {job.phase && <div style={{ fontSize: "0.72rem", color: "rgba(0,0,0,0.45)", marginTop: 1 }}>{job.phase}</div>}
                {job.progress && (
                  <div style={{ fontSize: "0.72rem", color: "rgba(0,0,0,0.45)", marginTop: 1 }}>
                    {job.progress.done}/{job.progress.total} done
                    <div style={{ marginTop: 3, height: 3, background: "rgba(0,0,0,0.1)", borderRadius: 2 }}>
                      <div style={{ height: "100%", background: job.status === 'failed' ? "#dc2626" : "#21dad2", borderRadius: 2, width: `${(job.progress.done / job.progress.total) * 100}%`, transition: "width 0.3s" }} />
                    </div>
                  </div>
                )}
                {job.status === 'failed' && job.error && (
                  <div style={{ fontSize: "0.7rem", color: "#dc2626", marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{job.error}</div>
                )}
              </div>
              {job.status !== 'running' && (
                <button onClick={() => onRemove(job.id)} style={{ background: "none", border: "none", cursor: "pointer", opacity: 0.35, padding: 2, flexShrink: 0 }}><X size={12} /></button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Header({ className }: { className?: string }) {
  const isDark = className?.includes("dark-header");
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { jobs, removeJob } = useJobs();
  const activeJobs = jobs.filter(j => !j.parentId);
  const runningCount = activeJobs.filter(j => j.status === 'running').length;

  useEffect(() => {
    axios
      .get(`${API_URL}/clips/auth/me`, { withCredentials: true })
      .then((res) => setUser(res.data.user))
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen]);

  async function handleLogout() {
    try {
      await axios.post(`${API_URL}/clips/auth/logout`, {}, { withCredentials: true });
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <header
      className={className}
      style={{
        position: "relative",
        zIndex: 10,
        padding: "0.5rem 2rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: isDark ? "#000000" : "#ffffff",
        borderBottom: isDark
          ? "1px solid rgba(255, 255, 255, 0.1)"
          : "1px solid rgba(0, 0, 0, 0.1)",
        margin: "0 auto",
      }}
    >
      <Link
        href="/"
        aria-label="Go to home"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          textDecoration: "none",
        }}
      >
        <img
          src={isDark ? "/logo.png" : "/logo-name-light.png"}
          alt="Vinci"
          width="100"
          height="32"
        />
        <span
          style={{
            fontSize: "1.5rem",
            color: "#21dad2",
            marginLeft: "0.0rem",
            fontWeight: "950",
          }}
        >
          clips
        </span>
      </Link>
      <nav style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
        {user && (
          <>
            <Link
              href="/clips/transcripts"
              style={{
                color: isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)",
                textDecoration: "none",
                fontSize: "0.875rem",
                fontWeight: 500,
              }}
            >
              Transcripts
            </Link>
            <Link
              href="/clips/settings"
              style={{
                color: isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)",
                textDecoration: "none",
                fontSize: "0.875rem",
                fontWeight: 500,
              }}
            >
              Settings
            </Link>
          </>
        )}

        {/* Background jobs chip */}
        {activeJobs.length > 0 && (
          <div ref={popoverRef} style={{ position: "relative" }}>
            <button
              onClick={() => setPopoverOpen(v => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",
                border: "1px solid",
                borderColor: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)",
                borderRadius: 20,
                padding: "4px 10px",
                cursor: "pointer",
                fontSize: "0.8rem",
                fontWeight: 500,
                color: isDark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.7)",
              }}
              title="Background jobs"
            >
              {runningCount > 0 && <Loader2 size={13} className="animate-spin" style={{ color: "#21dad2" }} />}
              <span>{activeJobs.length} job{activeJobs.length > 1 ? "s" : ""}</span>
            </button>
            {popoverOpen && (
              <JobsPopover
                jobs={activeJobs}
                onClose={() => setPopoverOpen(false)}
                onRemove={id => { removeJob(id); if (activeJobs.filter(j => j.id !== id).length === 0) setPopoverOpen(false); }}
              />
            )}
          </div>
        )}

        {user && (
          <button
            onClick={handleLogout}
            style={{
              background: "transparent",
              color: isDark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)",
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              fontWeight: 500,
              border: "1px solid currentColor",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
            title={`Signed in as ${user.email}`}
          >
            Sign out
          </button>
        )}
      </nav>
    </header>
  );
}
