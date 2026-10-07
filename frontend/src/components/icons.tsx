"use client";
import React from "react";

/**
 * Minimal inline icon set (24×24 stroke outlines, lucide-style).
 * Dependency-free so the bundle stays small and the look stays consistent.
 */
const P = (d: string, i: number) => <path key={i} d={d} />;

const ICONS: Record<string, React.ReactNode> = {
  home: [
    P("M3 10.5 12 3l9 7.5", 0),
    P("M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5", 1),
  ],
  clipboard: [
    <rect key="r" x="8" y="2" width="8" height="4" rx="1" />,
    P("M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", 0),
    P("M9 11h6M9 16h4", 1),
  ],
  bot: [
    <rect key="r" x="4" y="8" width="16" height="12" rx="2" />,
    P("M12 8V4M8 4h8", 0),
    P("M2 14h2M20 14h2M9 13v2M15 13v2", 1),
  ],
  film: [
    <rect key="r" x="2" y="4" width="20" height="16" rx="2" />,
    P("M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5", 0),
  ],
  coins: [
    <circle key="c" cx="8" cy="8" r="5.5" />,
    P("M17.4 9.4a5.5 5.5 0 1 1-8 8", 0),
    P("M7 6.5h1v3.5", 1),
  ],
  list: [
    P("M9 6h12M9 12h12M9 18h12", 0),
    P("M4 6h.01M4 12h.01M4 18h.01", 1),
  ],
  // Grid of squares: "show me everything", for the mobile all-tabs sheet.
  menu: [
    <rect key="a" x="3" y="3" width="7" height="7" rx="1.6" />,
    <rect key="b" x="14" y="3" width="7" height="7" rx="1.6" />,
    <rect key="c" x="3" y="14" width="7" height="7" rx="1.6" />,
    <rect key="d" x="14" y="14" width="7" height="7" rx="1.6" />,
  ],
  user: [
    <circle key="c" cx="12" cy="7.5" r="3.5" />,
    P("M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3A5.5 5.5 0 0 1 19 19.5V21", 0),
  ],
  sliders: [
    P("M21 5h-8M9 5H3M21 12h-5M12 12H3M21 19h-11M6 19H3", 0),
    P("M11 3v4M14 10v4M8 17v4", 1),
  ],
  search: [
    <circle key="c" cx="11" cy="11" r="7.5" />,
    P("m21 21-4.5-4.5", 0),
  ],
  chart: [
    P("M3 3v18h18", 0),
    P("M8 17v-4M13 17V7M18 17v-7", 1),
  ],
  trend: [
    P("m3 17 6-6 4 4 8-8", 0),
    P("M15 7h6v6", 1),
  ],
  scale: [
    P("M12 3v18M7 21h10", 0),
    P("M4 7h16", 1),
    P("m6 7-2.5 6a3 3 0 0 0 5 0L6 7ZM18 7l-2.5 6a3 3 0 0 0 5 0L18 7Z", 2),
  ],
  folder: [
    P("M3 7V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z", 0),
  ],
  inbox: [
    P("M22 13h-5.5l-2 3h-5l-2-3H2", 0),
    P("M5.4 6.1 2 13v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-3.4-6.9A2 2 0 0 0 16.8 5H7.2a2 2 0 0 0-1.8 1.1Z", 1),
  ],
  map: [
    P("M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z", 0),
    P("M9 4v13M15 6.5v13", 1),
  ],
  clock: [
    <circle key="c" cx="12" cy="12" r="9" />,
    P("M12 7v5l3.5 2", 0),
  ],
  trophy: [
    P("M8 21h8M12 17v4", 0),
    P("M7 4h10v6a5 5 0 0 1-10 0V4Z", 1),
    P("M7 5H4.5a1.5 1.5 0 0 0 0 3H7M17 5h2.5a1.5 1.5 0 0 1 0 3H17", 2),
  ],
  camera: [
    P("M14.5 5h-5L8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-1.5-2Z", 0),
    <circle key="c" cx="12" cy="13" r="3.2" />,
  ],
  calendar: [
    <rect key="r" x="3" y="5" width="18" height="16" rx="2" />,
    P("M8 3v4M16 3v4M3 10h18", 0),
  ],
  tv: [
    <rect key="r" x="2" y="4" width="20" height="13" rx="2" />,
    P("M8 21h8M12 17v4", 0),
  ],
  dice: [
    <rect key="r" x="3" y="3" width="18" height="18" rx="3" />,
    P("M8.5 8.5h.01M15.5 8.5h.01M8.5 15.5h.01M15.5 15.5h.01M12 12h.01", 0),
  ],
  refresh: [
    P("M20 12a8 8 0 1 1-2.34-5.66", 0),
    P("M20 3v4h-4", 1),
  ],
  logout: [
    P("M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3", 0),
    P("m15 16 4-4-4-4M19 12H9", 1),
  ],
  circle: [<circle key="c" cx="12" cy="12" r="9" />],
  battery: [
    <rect key="r" x="2" y="7" width="17" height="10" rx="2.5" />,
    P("M21.5 10.5v3", 0),
  ],
  wrench: [
    P("M15.5 3.5a5 5 0 0 0-6 6.4L3 16.4V21h4.6l6.5-6.5a5 5 0 0 0 6.4-6.1l-3 3-2.9-2.9 3-3Z", 0),
  ],
  sparkles: [
    P("M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z", 0),
    P("M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z", 1),
  ],
  radar: [
    <circle key="c1" cx="12" cy="12" r="9" />,
    <circle key="c2" cx="12" cy="12" r="4.5" />,
    P("M12 12l6-6.5", 0),
    P("M12 12h.01", 1),
  ],
};

// Legacy call sites pass emoji or loose names, map them onto real icons.
const ALIASES: Record<string, string> = {
  "🏠": "home", "📋": "clipboard", "🤖": "bot", "🎥": "film", "🎬": "film",
  "🎲": "dice", "📝": "list", "👤": "user", "⚙️": "sliders", "🔎": "search",
  "📊": "chart", "🧠": "trend", "⚖️": "scale", "🗂️": "folder", "✨": "inbox",
  "📭": "inbox", "🗺️": "map", "⏱️": "clock", "🏆": "trophy", "📷": "camera",
  "🗓️": "calendar", "📺": "tv", "list": "list", "List": "list",
};

export function iconName(nameOrEmoji: string | undefined): string {
  if (!nameOrEmoji) return "inbox";
  if (ICONS[nameOrEmoji]) return nameOrEmoji;
  const lower = nameOrEmoji.toLowerCase();
  if (ICONS[lower]) return lower;
  return ALIASES[nameOrEmoji] || "inbox";
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.9,
  className,
  style,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {ICONS[iconName(name)]}
    </svg>
  );
}
