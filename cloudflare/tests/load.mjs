/**
 * Synthetic competition-day load estimate against Miniflare.
 * Models concurrent scouting writes + snapshot reads; does not claim production SLA.
 */
import { harness, report, until } from "./harness.mjs";

const USERS = Number(process.env.LOAD_USERS || 30);
const WRITES_PER_USER = Number(process.env.LOAD_WRITES || 3);

const { mf, db, request } = await harness();
const started = Date.now();
const latencies = [];
try {
  const tasks = [];
  for (let u = 0; u < USERS; u++) {
    tasks.push(
      (async () => {
        for (let w = 0; w < WRITES_PER_USER; w++) {
          const t0 = performance.now();
          const res = await request("/api/prototype/scout", {
            method: "POST",
            body: JSON.stringify(
              report(`u${u}-w${w}`, {
                team_number: 100 + (u % 40),
                match_number: 1 + w,
                heatmap: [{ phase: "teleop", result: "made", x: 0.5, y: 0.5 }],
              })
            ),
          });
          latencies.push({ kind: "write", ms: performance.now() - t0, status: res.status });
          if (res.status >= 500) throw new Error(`write failed ${res.status}`);
        }
        const t1 = performance.now();
        const read = await request("/api/prototype/overview");
        latencies.push({ kind: "read", ms: performance.now() - t1, status: read.status });
      })()
    );
  }
  await Promise.all(tasks);
  const queue = await mf.getQueueProducer("JOBS", "domain");
  // Dirty-team batches may need several deliveries; keep nudging the outbox.
  await until(async () => {
    const status = await db.prepare("SELECT status FROM jobs WHERE id='analysis:prototype-demo'").first("status");
    if (status === "done") return true;
    try { await queue.send({ id: "analysis:prototype-demo" }); } catch { /* ignore */ }
    return false;
  }, 60000);
  const reports = await db.prepare("SELECT COUNT(*) AS n FROM reports").first("n");
  const writes = latencies.filter((l) => l.kind === "write");
  const reads = latencies.filter((l) => l.kind === "read");
  const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] || 0;
  };
  const summary = {
    users: USERS,
    writes_per_user: WRITES_PER_USER,
    reports,
    elapsed_ms: Date.now() - started,
    write_p50_ms: Math.round(pct(writes.map((w) => w.ms), 50)),
    write_p95_ms: Math.round(pct(writes.map((w) => w.ms), 95)),
    read_p50_ms: Math.round(pct(reads.map((r) => r.ms), 50)),
    ok_writes: writes.filter((w) => w.status < 400).length,
    total_writes: writes.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  // Free-tier rough estimate for a 12h day with 100 users:
  // ~100 users * 40 scout writes * 2 (retries/idempotent) + snapshot polls ≈ well under 100k req/day
  // if browsers use ETag 304s and WebSocket meeting fanout instead of polling.
  console.log(
    JSON.stringify({
      free_tier_note:
        "With ETag 304s, page snapshots, and WS meetings, modeled competition day stays under 100k Worker requests and 10k Queue ops when analytics jobs coalesce per event.",
      modeled_requests_12h: USERS * WRITES_PER_USER * (100 / USERS) * 40 + 100 * 200,
    })
  );
} finally {
  await mf.dispose();
}
