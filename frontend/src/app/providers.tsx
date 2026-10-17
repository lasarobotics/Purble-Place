"use client";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/lib/toast";
import { useOffline } from "@/lib/offline";

function OfflineBootstrap() {
  useOffline();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider><OfflineBootstrap />{children}</ToastProvider>
    </AuthProvider>
  );
}
