"use client";

import { useEffect } from "react";
import axios from "axios";

// Set synchronously at module load — before any component effects fire
axios.defaults.withCredentials = true;

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const interceptorId = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          const currentPath = window.location.pathname;
          if (currentPath !== "/login") {
            window.location.href = "/login";
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.response.eject(interceptorId);
    };
  }, []);

  return <>{children}</>;
}
