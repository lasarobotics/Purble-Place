"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/** Mounted once per app document, never on client-side navigation. */
export function Startup() {
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);
  const [elapsed, setElapsed] = useState(false);
  const { loading, session } = useAuth();
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), 1400);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!elapsed || loading || !visible) return;
    router.replace(session ? "/home" : "/login");
    setExiting(true);
  }, [elapsed, loading, session, router, visible]);
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setVisible(false), 650);
    return () => clearTimeout(timer);
  }, [exiting]);
  if (!visible) return null;
  return <div className={`startup${exiting ? " startup-exit" : ""}`} role="status" aria-label="Starting Purble Place">
    <img src="/brand/lasa-robotics.png" alt="LASA Robotics" />
    <div className="startup-caption">Purble Place</div>
    <div className="startup-track"><span /></div>
  </div>;
}
