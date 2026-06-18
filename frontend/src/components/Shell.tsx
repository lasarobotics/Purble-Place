"use client";
import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useLiveEvents } from "@/lib/ws";
import { emitBus } from "@/lib/bus";
import { flushQueue } from "@/lib/sync";
import { pendingCount } from "@/lib/db";
import { Loading } from "./ui";

const MAIN_NAV = [
  { href: "/home", label: "Home", icon: "🏠" },
  { href: "/scout", label: "Scout", icon: "📋" },
  { href: "/prematch", label: "Pre-Match", icon: "🤖" },
  { href: "/film", label: "Film", icon: "🎥" },
  { href: "/betting", label: "Betting", icon: "🎲" },
  { href: "/picklists", label: "Picklists", icon: "📝" },
  { href: "/account", label: "Account", icon: "👤" },
];

const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard", icon: "⚙️" },
  { href: "/admin/team-search", label: "Team Search", icon: "🔎" },
  { href: "/admin/team-rank", label: "Team Rank", icon: "📊" },
  { href: "/admin/data-picklist", label: "Data Picklist", icon: "🧠" },
  { href: "/admin/compare", label: "Compare Robots", icon: "⚖️" },
  { href: "/admin/picklists", label: "All Pick Lists", icon: "🗂️" },
];

const MOBILE_NAV = [
  { href: "/home", label: "Home", icon: "🏠" },
  { href: "/scout", label: "Scout", icon: "📋" },
  { href: "/prematch", label: "Match", icon: "🤖" },
  { href: "/betting", label: "Bets", icon: "🎲" },
  { href: "/picklists", label: "Lists", icon: "📝" },
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

  if (loading) return <Loading label="Connecting to HazeHub…" />;
  if (!session) return <Loading label="Redirecting…" />;

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  const mobileNav = session.is_admin
    ? [...MOBILE_NAV.slice(0, 4), { href: "/admin", label: "Admin", icon: "⚙️" }]
    : MOBILE_NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/home" className="brand">
          <span className="logo" />
          <span className="name">Haze<b>Hub</b></span>
        </Link>
        <div className="nav-section">Scouting</div>
        {MAIN_NAV.map((n) => (
          <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
            <span className="ico">{n.icon}</span> {n.label}
          </Link>
        ))}
        {session.is_admin && (
          <>
            <div className="nav-section">Admin · Strategy</div>
            {ADMIN_NAV.map((n) => (
              <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
                <span className="ico">{n.icon}</span> {n.label}
              </Link>
            ))}
          </>
        )}
        <div className="sidebar-foot">
          <div className="divider" />
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 700 }}>{session.display_name}</div>
              <div className="faint" style={{ fontSize: "0.75rem" }}>
                {session.is_admin ? "Administrator" : "Scout"}
              </div>
            </div>
            <button className="btn sm ghost" onClick={logout}>Sign out</button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand" style={{ fontSize: "1rem" }}>
            <span className="logo" style={{ width: 26, height: 26 }} />
            <span className="name" style={{ fontSize: "1rem" }}>Haze<b>Hub</b></span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {pending > 0 && (
              <span className="badge amber" title="Entries waiting to sync">↻ {pending} queued</span>
            )}
            <span className="badge muted" title={online ? "Online" : "Offline — saving locally"}>
              <span className={"dot " + (online ? "green" : "red")} /> {online ? "Live" : "Offline"}
            </span>
            <span className="badge haze">🟣 {session.bucks} PB</span>
          </div>
        </header>
        {!online && <div className="offline-bar">Offline — your scouting is saved on this device and will sync automatically.</div>}
        <main className="content">{children}</main>
      </div>

      <nav className="bottomnav">
        {mobileNav.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="ico">{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
