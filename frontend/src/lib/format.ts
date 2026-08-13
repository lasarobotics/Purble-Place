export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "-";
  return `${(v * 100).toFixed(digits)}%`;
}

export function num(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "-";
  return v.toFixed(digits);
}

export function matchLabel(comp: string, n: number): string {
  const map: Record<string, string> = { qm: "Qual", sf: "Playoff", f: "Final", qf: "QF", ef: "EF" };
  return `${map[comp] || comp.toUpperCase()} ${n}`;
}

// Extract a YouTube video id from a url or raw id.
export function youtubeId(input: string): string {
  if (!input) return "";
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : "";
}

// Return the iframe-ready embed URL used by the Film tab.
export function youtubeEmbedUrl(input: string): string {
  const id = youtubeId(input);
  return id ? `https://www.youtube.com/embed/${id}` : "";
}

export function rankClass(rank: number): string {
  if (rank === 1) return "rank-chip gold";
  if (rank === 2) return "rank-chip silver";
  if (rank === 3) return "rank-chip bronze";
  return "rank-chip";
}

export function avatarFor(t: { avatar?: string; team_number: number }): string {
  if (t.avatar) return t.avatar;
  // Neutral placeholder data URI keyed by team number color.
  return "";
}

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
