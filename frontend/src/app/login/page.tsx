"use client";

import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import axios from "axios";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await axios.post(
        `${API_URL}/clips/auth/login`,
        { email, password },
        { withCredentials: true }
      );
      const from = searchParams.get("from") || "/upload";
      router.push(from);
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Login failed. Check your credentials.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <label style={{ display: "block", fontSize: "0.875rem", color: "#aaa", marginBottom: "0.375rem" }}>
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          style={{
            width: "100%",
            padding: "0.625rem 0.75rem",
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "8px",
            color: "#fff",
            fontSize: "0.9375rem",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      <div>
        <label style={{ display: "block", fontSize: "0.875rem", color: "#aaa", marginBottom: "0.375rem" }}>
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          style={{
            width: "100%",
            padding: "0.625rem 0.75rem",
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "8px",
            color: "#fff",
            fontSize: "0.9375rem",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {error && (
        <p style={{ color: "#f87171", fontSize: "0.875rem", margin: 0 }}>{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        style={{
          background: loading ? "#0d6e69" : "linear-gradient(135deg, #14b8a6, #0d9488)",
          color: "#fff",
          padding: "0.625rem 1rem",
          borderRadius: "8px",
          border: "none",
          fontWeight: 600,
          fontSize: "0.9375rem",
          cursor: loading ? "not-allowed" : "pointer",
          transition: "all 0.2s ease",
        }}
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          padding: "2rem",
          background: "#141414",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <div style={{ marginBottom: "2rem", textAlign: "center" }}>
          <img src="/logo.png" alt="Sleeck" width="100" height="32" style={{ display: "inline-block" }} />
          <span
            style={{
              fontSize: "1.5rem",
              color: "#21dad2",
              marginLeft: "0.25rem",
              fontWeight: 950,
              verticalAlign: "middle",
            }}
          >
            clips
          </span>
        </div>

        <h1
          style={{
            fontSize: "1.25rem",
            fontWeight: 600,
            color: "#fff",
            marginBottom: "1.5rem",
            textAlign: "center",
          }}
        >
          Sign in
        </h1>

        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
