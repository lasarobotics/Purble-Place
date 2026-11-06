"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Loading } from "@/components/ui";

export default function Index() {
  const { session, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    router.replace(session ? "/home" : "/login");
  }, [loading, session, router]);
  return <Loading label="Starting Purble Place..." />;
}
