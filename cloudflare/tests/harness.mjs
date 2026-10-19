import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { join } from "node:path";

export const secret = "synthetic-test-secret-not-for-deployment";
export function token(id = "Scout", revision = "test-revision", exp = Date.now() / 1000 + 3600) {
  const raw = Buffer.from(JSON.stringify({ sub: id, auth_version: 2, credential_revision: revision, exp })).toString("base64url");
  return `${raw}.${createHmac("sha256", secret).update(raw).digest("base64url")}`;
}

/** Split SQL into statements without cutting CREATE TRIGGER bodies (they contain `;`). */
function splitSql(sql) {
  const cleaned = sql.replace(/^--.*$/gm, "");
  const parts = [];
  let buf = "";
  let inTrigger = false;
  for (const line of cleaned.split(/\n/)) {
    const trimmed = line.trim();
    if (!inTrigger && /^CREATE\s+TRIGGER\b/i.test(trimmed)) inTrigger = true;
    buf += (buf ? "\n" : "") + line;
    if (inTrigger) {
      if (/\bEND\s*;\s*$/i.test(trimmed)) {
        parts.push(buf.trim());
        buf = "";
        inTrigger = false;
      }
      continue;
    }
    if (/;\s*$/.test(trimmed)) {
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

async function applyMigrations(db) {
  if (await db.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").first()) return;
  const dir = "migrations";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    for (const part of splitSql(sql)) {
      const stmt = part.replace(/\n/g, " ").trim();
      if (stmt) await db.exec(stmt.endsWith(";") ? stmt : stmt + ";");
    }
  }
  for (const [id, role] of [
    ["Scout", "scouter"],
    ["Admin", "admin"],
    ["Other", "scouter"],
  ]) {
    await db.prepare("INSERT INTO accounts(id,display_name,role,credential_revision) VALUES(?,?,?,'test-revision')").bind(id, id, role).run();
  }
}

export async function harness(persist) {
  const common = {
    compatibilityDate: "2026-10-01",
    modules: true,
    d1Databases: { DB: "test-db" },
    bindings: { SESSION_SECRET: secret, STAGING_EVENT: "prototype-demo", TEAM_PASSWORD: "team-bootstrap" },
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      // Miniflare 5 uses a single resourcePersistencePath (v4 d1Persist was removed).
      ...(persist ? { resourcePersistencePath: persist } : {}),
      workers: [
        {
          ...common,
          name: "gateway",
          scriptPath: "dist/gateway/index.js",
          serviceBindings: { DOMAIN: "domain" },
          ratelimits: { LIMITER: { namespace_id: "1001", simple: { limit: 100000, period: 60 } } },
        },
        {
          ...common,
          name: "domain",
          scriptPath: "dist/domain/index.js",
          durableObjects: { MEETINGS: { className: "MeetingRoom", useSQLite: true } },
          queueProducers: { JOBS: "jobs" },
          queueConsumers: { jobs: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 } },
        },
      ],
    })
  );
  const db = await mf.getD1Database("DB", "domain");
  await applyMigrations(db);
  async function request(path, options = {}) {
    const { user = "Scout", ...opts } = options;
    const headers = { "Content-Type": "application/json", ...opts.headers };
    if (user !== null) headers.Authorization = `Bearer ${token(user)}`;
    return mf.dispatchFetch(`https://haze.test${path}`, { ...opts, headers });
  }
  return { mf, db, request };
}

export const report = (id = "report-1", extra = {}) => ({
  submission_id: id,
  event_key: "prototype-demo",
  team_number: 418,
  match_number: 1,
  comp_level: "qm",
  heatmap: [{ phase: "auto", result: "made", x: 0.4, y: 0.2 }],
  climb: "l2",
  ...extra,
});

export async function until(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for background work");
}
