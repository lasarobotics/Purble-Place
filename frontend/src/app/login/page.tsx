"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui";

export default function LoginPage() {
  const { session, loading, login } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [scoutId, setScoutId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkedId, setCheckedId] = useState("");
  const [setupId, setSetupId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupError, setSetupError] = useState("");

  useEffect(() => {
    if (!loading && session) router.replace("/home");
  }, [loading, session, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!scoutId.trim()) return toast("Enter your Scouter ID", "err");
    setBusy(true);
    try {
      if (checkedId !== scoutId.trim()) {
        const status = await api<{ needs_setup: boolean }>("/api/auth/account-status", {
          method: "POST", auth: false, body: { scout_id: scoutId.trim() },
        });
        if (status.needs_setup) {
          setSetupId(scoutId.trim());
          setNewPassword(""); setConfirmation(""); setSetupError("");
        } else {
          setCheckedId(scoutId.trim());
        }
        return;
      }
      const s = await login(scoutId.trim(), password);
      toast(`Welcome, ${s.display_name}!`, "ok");
      router.replace(s.is_admin ? "/admin" : "/home");
    } catch (err: any) {
      toast(err?.message || "Sign in failed", "err");
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmation) { setSetupError("Passwords do not match."); return; }
    setBusy(true); setSetupError("");
    try {
      await login(setupId, newPassword, confirmation);
      setNewPassword(""); setConfirmation(""); setSetupId("");
      toast("Account created", "ok");
      router.replace("/home");
    } catch (err: any) {
      setSetupError(err?.message || "Could not create account.");
    } finally { setBusy(false); }
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
                onChange={(e) => { setScoutId(e.target.value); setCheckedId(""); setPassword(""); }}
                placeholder=""
                autoCapitalize="none"
                autoComplete="username"
              />
          </label>
          {checkedId === scoutId.trim() && checkedId && <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>}

          <button className="btn primary block" disabled={busy} type="submit">
            {busy ? "Please wait..." : checkedId ? "Sign in" : "Continue"}
          </button>
        </form>
      </div>
      {setupId && <Modal onClose={() => { if (!busy) { setSetupId(""); setNewPassword(""); setConfirmation(""); } }}>
        <form onSubmit={createAccount} role="dialog" aria-modal="true" aria-labelledby="setup-title">
          <h2 id="setup-title">Create your account</h2>
          <p>Scouter ID: {setupId}</p>
          <p><strong>THIS SHOULD NOT BE A PASSWORD YOU USE NORMALLY AS WE CAN ACCESS THIS.</strong></p>
          <p>Use a unique password for HazeHub. Administrators manage this system and its account data. Passwords are stored as secure hashes, not readable text.</p>
          <label className="field"><span>Create password</span>
            <input autoFocus type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
          </label>
          <label className="field"><span>Retype password</span>
            <input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={e => setConfirmation(e.target.value)} />
          </label>
          <p className="faint">Use 8–128 characters.</p>
          {setupError && <p role="alert">{setupError}</p>}
          <div className="row">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => { setSetupId(""); setNewPassword(""); setConfirmation(""); }}>Cancel</button>
            <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating..." : "Create account"}</button>
          </div>
        </form>
      </Modal>}
    </div>
  );
}
