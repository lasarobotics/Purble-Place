"use client";
import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useLiveEvents } from "@/lib/ws";
import { emitBus } from "@/lib/bus";
import { flushQueue } from "@/lib/sync";
import { pendingCount, requestPersistentStorage } from "@/lib/db";
import { Loading } from "./ui";
import { Icon } from "./icons";

const MAIN_NAV = [
  { href: "/home", label: "Home" },
  { href: "/scout", label: "Scout" },
  { href: "/prematch", label: "Pre-Match" },
  { href: "/betting", label: "Betting" },
  { href: "/picklists", label: "Picklists" },
];

const UTILITY_NAV = [
  { href: "/status", label: "Status" },
  { href: "/account", label: "Account" },
];

const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/team-search", label: "Team Search" },
  { href: "/admin/team-rank", label: "Team Rank" },
  { href: "/admin/data-picklist", label: "Data Picklist" },
  { href: "/admin/compare", label: "Compare" },
  { href: "/admin/picklists", label: "All Picklists" },
  { href: "/admin/system", label: "System Health" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { session, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  useLiveEvents((event, payload) => emitBus(event, payload));

  // Ask the browser to protect IndexedDB from automatic eviction — queued
  // scouting records must survive restarts (best effort; result on /status).
  useEffect(() => {
    requestPersistentStorage();
  }, []);

  useEffect(() => {
    const upd = () => setOnline(navigator.onLine);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
    };
  }, []);

  // Flush the offline queue when we come online + periodically.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const before = await pendingCount();
      if (before > 0 && navigator.onLine) {
        await flushQueue();
      }
      if (alive) setPending(await pendingCount());
    };
    tick();
    const id = setInterval(tick, 8000);
    window.addEventListener("online", tick);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("online", tick);
    };
  }, [online]);

  if (loading) return <Loading label="Loading…" />;
  if (!session) return <Loading label="Redirecting…" />;

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  const navLink = (n: typeof MAIN_NAV[number]) => (
    <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? "page" : undefined}
      className={"nav-link" + (isActive(n.href) ? " active" : "")}>
      {n.label}
    </Link>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/home" className="brand">
          <span className="name">Haze<b>Hub</b></span>
        </Link>
        <nav aria-label="Primary">{MAIN_NAV.map(navLink)}</nav>
        {session.is_admin && <nav className="strategy-nav" aria-label="Strategy">{ADMIN_NAV.map(navLink)}</nav>}
        <div className="sidebar-foot">
          <nav aria-label="Account">{UTILITY_NAV.map(navLink)}</nav>
          <button className="nav-link signout" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand topbar-brand" style={{ fontSize: "1rem" }}>
            <span className="name" style={{ fontSize: "1rem" }}>Haze<b>Hub</b></span>
          </div>
          <details className="mobile-menu">
            <summary>Menu</summary>
            <nav aria-label="Mobile" onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) e.currentTarget.closest("details")?.removeAttribute("open");
            }}>
              {MAIN_NAV.map(navLink)}
              {session.is_admin && <div className="strategy-nav">{ADMIN_NAV.map(navLink)}</div>}
              <div className="strategy-nav">{UTILITY_NAV.map(navLink)}</div>
              <button className="nav-link signout" onClick={logout}>Sign out</button>
            </nav>
          </details>
          <div className="row" style={{ gap: 10, marginLeft: "auto" }}>
            {pending > 0 && (
              <span className="badge amber" title="Entries waiting to sync">
                <Icon name="refresh" size={12} /> {pending} queued
              </span>
            )}
            <span className="badge muted" title={online ? "Online" : "Offline — saving locally"}>
              <span className={"dot " + (online ? "green" : "red")} /> {online ? "Live" : "Offline"}
            </span>
            <span className="badge haze">{session.bucks} PB</span>
          </div>
        </header>
        {!online && <div className="offline-bar">Offline · saved on device</div>}
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
