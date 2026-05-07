"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import axios from "axios";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export default function Header({ className }: { className?: string }) {
  const isDark = className?.includes("dark-header");
  const [user, setUser] = useState<{ email: string } | null>(null);

  useEffect(() => {
    axios
      .get(`${API_URL}/clips/auth/me`, { withCredentials: true })
      .then((res) => setUser(res.data.user))
      .catch(() => setUser(null));
  }, []);

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
