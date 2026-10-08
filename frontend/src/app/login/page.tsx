"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";

export default function LoginPage() {
  const { session, loading, login } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [scoutId, setScoutId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace("/home");
  }, [loading, session, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!scoutId.trim()) return toast("Enter your Scouter ID", "err");
    setBusy(true);
    try {
      const s = await login(scoutId.trim(), password);
      toast(`Welcome, ${s.display_name}!`, "ok");
      router.replace(s.is_admin ? "/admin" : "/home");
    } catch (err: any) {
      toast(err?.message || "Sign in failed", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div className="brand" style={{ justifyContent: "center" }}>
            <span className="name" style={{ fontSize: "1.9rem", fontWeight: 800 }}>
              Haze<b>Hub</b>
            </span>
          </div>
        </div>

        <form className="card" onSubmit={submit}>
          <h2 style={{ marginBottom: 4 }}>Sign in</h2>

          <label className="field">
            <span>Scouter ID</span>
              <input
                value={scoutId}
                onChange={(e) => setScoutId(e.target.value)}
                placeholder=""
                autoCapitalize="none"
                autoComplete="username"
              />
          </label>
          <label className="field">
            <span>Team Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Team password"
              autoComplete="current-password"
            />
          </label>

          <button className="btn primary block" disabled={busy} type="submit">
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
