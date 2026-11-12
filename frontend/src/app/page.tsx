"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function Index() {
  const [elapsed, setElapsed] = useState(false);
  const { loading, session } = useAuth();
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), 1400);
    return () => clearTimeout(timer);
  }, []);
  const exiting = elapsed && !loading;
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => router.replace(session ? "/home" : "/login"), 650);
    return () => clearTimeout(timer);
  }, [exiting, router, session]);
  return <div className={`startup${exiting ? " startup-exit" : ""}`} role="status" aria-label="Starting Purble Place">
    <img src="/brand/lasa-robotics.png" alt="LASA Robotics" />
    <div className="startup-caption">Purble Place</div>
    <div className="startup-track"><span /></div>
  </div>;
}
