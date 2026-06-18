"use client";
import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, getToken, setToken, clearToken } from "./api";
import type { Session } from "./types";

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  login: (scout_id: string, team_password: string) => Promise<Session>;
  logout: () => void;
  refresh: () => Promise<void>;
  setBucks: (b: number) => void;
}

const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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
      } catch {
        clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (scout_id: string, team_password: string) => {
    const s = await api<Session>("/api/auth/login", {
      method: "POST",
      auth: false,
      body: { scout_id, team_password },
    });
    setToken(s.token);
    setSession(s);
    return s;
  }, []);

  const logout = useCallback(() => {
    clearToken();
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
