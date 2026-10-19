"use client";
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, ApiError, setToken, clearToken } from "./api";
import type { Session } from "./types";
import { provisionOffline, revokeOffline, unlockOffline, restoreOfflineSession, endOfflineSession } from "./offline-auth";
import { offlineSession, setOfflineSession } from "./offline-session";
import { localOwner } from "./identity";
import { db } from "./db";

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
  const generation = useRef(0);

  useEffect(() => {
    const expired = () => {
      const owner = localOwner();
      if (owner) void revokeOffline(owner).catch(() => {});
      clearToken(); localStorage.removeItem("hazehub.session"); setSession(null);
    };
    window.addEventListener("auth-expired", expired);
    const restored = (event: Event) => setSession((event as CustomEvent<Session>).detail);
    window.addEventListener("auth-restored", restored);
    return () => { window.removeEventListener("auth-expired", expired); window.removeEventListener("auth-restored", restored); };
  }, []);

  useEffect(() => {
    // Remove identity responses cached by older releases; they contain tokens.
    void db().responses.filter(row => row.key.includes("|/api/auth/")).delete().catch(() => {});
    (async () => {
      const started = generation.current;
      if (sessionStorage.getItem("hazehub.offline-reauth") === "1") {
        const restored = await restoreOfflineSession();
        if (started !== generation.current) return;
        if (restored) { setOfflineSession(restored); setSession(restored); }
        setLoading(false);
        return;
      }
      try {
        const me = await api<Session>("/api/auth/me");
        if (started !== generation.current) return;
        setToken(me.token);
        if (me.is_admin || me.picklist_only) await revokeOffline(me.scout_id).catch(() => {});
        setSession(me);
      } catch (error) {
        if (started !== generation.current) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          clearToken();
          localStorage.removeItem("hazehub.session");
        } else { clearToken(); localStorage.removeItem("hazehub.session"); }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (scout_id: string, team_password: string, confirmation?: string) => {
    generation.current++;
    let s: Session;
    try {
      s = await api<Session>(confirmation === undefined ? "/api/auth/login" : "/api/auth/setup", {
      method: "POST",
      auth: false,
      body: confirmation === undefined ? { scout_id, team_password } : { scout_id, password: team_password, password_confirmation: confirmation },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        if ([401, 403].includes(error.status)) await revokeOffline(scout_id);
        throw error;
      }
      if (confirmation !== undefined) throw new Error("Initial password setup requires an online connection.");
      s = await unlockOffline(scout_id, team_password);
      clearToken();
      localStorage.removeItem("hazehub.session");
      setOfflineSession(s);
      sessionStorage.setItem("hazehub.offline-reauth", "1");
      setSession(s);
      return s;
    }
    setOfflineSession(null);
    await endOfflineSession().catch(() => {});
    sessionStorage.removeItem("hazehub.offline-reauth");
    setToken(s.token);
    await db().pendingScouts.where("owner_id").equals(s.scout_id).filter(row => row.sync_status === "auth_required")
      .modify({ sync_status: "queued", next_attempt_at: null }).catch(() => {});
    if (!s.is_admin && !s.picklist_only) {
      try {
        const grant = await api<any>("/api/auth/offline-provision", { method: "POST", body: { scout_id: s.scout_id, team_password } });
        await provisionOffline(grant, team_password);
      } catch {
        window.dispatchEvent(new CustomEvent("offline-provision-failed"));
      }
    } else { await revokeOffline(s.scout_id).catch(() => {}); }
    setSession(s);
    return s;
  }, []);

  const logout = useCallback(() => {
    generation.current++;
    // Local sign-out must remain effective even if clearing the cookie fails offline.
    sessionStorage.setItem("hazehub.offline-reauth", "1");
    void api("/api/auth/logout", { method: "POST", auth: false }).catch(() => {});
    setOfflineSession(null);
    void endOfflineSession().catch(() => {});
    clearToken();
    localStorage.removeItem("hazehub.session");
    setSession(null);
  }, []);

  useEffect(() => {
    if (!session?.offline_until) return;
    const timer = window.setTimeout(logout, Math.max(0, session.offline_until - Date.now()));
    const revoked = (id: string | null) => {
      if (offlineSession() && (!id || id === session.scout_id.toLowerCase())) {
        generation.current++;
        sessionStorage.setItem("hazehub.offline-reauth", "1");
        void endOfflineSession().catch(() => {});
        setOfflineSession(null); clearToken(); setSession(null);
      }
    };
    const localRevoked = (e: Event) => revoked((e as CustomEvent).detail);
    window.addEventListener("offline-revoked", localRevoked);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hazehub-offline-revoked") : null;
    if (channel) channel.onmessage = e => revoked(e.data);
    return () => { window.clearTimeout(timer); window.removeEventListener("offline-revoked", localRevoked); channel?.close(); };
  }, [session?.offline_until, logout]);

  const refresh = useCallback(async () => {
    if (offlineSession()) return;
    const started = generation.current;
    try {
      const me = await api<Session>("/api/auth/me");
      if (started !== generation.current) return;
      setToken(me.token);
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
