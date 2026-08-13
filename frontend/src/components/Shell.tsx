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
import { ROLE_LABEL } from "@/lib/types";

const MAIN_NAV = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/scout", label: "Scout", icon: "clipboard" },
  { href: "/prematch", label: "Pre-Match", icon: "bot" },
  { href: "/betting", label: "Betting", icon: "coins" },
  { href: "/picklists", label: "Picklists", icon: "list" },
  { href: "/status", label: "Device Status", icon: "refresh" },
  { href: "/account", label: "Account", icon: "user" },
];

// The picklist meeting account reaches exactly two screens. Everything else
// is hidden here and refused by the server, so a mis-tap on a shared screen
// cannot advance the match or settle bets.
const PICKLIST_NAV = [
  { href: "/meeting", label: "Picklist Meeting", icon: "folder" },
  { href: "/account", label: "Account", icon: "user" },
];

const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard", icon: "sliders" },
  { href: "/admin/team-search", label: "Team Search", icon: "search" },
  { href: "/admin/team-rank", label: "Team Rank", icon: "chart" },
  { href: "/admin/data-picklist", label: "Data Picklist", icon: "trend" },
  { href: "/admin/compare", label: "Compare Robots", icon: "scale" },
  { href: "/admin/consensus", label: "Consensus Radar", icon: "radar" },
  // Film review is a strategy tool, not something a scout needs mid-match.
  { href: "/film", label: "Film Review", icon: "film" },
  { href: "/meeting", label: "Picklist Meeting", icon: "folder" },
  { href: "/admin/picklists", label: "All Pick Lists", icon: "folder" },
  { href: "/admin/system", label: "System Health", icon: "refresh" },
];

const MOBILE_NAV = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/scout", label: "Scout", icon: "clipboard" },
  { href: "/prematch", label: "Match", icon: "bot" },
  { href: "/picklists", label: "Picks", icon: "list" },
  { href: "/betting", label: "Bets", icon: "coins" },
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

  // Keep a picklist meeting account inside the two screens it is for. The
  // server rejects the rest anyway; this stops the account from landing on a
  // page of permission errors.
  useEffect(() => {
    if (!session?.picklist_only) return;
    const allowed = ["/meeting", "/account"];
    if (!allowed.some((prefix) => pathname.startsWith(prefix))) router.replace("/meeting");
  }, [session, pathname, router]);

  useLiveEvents((event, payload) => emitBus(event, payload));

  // Ask the browser to protect IndexedDB from automatic eviction, queued
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

  if (loading) return <Loading label="Connecting to HazeHub…" />;
  if (!session) return <Loading label="Redirecting…" />;

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  const picklistOnly = session.picklist_only;
  const mainNav = picklistOnly ? PICKLIST_NAV : MAIN_NAV;
  const mobileNav = picklistOnly
    ? PICKLIST_NAV
    : session.is_admin
      ? [...MOBILE_NAV.slice(0, 4), { href: "/admin", label: "Admin", icon: "sliders" }]
      : MOBILE_NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/home" className="brand">
          <span className="logo" />
          <span className="name">Haze<b>Hub</b></span>
        </Link>
        <div className="nav-section">{picklistOnly ? "Picklist Meeting" : "Scouting"}</div>
        {mainNav.map((n) => (
          <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
            <span className="ico"><Icon name={n.icon} /></span> {n.label}
          </Link>
        ))}
        {session.is_admin && (
          <>
            <div className="nav-section">Strategy</div>
            {ADMIN_NAV.map((n) => (
              <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
                <span className="ico"><Icon name={n.icon} /></span> {n.label}
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
                {ROLE_LABEL[session.role] || "Scouter"}
              </div>
            </div>
            <button className="btn sm ghost" onClick={logout}>Sign out</button>
          </div>
          <div className="faint" style={{ fontSize: "0.68rem", marginTop: 10, letterSpacing: "0.04em" }}>
            FRC 418 PURPLE HAZE · FRC 436 PURPLE RAIN
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand topbar-brand" style={{ fontSize: "1rem" }}>
            <span className="logo" style={{ width: 26, height: 26 }} />
            <span className="name" style={{ fontSize: "1rem" }}>Haze<b>Hub</b></span>
          </div>
          <div className="row" style={{ gap: 10, marginLeft: "auto" }}>
            {pending > 0 && (
              <span className="badge amber" title="Entries waiting to sync">
                <Icon name="refresh" size={12} /> {pending} queued
              </span>
            )}
            <span className="badge muted" title={online ? "Online" : "Offline, saving locally"}>
              <span className={"dot " + (online ? "green" : "red")} /> {online ? "Live" : "Offline"}
            </span>
            <span className="badge haze">{session.bucks} PB</span>
          </div>
        </header>
        {!online && <div className="offline-bar">Offline, your scouting is saved on this device and will sync automatically.</div>}
        <main className="content">{children}</main>
      </div>

      <nav className="bottomnav">
        {mobileNav.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="ico"><Icon name={n.icon} size={20} /></span>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
