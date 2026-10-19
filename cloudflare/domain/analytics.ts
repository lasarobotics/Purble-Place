/**
 * Scouting-based Haze Power Rating (`avg_points`) and incremental team metrics.
 * Mirrors backend/app/expected_points.py consensus + Bayesian accuracy + endgame priors.
 * Game point tables come from D1 `game_definitions` (not hardcoded season rules).
 */
import { Env, now } from "../shared/core";

type Cat = string; // phase|action|object|location
type Counts = Record<Cat, [number, number]>;
type MatchConsensus = {
  key: string;
  counts: Counts;
  climb: string;
  defense: boolean;
  failed: boolean;
};
type GameDef = {
  accuracy_smoothing_k?: number;
  endgame_none?: string;
  endgame?: Record<string, number>;
  attempt_points?: Record<string, number>;
  rules?: Array<{ when?: Record<string, unknown>; points?: number; per?: string; targets_field?: boolean }>;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mode<T>(values: T[], fallback: T): T {
  if (!values.length) return fallback;
  const tally = new Map<string, { n: number; v: T }>();
  for (const v of values) {
    const k = JSON.stringify(v);
    const cur = tally.get(k);
    if (cur) cur.n += 1;
    else tally.set(k, { n: 1, v });
  }
  let best = { n: 0, v: fallback };
  for (const item of tally.values()) if (item.n > best.n) best = item;
  return best.v;
}

function catKey(a: Record<string, unknown>): Cat {
  return `${a.phase || "teleop"}|${a.action || "score"}|${a.object || ""}|${a.location || ""}`;
}

function records(payload: any): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const a of payload.actions || []) if (a && typeof a === "object") out.push({ ...a });
  for (const p of payload.heatmap || []) {
    if (!p || typeof p !== "object") continue;
    out.push({ ...p, action: p.action || "score", result: p.result || "made" });
  }
  return out;
}

function consensus(reports: any[]): MatchConsensus[] {
  const groups = new Map<string, any[]>();
  for (const r of reports) {
    const key = `${r.comp_level || "qm"}|${r.match_number}|${r.team}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }
  const out: MatchConsensus[] = [];
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const payloads = group.map((g) => (typeof g.payload === "string" ? JSON.parse(g.payload) : g.payload));
    const allCats = new Set<Cat>();
    for (const p of payloads) for (const a of records(p)) allCats.add(catKey(a));
    const categoryCounts: Record<Cat, [number, number][]> = {};
    for (const cat of allCats) {
      categoryCounts[cat] = [];
      for (const p of payloads) {
        let made = 0, missed = 0;
        for (const a of records(p)) {
          if (catKey(a) !== cat) continue;
          const qty = Math.max(0, Number(a.quantity ?? 1));
          if ((a.result || "made") === "made") made += qty;
          else missed += qty;
        }
        categoryCounts[cat]!.push([made, missed]);
      }
    }
    for (const [phase, field] of [["auto", "auto_missed"], ["teleop", "teleop_missed"]] as const) {
      const present = payloads.filter((p) => field in p).map((p) => Number(p[field] || 0));
      if (!present.length) continue;
      const cat: Cat = `${phase}|score||`;
      const existing = categoryCounts[cat] || payloads.map(() => [0, 0] as [number, number]);
      const miss = median(present);
      categoryCounts[cat] = existing.map(([m, x]) => [m, x + miss]);
    }
    const counts: Counts = {};
    for (const [cat, vals] of Object.entries(categoryCounts)) {
      counts[cat] = [median(vals.map((v) => v[0])), median(vals.map((v) => v[1]))];
    }
    out.push({
      key,
      counts,
      climb: String(mode(payloads.map((p) => p.climb || "none"), "none")),
      defense: Boolean(mode(payloads.map((p) => Boolean(p.played_defense)), false)),
      failed: Boolean(mode(payloads.map((p) => Boolean(p.failure || p.no_show)), false)),
    });
  }
  return out;
}

function typical(values: number[]): number {
  if (!values.length) return 0;
  const med = median(values);
  if (values.length < 4) return med;
  const recent = values.slice(-3);
  const weighted = recent.reduce((s, v, i) => s + v * (i + 1), 0) / recent.reduce((s, _, i) => s + i + 1, 0);
  return 0.75 * med + 0.25 * weighted;
}

function prepareEvent(matches: MatchConsensus[]) {
  const categories = new Set<Cat>();
  for (const m of matches) for (const c of Object.keys(m.counts)) categories.add(c);
  const totals: Counts = {};
  for (const cat of categories) {
    totals[cat] = [
      matches.reduce((s, m) => s + (m.counts[cat]?.[0] || 0), 0),
      matches.reduce((s, m) => s + (m.counts[cat]?.[1] || 0), 0),
    ];
  }
  const states: Record<string, number> = {};
  for (const m of matches) states[m.climb] = (states[m.climb] || 0) + 1;
  return { totals, states, matches: matches.length };
}

function attemptPoints(cat: Cat, game: GameDef): number {
  const table = game.attempt_points || {};
  if (cat in table) return Math.max(0, Number(table[cat]));
  const [phase] = cat.split("|");
  const fallback = table[`${phase}|score||`];
  if (fallback != null) return Math.max(0, Number(fallback));
  return phase === "auto" ? 4 : 2;
}

export function estimateAvgPoints(teamMatches: MatchConsensus[], eventContext: ReturnType<typeof prepareEvent>, game: GameDef): number | null {
  if (!teamMatches.length) return null;
  const k = Number(game.accuracy_smoothing_k ?? 20);
  const categories = new Set<Cat>();
  for (const m of teamMatches) for (const c of Object.keys(m.counts)) categories.add(c);
  const offense = teamMatches.filter((m) => !m.defense);
  const source = offense.length >= 2 ? offense : teamMatches;
  const assignment = offense.length >= 2 ? offense.length / teamMatches.length : 1;
  let total = 0;
  let observed = false;
  for (const cat of categories) {
    const ownMade = teamMatches.reduce((s, m) => s + (m.counts[cat]?.[0] || 0), 0);
    const ownMiss = teamMatches.reduce((s, m) => s + (m.counts[cat]?.[1] || 0), 0);
    const attempts = ownMade + ownMiss;
    if (attempts <= 0) continue;
    const [eventMade, eventMiss] = eventContext.totals[cat] || [0, 0];
    const eventAttempts = eventMade + eventMiss;
    const prior = eventAttempts ? eventMade / eventAttempts : ownMade / attempts;
    const accuracy = k > 0 ? (ownMade + k * prior) / (attempts + k) : ownMade / attempts;
    const volumes = source.map((m) => (m.counts[cat]?.[0] || 0) + (m.counts[cat]?.[1] || 0));
    const value = attemptPoints(cat, game);
    const volume = typical(volumes);
    total += volume * accuracy * value * assignment;
    observed = true;
  }
  const endgame = game.endgame || {};
  const none = game.endgame_none || "none";
  const states = teamMatches.map((m) => m.climb);
  for (const state of Object.keys(endgame)) {
    const eventRate = eventContext.matches ? (eventContext.states[state] || 0) / eventContext.matches : state === none ? 1 : 0;
    const probability = (states.filter((s) => s === state).length + 2 * eventRate) / (states.length + 2);
    const points = Number(endgame[state] || 0);
    total += probability * points;
    observed = observed || Boolean(points && states.includes(state));
  }
  observed = observed || Boolean(Object.keys(endgame).length && states.length);
  return observed ? Math.round(Math.max(0, total) * 100) / 100 : null;
}

function consistencyOf(matches: MatchConsensus[], game: GameDef, eventContext: ReturnType<typeof prepareEvent>): number | null {
  if (matches.length < 2) return null;
  const scores = matches.map((m) => estimateAvgPoints([m], eventContext, game) || 0);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (mean <= 0) return null;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  return Math.round(Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / mean)) * 1000) / 1000;
}

async function loadGame(env: Env): Promise<GameDef> {
  const row = await env.DB.prepare("SELECT body FROM game_definitions WHERE id=?").bind("staging-default").first<{ body: string }>();
  return row ? JSON.parse(row.body) : { accuracy_smoothing_k: 20, endgame: { none: 0, l2: 4, l3: 6 }, endgame_none: "none", attempt_points: { "auto|score||": 4, "teleop|score||": 2 } };
}

/** Rebuild dirty teams in a CPU-bounded batch, then publish analysis + page snapshots. */
export async function rebuildAnalysis(env: Env, eventId: string, revision: number | null) {
  const game = await loadGame(env);
  const dirty = await env.DB.prepare("SELECT team, revision FROM dirty_teams WHERE event_id=? ORDER BY team LIMIT 25").bind(eventId).all<{ team: number; revision: number }>();
  const allRows = await env.DB.prepare("SELECT id,team,match_number,payload,voided FROM reports WHERE event_id=? AND voided=0").bind(eventId).all<any>();
  const active = allRows.results.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload, comp_level: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload).comp_level || "qm" }));
  const eventMatches = consensus(active);
  const eventContext = prepareEvent(eventMatches);
  const teams = dirty.results.length ? dirty.results.map((d) => d.team) : [...new Set(active.map((r) => r.team as number))];

  for (const team of teams) {
    const teamReports = active.filter((r) => r.team === team);
    const teamMatches = consensus(teamReports);
    const avg = estimateAvgPoints(teamMatches, eventContext, game);
    const defenseMatches = teamMatches.filter((m) => m.defense).length;
    const climbRate = teamMatches.length ? teamMatches.filter((m) => m.climb && m.climb !== (game.endgame_none || "none")).length / teamMatches.length : 0;
    const consistency = consistencyOf(teamMatches, game, eventContext);
    const body = JSON.stringify({
      team,
      avg_points: avg,
      matches: teamMatches.length,
      defense_matches: defenseMatches,
      climb_rate: Math.round(climbRate * 1000) / 1000,
      consistency,
      haze_power_rating: avg,
    });
    await env.DB.prepare(
      `INSERT INTO team_metrics(event_id,team,revision,avg_points,matches,defense_matches,climb_rate,consistency,body,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id,team) DO UPDATE SET revision=excluded.revision,avg_points=excluded.avg_points,matches=excluded.matches,
       defense_matches=excluded.defense_matches,climb_rate=excluded.climb_rate,consistency=excluded.consistency,body=excluded.body,updated_at=excluded.updated_at`
    ).bind(eventId, team, revision || 0, avg, teamMatches.length, defenseMatches, climbRate, consistency, body, now()).run();
    await env.DB.prepare("DELETE FROM dirty_teams WHERE event_id=? AND team=?").bind(eventId, team).run();
  }

  const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM dirty_teams WHERE event_id=?").bind(eventId).first<number>("n");
  if (remaining && remaining > 0) {
    // More dirty teams: leave job pending so the next queue delivery continues the batch.
    return { complete: false as const, remaining };
  }

  const metrics = await env.DB.prepare("SELECT team,avg_points,matches,defense_matches,climb_rate,consistency,body FROM team_metrics WHERE event_id=?").bind(eventId).all<any>();
  const teamsOut = metrics.results
    .map((m) => ({
      team_number: m.team,
      avg_points: m.avg_points,
      matches: m.matches,
      defense_matches: m.defense_matches,
      climb_rate: m.climb_rate,
      consistency: m.consistency,
      ...(JSON.parse(m.body || "{}")),
    }))
    .sort((a, b) => (b.avg_points ?? -1) - (a.avg_points ?? -1) || a.team_number - b.team_number);

  return {
    complete: true as const,
    analysis: {
      event: eventId,
      revision,
      generated_at: now(),
      teams: teamsOut,
      order_by_avg_points: teamsOut.map((t) => t.team_number),
      stale: false,
      metric: "avg_points",
      note: "avg_points is the scouting-based Haze Power Rating; Match13 ratings are separate.",
    },
    home: {
      event: eventId,
      revision,
      reports: active.length,
      teams: teamsOut.length,
      top: teamsOut.slice(0, 10),
    },
    rankings: {
      event: eventId,
      revision,
      rankings: teamsOut.map((t, i) => ({ rank: i + 1, team_number: t.team_number, avg_points: t.avg_points, matches: t.matches })),
    },
  };
}
