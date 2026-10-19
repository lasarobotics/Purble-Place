import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, report, token, until } from "./harness.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authenticated durable writes, replay conflicts, rollback, audit and queue snapshots", async () => {
  const { mf, db, request } = await harness();
  try {
    assert.equal((await mf.dispatchFetch("https://haze.test/api/prototype/reports")).status, 401);
    assert.equal((await request("/api/auth/me")).status, 200);
    const submit = (body) => request("/api/prototype/scout", { method: "POST", body: JSON.stringify(body) });
    const results = await Promise.all(Array.from({ length: 10 }, () => submit(report())));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 200).length, 9);
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM reports").first("n"), 1);
    assert.equal(await db.prepare("SELECT revision FROM event_revisions").first("revision"), 1);
    assert.equal((await submit({ ...report(), climb: "l3" })).status, 409);
    assert.equal((await submit({ ...report("bad"), team_number: -1 })).status, 422);
    assert.equal((await submit({ ...report("prod"), event_key: "2026real" })).status, 403);
    // An outbox failure must roll back the essential report insert too.
    await db.exec("CREATE TRIGGER fail_job BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.equal((await submit(report("rollback"))).status, 503);
    assert.equal(await db.prepare("SELECT id FROM reports WHERE id='rollback'").first(), null);
    await db.exec("DROP TRIGGER fail_job;");
    const patch = { operation_id: "void-1", operation: "void", expected_version: 1 };
    assert.equal((await request("/api/prototype/reports/report-1", { method: "PATCH", body: JSON.stringify(patch) })).status, 403);
    assert.equal((await request("/api/prototype/reports/report-1", { user: "Admin", method: "PATCH", body: JSON.stringify(patch) })).status, 200);
    assert.equal((await request("/api/prototype/reports/report-1", { user: "Admin", method: "PATCH", body: JSON.stringify(patch) })).status, 200);
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM audit").first("n"), 1);
    // Exercise actual Queue delivery/consumer (D1 remains the outbox source).
    const queue = await mf.getQueueProducer("JOBS", "domain");
    await queue.send({ id: "overview:prototype-demo" });
    await until(async () => (await db.prepare("SELECT status FROM jobs WHERE id='overview:prototype-demo'").first("status")) === "done");
    const res = await request("/api/prototype/overview");
    assert.equal(res.status, 200);
    assert.equal((await res.clone().json()).reports, 0);
    assert.equal((await request("/api/prototype/overview", { headers: { "If-None-Match": res.headers.get("ETag") } })).status, 304);
    await submit(report("next"));
    assert.equal((await request("/api/prototype/overview")).headers.get("X-Haze-Stale"), "true");
    await db.prepare("UPDATE accounts SET active=0 WHERE id='Scout'").run();
    assert.equal((await request("/api/prototype/overview", { headers: { "If-None-Match": res.headers.get("ETag") } })).status, 401);
    assert.equal((await request("/api/auth/me", { headers: { Authorization: `Bearer ${token("Admin", "wrong")}` } })).status, 401);
  } finally {
    await mf.dispose();
  }
});

test("incremental analysis snapshots expose avg_points Haze Power Rating", async () => {
  const { mf, db, request } = await harness();
  try {
    const submit = (body) => request("/api/prototype/scout", { method: "POST", body: JSON.stringify(body) });
    await submit(report("a1", { team_number: 418, match_number: 1, heatmap: [{ phase: "auto", result: "made", x: 0.1, y: 0.1 }, { phase: "teleop", result: "made", x: 0.2, y: 0.2 }], climb: "l3" }));
    await submit(report("a2", { team_number: 418, match_number: 2, heatmap: [{ phase: "auto", result: "made", x: 0.1, y: 0.1 }], climb: "l2" }));
    await submit(report("b1", { team_number: 436, match_number: 1, heatmap: [{ phase: "teleop", result: "missed", x: 0.3, y: 0.3 }], climb: "none" }));
    const queue = await mf.getQueueProducer("JOBS", "domain");
    await queue.send({ id: "analysis:prototype-demo" });
    await until(async () => (await db.prepare("SELECT status FROM jobs WHERE id='analysis:prototype-demo'").first("status")) === "done", 10000);
    const analysis = await request("/api/admin/data-analysis");
    assert.equal(analysis.status, 200);
    const body = await analysis.json();
    assert.equal(body.metric, "avg_points");
    assert.ok(Array.isArray(body.teams) && body.teams.length >= 2);
    const t418 = body.teams.find((t) => t.team_number === 418);
    assert.ok(t418 && typeof t418.avg_points === "number" && t418.avg_points > 0);
    const pages = await request("/api/prototype/pages?pages=home,rankings,data-analysis");
    assert.equal(pages.status, 200);
    const batch = await pages.json();
    assert.equal(batch.pages.home.pending, undefined);
    assert.ok(batch.pages.rankings.rankings?.length >= 2);
    assert.equal((await request("/api/prototype/pages/rankings", { headers: { "If-None-Match": (await request("/api/prototype/pages/rankings")).headers.get("ETag") } })).status, 304);
  } finally {
    await mf.dispose();
  }
});

test("pbkdf2 login, sync batch statuses, and public health", async () => {
  const { mf, db, request } = await harness();
  try {
    assert.equal((await mf.dispatchFetch("https://haze.test/api/health")).status, 200);
    assert.equal((await request("/api/auth/account-status", { user: null, method: "POST", body: JSON.stringify({ scout_id: "Other" }) })).status, 200);
    const setup = await request("/api/auth/setup", {
      user: null,
      method: "POST",
      body: JSON.stringify({ scout_id: "Other", password: "secure-pass-1" }),
    });
    assert.equal(setup.status, 200);
    const { token: loginToken } = await setup.json();
    assert.ok(loginToken.includes("."));
    const login = await request("/api/auth/login", {
      user: null,
      method: "POST",
      body: JSON.stringify({ scout_id: "Other", password: "secure-pass-1" }),
    });
    assert.equal(login.status, 200);
    // Inject scrypt so Workers path refuses until reset.
    await db.prepare("UPDATE accounts SET password_hash=? WHERE id='Other'").bind("scrypt$abcd$deadbeef").run();
    assert.equal(
      (await request("/api/auth/login", { user: null, method: "POST", body: JSON.stringify({ scout_id: "Other", password: "secure-pass-1" }) })).status,
      503
    );
    const sync = await request("/api/sync/scout", {
      method: "POST",
      body: JSON.stringify({
        records: [
          report("s1"),
          report("s1"),
          { ...report("s2"), team_number: -1 },
          { ...report("s1"), climb: "park" },
        ],
      }),
    });
    assert.equal(sync.status, 200);
    const { results } = await sync.json();
    assert.deepEqual(
      results.map((r) => r.status),
      ["created", "already_exists", "invalid", "conflict"]
    );
  } finally {
    await mf.dispose();
  }
});

test("versioned meetings, single-use sockets, revocation and persisted restart recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "haze-cf-"));
  let h = await harness(dir);
  try {
    const edit = (op, rev, first = [418]) =>
      h.request("/api/prototype/meetings/demo", {
        user: "Admin",
        method: "PUT",
        body: JSON.stringify({ operation_id: op, expected_revision: rev, first, second: [436] }),
      });
    assert.equal((await edit("op1", 0)).status, 200);
    assert.equal((await edit("op1", 0)).status, 200);
    const issued = await h.request("/api/prototype/tickets", { method: "POST", body: JSON.stringify({ meeting_id: "demo" }) });
    const { ticket } = await issued.json();
    const response = await h.mf.dispatchFetch(`https://haze.test/api/prototype/ws/demo?ticket=${ticket}`, { headers: { Upgrade: "websocket" } });
    assert.equal(response.status, 101);
    const ws = response.webSocket;
    ws.accept();
    assert.equal((await h.mf.dispatchFetch(`https://haze.test/api/prototype/ws/demo?ticket=${ticket}`, { headers: { Upgrade: "websocket" } })).status, 401);
    const messages = [];
    ws.addEventListener("message", (m) => messages.push(JSON.parse(m.data)));
    const concurrent = await Promise.all([edit("op2", 1, [418, 118]), edit("op3", 1, [118, 418])]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    await until(() => messages.some((m) => m.revision === 2));
    await edit("op4", 2);
    await until(() => messages.some((m) => m.revision === 3));
    // Revoked accounts cannot mint tickets or read private APIs (WS close is flaky in Miniflare).
    await h.db.prepare("UPDATE accounts SET active=0 WHERE id='Scout'").run();
    assert.equal((await h.request("/api/prototype/tickets", { method: "POST", body: JSON.stringify({ meeting_id: "demo" }) })).status, 401);
    assert.equal((await h.request("/api/auth/me")).status, 401);
    try { ws.close(1000, "test done"); } catch { /* ignore */ }
    await h.mf.dispose();
    h = await harness(dir);
    const recovered = await h.request("/api/prototype/meetings/demo", { user: "Admin" });
    assert.equal((await recovered.json()).revision, 3);
  } finally {
    await h.mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
