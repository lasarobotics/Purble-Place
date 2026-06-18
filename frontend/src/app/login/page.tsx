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
            <span className="logo" style={{ width: 48, height: 48 }} />
            <span className="name haze-text" style={{ fontSize: "2rem", fontWeight: 900 }}>
              HazeHub
            </span>
          </div>
          <p style={{ marginTop: 8 }}>FRC scouting · strategy · picklists</p>
        </div>

        <form className="card" onSubmit={submit}>
          <h2 style={{ marginBottom: 4 }}>Sign in</h2>
          <p style={{ marginTop: 0, marginBottom: 18 }}>Use your Scouter ID and the team password.</p>

          <label className="field">
            <span>Scouter ID</span>
              <input
                value={scoutId}
                onChange={(e) => setScoutId(e.target.value)}
                placeholder="Write ID Here"
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
            {busy ? "Signing in…" : "Enter HazeHub →"}
          </button>

          <div className="divider" />
          <p style={{ fontSize: "0.78rem", margin: 0 }} className="faint">
            Demo accounts: <b>1</b>, <b>2</b>, <b>3</b> (scouts) and <b>admin</b>. New IDs are created
            automatically on first sign-in.
          </p>
        </form>
      </div>
    </div>
  );
}
