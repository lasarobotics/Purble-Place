"use client";
import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useLiveEvents } from "@/lib/ws";
import { api } from "@/lib/api";
import { loadSchedule } from "@/lib/schedule";
import { emitBus, onBus, DATA_EVENTS } from "@/lib/bus";
import { flushQueue } from "@/lib/sync";
import { pendingCount, requestPersistentStorage } from "@/lib/db";
import { useBattery } from "@/lib/battery";
import { useOffline } from "@/lib/offline";
import { Loading } from "./ui";
import { Icon } from "./icons";
import { ROLE_LABEL } from "@/lib/types";

// Betting is not in here on purpose: it lives on the scouting page now, next
// to the match it is about, rather than behind a tab of its own.
interface NavItem { href: string; label: string; icon: string }

const MAIN_NAV: NavItem[] = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/scout", label: "Scout", icon: "clipboard" },
  { href: "/pit", label: "Pit Scout", icon: "wrench" },
  { href: "/picklists", label: "Picklists", icon: "list" },
  { href: "/meeting", label: "Picklist Meeting Mode", icon: "folder" },
  { href: "/status", label: "Devices", icon: "refresh" },
  { href: "/account", label: "Account", icon: "user" },
];

// The picklist meeting account reaches exactly two screens. Everything else
// is hidden here and refused by the server, so a mis-tap on a shared screen
// cannot advance the match or settle bets.
const PICKLIST_NAV = [
  { href: "/meeting", label: "Picklist Meeting", icon: "folder" },
  { href: "/account", label: "Account", icon: "user" },
];

// Admin navigation groups event operations, analysis and picklists.
const ADMIN_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Event",
    items: [
      { href: "/admin", label: "Dashboard", icon: "sliders" },
      { href: "/admin/system", label: "System Health", icon: "refresh" },
    ],
  },
  {
    title: "Analysis",
    items: [
      { href: "/admin/team-search", label: "Team Search", icon: "search" },
      { href: "/admin/team-rank", label: "Team Rank", icon: "chart" },
      { href: "/admin/compare", label: "Compare", icon: "scale" },
    ],
  },
  {
    title: "Picklists",
    items: [
      { href: "/meeting", label: "Picklist Meeting", icon: "folder" },
      { href: "/admin/picklists", label: "All Picklists", icon: "folder" },
      { href: "/admin/data-picklist", label: "Data Picklist", icon: "trend" },
    ],
  },
];

const MOBILE_NAV = [
  { href: "/home", label: "Home", icon: "home" },
  { href: "/scout", label: "Scout", icon: "clipboard" },
  { href: "/pit", label: "Pit", icon: "wrench" },
  { href: "/picklists", label: "Picks", icon: "list" },
  { href: "/status", label: "Devices", icon: "refresh" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { session, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const battery = useBattery();
  // Registers the service worker that keeps the app loadable with no signal.
  const offline = useOffline();

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

  const restrictedPage = pathname.replace(/\/$/, "") === "/admin" || pathname.startsWith("/admin/system");
  useEffect(() => {
    if (session && !session.is_admin && restrictedPage) router.replace("/home");
  }, [session, restrictedPage, router]);

  useLiveEvents((event, payload) => emitBus(event, payload));
  useEffect(() => {
    if (!session) return;
    const warm = () => {
      if (!navigator.onLine) return;
      void loadSchedule().catch(() => {});
      void api("/api/admin/event-teams").catch(() => {});
    };
    warm();
    navigator.serviceWorker?.ready.then(reg => reg.active?.postMessage({type: "WARM_ROUTES", routes:
      [...MAIN_NAV.map(n => n.href), "/login", ...ADMIN_GROUPS.filter(g => session.is_admin || g.title !== "Event").flatMap(g => g.items.map(n => n.href))]}));
    let timer: ReturnType<typeof setTimeout>;
    const off = onBus(event => { if (DATA_EVENTS.includes(event)) { clearTimeout(timer); timer = setTimeout(warm, 250); } });
    window.addEventListener("online", warm);
    return () => {off(); clearTimeout(timer); window.removeEventListener("online", warm);};
  }, [session]);

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
    const changed = () => { void pendingCount().then(n => { if (alive) setPending(n); }); };
    window.addEventListener("scout-queue-changed", changed);
    const id = setInterval(tick, 8000);
    window.addEventListener("online", tick);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("scout-queue-changed", changed);
      window.removeEventListener("online", tick);
    };
  }, [online]);

  if (loading) return <Loading label="Connecting to HazeHub..." />;
  if (!session) return <Loading label="Redirecting..." />;

  if (!session.is_admin && restrictedPage) return <Loading label="Redirecting..." />;
  const visibleGroups = ADMIN_GROUPS.filter(g => session.is_admin || g.title !== "Event");

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
  const picklistOnly = session.picklist_only;
  const mainNav = picklistOnly ? PICKLIST_NAV : MAIN_NAV;
  // The sheet shows everything the account can actually reach, so it is built
  // from the same lists the sidebar uses rather than a second hand-kept copy.
  const sheetGroups = picklistOnly
    ? [{ title: "Picklist Meeting", items: PICKLIST_NAV }]
    : [{ title: "Scouting", items: MAIN_NAV }, ...visibleGroups];
  const mobileNav = picklistOnly
    ? PICKLIST_NAV
    : session.is_admin
      ? [...MOBILE_NAV.slice(0, 4), { href: "/admin", label: "Admin", icon: "sliders" }]
      : MOBILE_NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/home" className="brand">
          <span className="name">Haze<b>Hub</b></span>
        </Link>
        <div className="nav-section">{picklistOnly ? "Picklist Meeting" : "Scouting"}</div>
        {mainNav.map((n) => (
          <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
            <span className="ico"><Icon name={n.icon} /></span> {n.label}
          </Link>
        ))}
        {visibleGroups.map((group) => (
            <div key={group.title}>
              <div className="nav-section">{group.title}</div>
              {group.items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={"nav-link" + (isActive(n.href) ? " active" : "")}
                >
                  <span className="ico"><Icon name={n.icon} /></span> {n.label}
                </Link>
              ))}
            </div>
          ))}
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
              {sheetGroups.flatMap((group) => group.items).map((n) => (
                <Link key={n.href} href={n.href} className={"nav-link" + (isActive(n.href) ? " active" : "")}>
                  {n.label}
                </Link>
              ))}
              <button className="nav-link signout" onClick={logout}>Sign out</button>
            </nav>
          </details>
          <div className="row" style={{ gap: 10, marginLeft: "auto" }}>
            {pending > 0 && (
              <span className="badge amber" title="Entries waiting to sync">
                <Icon name="refresh" size={12} /> {pending} queued
              </span>
            )}
            <span
              className="badge muted"
              title={
                online
                  ? "Connected"
                  : offline.ready
                    ? "No connection. The app is running from the copy on this device and your scouting is queued."
                    : "No connection. Your scouting is queued on this device."
              }
            >
              <span className={"dot " + (online ? "green" : "red")} /> {online ? "Live" : "Offline"}
            </span>
            {/* A flat battery is what actually ends a scout's day, so the
                level sits next to the thing they already glance at. Absent
                entirely on browsers without the Battery Status API rather
                than showing a guess. */}
            {battery && (
              <span
                className={"badge battery" + (battery.percent <= 20 && !battery.charging ? " low" : "")}
                title={battery.charging ? "Charging" : "On battery"}
              >
                <Icon name={battery.charging ? "sparkles" : "battery"} size={12} />
                {battery.percent}%
              </span>
            )}
            <span className="badge haze">{session.bucks} PB</span>
          </div>
        </header>
        {!online && (
          <div className="offline-bar">
            Offline · Saved on this device
          </div>
        )}
        <main className="content">{children}</main>
      </div>

      <nav className="bottomnav">
        {mobileNav.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? "active" : ""}>
            <span className="ico"><Icon name={n.icon} size={20} /></span>
            {n.label}
          </Link>
        ))}
        {/* Five tabs fit across a phone; an admin has thirteen screens. The
            rest were simply unreachable on mobile before this. */}
        <button
          type="button"
          className={"more-tab" + (menuOpen ? " active" : "")}
          onClick={() => setMenuOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
        >
          <span className="ico"><Icon name="menu" size={20} /></span>
          All tabs
        </button>
      </nav>

      {menuOpen && (
        <NavSheet
          groups={sheetGroups}
          isActive={isActive}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Full-screen tab picker for phones.
 *
 * Rendered as a sheet rather than a scrolling tab strip because a strip you
 * have to swipe hides exactly the thing you are looking for, and people are
 * doing this one-handed in the stands between matches.
 */
function NavSheet({
  groups,
  isActive,
  onClose,
}: {
  groups: { title: string; items: NavItem[] }[];
  isActive: (href: string) => boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="nav-sheet-back" onClick={onClose} role="dialog" aria-label="All tabs">
      <div className="nav-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="nav-sheet-head">
          <h2>All tabs</h2>
          <button className="btn sm ghost" onClick={onClose}>Close</button>
        </div>
        <div className="nav-sheet-body">
          {groups.map((g) => (
            <section key={g.title}>
              <div className="nav-section">{g.title}</div>
              <div className="nav-sheet-grid">
                {g.items.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    onClick={onClose}
                    className={"nav-sheet-item" + (isActive(n.href) ? " active" : "")}
                  >
                    <span className="ico"><Icon name={n.icon} size={22} /></span>
                    <span>{n.label}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
