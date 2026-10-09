"use client";
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, ApiError, getToken, setToken, clearToken } from "./api";
import type { Session } from "./types";
import { localOwner } from "./identity";

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  login: (scout_id: string, team_password: string, confirmation?: string) => Promise<Session>;
  logout: () => void;
  refresh: () => Promise<void>;
  setBucks: (b: number) => void;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const expired = () => { clearToken(); localStorage.removeItem("hazehub.session"); setSession(null); };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);

  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api<Session>("/api/auth/me");
        setToken(me.token);
        setSession(me);
        localStorage.setItem("hazehub.session", JSON.stringify(me));
      } catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          clearToken();
          localStorage.removeItem("hazehub.session");
        } else {
          try {
            const saved = JSON.parse(localStorage.getItem("hazehub.session") || "null");
            if (saved?.scout_id === localOwner()) setSession(saved);
          } catch {}
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (scout_id: string, team_password: string, confirmation?: string) => {
    const s = await api<Session>(confirmation === undefined ? "/api/auth/login" : "/api/auth/setup", {
      method: "POST",
      auth: false,
      body: confirmation === undefined ? { scout_id, team_password } : { scout_id, password: team_password, password_confirmation: confirmation },
    });
    setToken(s.token);
    setSession(s);
    localStorage.setItem("hazehub.session", JSON.stringify(s));
    return s;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem("hazehub.session");
    setSession(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api<Session>("/api/auth/me");
      setSession(me);
    } catch {}
  }, []);

  const setBucks = useCallback((b: number) => {
    setSession((s) => (s ? { ...s, bucks: b } : s));
  }, []);

  return (
    <Ctx.Provider value={{ session, loading, login, logout, refresh, setBucks }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  return useContext(Ctx);
}
