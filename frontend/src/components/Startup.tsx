"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/** Mounted once per app document, never on client-side navigation. */
export function Startup() {
  const [visible, setVisible] = useState(true);
  const [elapsed, setElapsed] = useState(false);
  const { loading, session } = useAuth();
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), 1200);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!elapsed || loading || !visible) return;
    router.replace(session ? "/home" : "/login");
    setVisible(false);
  }, [elapsed, loading, session, router, visible]);
  if (!visible) return null;
  return <div className="startup" role="status" aria-label="Starting Purble Place">
    <img src="/brand/lasa-robotics.png" alt="LASA Robotics" />
    <div className="startup-caption">Purble Place</div>
    <div className="startup-track"><span /></div>
  </div>;
}
