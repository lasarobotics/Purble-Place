import { FALLBACK_GAME } from "../src/lib/game";
import { test, expect, BrowserContext, Page } from "@playwright/test";

async function offlineReady(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Offline download timed out")), 20000);
    const ready = (event: MessageEvent) => {
      if (event.data?.type !== "OFFLINE_READY") return;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", ready);
      resolve();
    };
    navigator.serviceWorker.addEventListener("message", ready);
    navigator.serviceWorker.controller!.postMessage({ type: "WARM_ROUTES", routes: ["/scout", "/admin/team-rank"] });
  }));
}

async function fixture(context: BrowserContext, options: { admin?: boolean; scoutId?: string } = {}) {
  const admin = options.admin ?? true;
  const scoutId = options.scoutId ?? "test-scout";
  const token = Buffer.from(JSON.stringify({ sub: scoutId, admin, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: scoutId, is_admin: admin, role: admin ? "admin" : "scouter", picklist_only: false, display_name: "Test Scout", bucks: 100 };
  let synced = false;
  let bundleReads = 0;
  let reviewRevision = 0;
  const reviewActions: any[] = [];
  const submissions: any[] = [];
  await context.addInitScript(({ session }) => {
    if (!localStorage.getItem("test-initialized")) {
      localStorage.setItem("hazehub.token", session.token);
      localStorage.setItem("hazehub.session", JSON.stringify(session));
      localStorage.setItem("test-initialized", "1");
    }
  }, { session });
  await context.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const summary = { team: 418, nickname: "Purple Haze", avatar: "", epa: 40, matches: 2, avg_points: synced ? 55 : 20,
      consistency: .8, accuracy: .75, trend: 10, avg_fouls: 1, max_points: 70, min_points: 22, climb_rate: .8, failure_rate: .1, avg_driver: 4.2, total_stops: 6,
      counts: { auto_made: 10, auto_missed: 0, teleop_made: 8, teleop_missed: 11 }, match_points: [22, 40, 29, 60, 45, 70].map((points, i) => ({ match: (i + 1) * 6, points })), tags: [] };
    const rankRow = { ...summary, team_number: 418, rank: 1 };
    const analysisRows = [
      { team: 418, nickname: "Purple Haze", avatar: "", matches: 2, defense_capability: null, l4m_defense_capability: null, consistency: .8, l4m_consistency: .7, skew_distribution: .21, l4m_skew_distribution: .18, failure_rate: .1, l4m_failure_rate: .2, foul_match_rate: .5, climb_success_rate: .8, l4m_climb_success_rate: .75, ranking_point_prediction: 2.4 },
      { team: 7332, nickname: "WiredCats", avatar: "", matches: 2, defense_capability: null, l4m_defense_capability: null, consistency: .5, l4m_consistency: .4, skew_distribution: .61, l4m_skew_distribution: .58, failure_rate: .2, l4m_failure_rate: .3, foul_match_rate: .25, climb_success_rate: .6, l4m_climb_success_rate: .5, ranking_point_prediction: 1.6 },
    ];
    const points = Array.from({ length: 29 }, (_, i) => ({ x: .22 + (i % 7) * .085, y: .26 + (i % 5) * .09, phase: i < 10 ? "auto" : "teleop", result: i < 18 ? "made" : "missed" }));
    const heatmaps = Object.fromEntries(["all", "auto", "teleop"].map(phase => {
      const selected = points.filter(p => phase === "all" || p.phase === phase);
      const made = selected.filter(p => p.result === "made").length;
      return [phase, { points: selected, total: selected.length, made, accuracy: made / selected.length }];
    }));
    for (const heat of Object.values(heatmaps) as any[]) heat.filters = Object.fromEntries(Object.entries(heatmaps).map(([phase, h]: [string, any]) => [`${phase}|all`, {total: h.total, made: h.made, accuracy: h.accuracy}]));
    const metrics = [{ key: "avg_points", label: "Haze Power Rating", better: "high" }, { key: "accuracy", label: "Scoring accuracy", better: "high" }, { key: "trend", label: "Scoring trend", better: "high" }];
    let response: any = {};
    if (url.pathname === "/api/game") response = FALLBACK_GAME;
    else if (url.pathname === "/api/betting/mine") response = { bucks: 100, bets: [] };
    else if (url.pathname === "/api/betting/odds") { await route.fulfill({status: 503, json: {detail: "Unavailable"}}); return; }
    else if (url.pathname === "/api/auth/me") response = session;
    else if (url.pathname === "/api/admin/metrics") response = { metrics };
    else if (url.pathname === "/api/admin/rank") response = { teams: [{ ...rankRow, avg_points: synced ? 55 : 20 }] };
    else if (url.pathname === "/api/admin/data-analysis") response = { teams: analysisRows };
    else if (url.pathname === "/api/admin/raw-data") response = {
      event: "2026test", generated_at: new Date().toISOString(),
      entries: [{ client_uuid: "raw-1", submission_id: "raw-1", event_key: "2026test", match_number: 1, comp_level: "qm", team_number: 418, alliance: "red", station: 1, scout_id: scoutId, points: 22, heatmap: [{x:.2,y:.3,phase:"teleop",result:"made"}], auto_missed: 0, teleop_missed: 0, climb: "none", driver_skill: 3, speed_rating: 3, successful_stops: 0, fouls: 0, played_defense: false, failure: false, no_show: false, notes: "", review: {flagged:false,voided:false,revision:reviewRevision}, expected_avg_points: 20, created_at: new Date().toISOString() }],
      pit_entries: [{ event_key: "2026test", team_number: 418, scout_id: scoutId, drivetrain: "swerve", photo_count: 3, updated_at: new Date().toISOString(), responses: { intake: "ground" } }],
    };
    else if (url.pathname === "/api/admin/analysis") {
      bundleReads++;
      response = { event: "2026test", generated_at: new Date().toISOString(), teams: [rankRow], metrics,
        profiles: [{ team_number: 418, nickname: "Purple Haze", epa: 40 }],
        orders: { avg_points: [418], accuracy: [418], trend: [418] }, scouting: { "418": { summary, heatmap: heatmaps.all, heatmaps, reports: [] } },
        analysis: analysisRows, picklist: { teams: [], event_avg_epa: 40 }, consensus: { teams: [] } };
    } else if (url.pathname === "/api/matches") response = { event: "2026test", matches: [1, 2].map(n => ({ event_key: "2026test", match_key: `2026test_qm${n}`, comp_level: "qm", match_number: n, red: [418, 2, 3], blue: [4, 5, 6], red_teams: [{ team_number: 418, nickname: "Purple Haze", epa: 40 }] })) };
    else if (url.pathname === "/api/events") response = { now: new Date().toISOString(), events: [] };
    else if (url.pathname === "/api/scout/last-assignment") response = { alliance: "red", station: 1 };
    else if (url.pathname === "/api/scout/last-data-entry") response = { event: "2026test", last_data_entry: "2026-10-08T15:24:00Z" };
    else if (url.pathname === "/api/pit/418") response = {
      team_number: 418, drivetrain: "swerve", capabilities: ["ground intake"], responses: {},
      robot_photos: [
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%23663399'/%3E%3C/svg%3E",
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%23222222'/%3E%3C/svg%3E",
      ],
    };
    else if (url.pathname === "/api/sync/scout") {
      const entries = route.request().postDataJSON().entries;
      submissions.push(...entries);
      synced = true;
      response = { accepted: entries.map((e: any) => e.client_uuid), duplicates: [], rejected: {} };
    } else if (url.pathname.endsWith("/audit") && url.pathname.startsWith("/api/admin/scouting-data/")) response = { report_id: "raw-1", actions: reviewActions };
    else if (url.pathname.startsWith("/api/admin/scouting-data/") && route.request().method() === "POST") {
      const body = route.request().postDataJSON(); const action = url.pathname.split("/").pop(); reviewRevision++;
      reviewActions.push({ action, reason: body.reason, patch: body.patch || {}, before: { auto_missed: 0, heatmap: [{x:.2,y:.3}] }, actor_name: "Test Scout", created_at: new Date().toISOString() });
      response = { ok: true, revision: reviewRevision };
    } else if (url.pathname.startsWith("/api/teams/")) {
      const team_number = Number(url.pathname.split("/").pop());
      response = { team_number, nickname: team_number === 7332 ? "WiredCats" : "Purple Haze", epa: 40, photos: [] };
    }
    await route.fulfill({ json: response, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  return { submissions, reads: () => bundleReads };
}

test("cloud formulas, offline reload, draft and locked hotkeys, then exactly-once sync", async ({ page, context }) => {
  const data = await fixture(context);
  await page.goto("/admin/team-rank");
  await expect(page.getByRole("heading", { name: "Team Rank" })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(34, 34, 34)");
  await expect(page.locator("tbody")).toContainText("20.0");
  await expect(page.locator("tbody td.sticky-team").first()).toHaveCSS("position", "sticky");
  await page.locator("th .metric-label").filter({hasText: "Haze Power Rating"}).first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Estimated points this robot will contribute");
  await expect(page.getByRole("tooltip")).toContainText("Last data entry:");
  await expect(page.getByRole("tooltip")).not.toContainText("Computed on the server");
  await expect(page.locator(".metric-fraction")).toBeVisible();
  await page.screenshot({ path: "test-results/metric-tooltip.png", fullPage: true });
  await page.getByRole("button", { name: "Data Analysis" }).click();
  await expect(page.locator("tbody td.sticky-team-first").first()).toHaveCSS("position", "sticky");
  await expect(page.locator("tbody tr").first()).toContainText("7332");
  await page.getByRole("button", { name: /^Skew Distribution/ }).click();
  await expect(page.locator("tbody tr").first()).toContainText("418");
  await page.getByRole("button", { name: "Rank", exact: true }).click();
  await page.locator("select").selectOption("accuracy");
  await expect(page.locator("tbody")).toContainText("75%");
  expect(data.reads()).toBe(1);
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller && !!await (await caches.open("hazehub-v6-shell")).match("/scout"));
  // Wait until the scout route's own JavaScript is cached, not just its HTML.
  await page.goto("/scout");
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeEnabled();
  await page.getByRole("button", { name: "Change hotkeys" }).click();
  await page.getByLabel("Select auto", { exact: true }).fill("v");
  await page.getByRole("button", { name: "Save hotkeys" }).click();
  await offlineReady(page);
  await context.setOffline(true);
  await page.getByRole("button", { name: "Start match" }).click();
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeDisabled();
  await page.keyboard.press("v");
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveClass("on");
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  await expect(page.locator(".heatmap-remove-target")).toHaveCount(1);
  await page.getByRole("group", { name: "Auto missed shots", exact: true }).getByRole("button", { name: "Increase" }).click();
  await page.getByRole("group", { name: "Teleop missed shots", exact: true }).getByRole("button", { name: "Increase" }).click();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeDisabled();
  await expect(page.locator(".heatmap-remove-target")).toHaveCount(1);
  await expect.poll(() => page.locator(".field-bg").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/scout-offline.png", fullPage: true });
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect(page.getByRole("dialog", { name: "Scouting report saved" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Scouting report saved" }).locator("img[src*='/pineapples/pineapple']")).toBeVisible();
  await page.getByRole("button", { name: "Keep scouting" }).click();
  await expect(page.getByText("1 queued", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeEnabled();
  await page.goto("/admin/team-rank");
  await expect(page.locator("tbody")).toContainText("20.0");
  await page.locator("select").selectOption("trend");
  await expect(page.locator("tbody")).toContainText("10.0");
  await context.setOffline(false);
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].event_key).toBe("2026test");
  expect(data.submissions[0].heatmap).toHaveLength(1);
  expect(data.submissions[0].heatmap[0].result).toBe("made");
  expect(data.submissions[0].auto_missed).toBe(1);
  expect(data.submissions[0].teleop_missed).toBe(1);
  await page.locator("select").selectOption("avg_points");
  await expect(page.locator("tbody")).toContainText("55.0");
  await expect(page.getByText("1 queued", { exact: false })).toHaveCount(0);
});

test("made map taps and missed counters survive offline reload and sync", async ({ page, context }) => {
  const data = await fixture(context);
  await page.goto("/scout");
  await expect(page.getByText("Count made shots", { exact: true })).toBeVisible();
  await offlineReady(page);
  await context.setOffline(true);
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  const missed = page.getByRole("group", { name: "Teleop missed shots", exact: true });
  await missed.getByRole("button", { name: "Increase" }).click();
  await expect(missed.getByRole("textbox")).toHaveValue("1");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(missed.getByRole("textbox")).toHaveValue("1");
  await expect(page.getByText("Teleop made 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/made-shots-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/made-shots-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(false);
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].heatmap[0].result).toBe("made");
  expect(data.submissions[0].teleop_missed).toBe(1);
});

test("hotkey collisions are rejected and keys persist per scout", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/scout");
  await page.getByRole("button", { name: "Change hotkeys" }).click();
  await page.getByLabel("Select auto", { exact: true }).fill("s");
  await expect(page.getByRole("button", { name: "Save hotkeys" })).toBeDisabled();
  await page.getByLabel("Select auto", { exact: true }).fill("v");
  await page.getByRole("button", { name: "Save hotkeys" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Change hotkeys" }).click();
  await expect(page.getByLabel("Select auto", { exact: true })).toHaveValue("v");
});

test("opening HazeHub downloads the complete scouting shell and assets for offline use", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/home");
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Offline download timed out")), 20000);
    const ready = (event: MessageEvent) => {
      if (event.data?.type !== "OFFLINE_READY") return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", ready);
      resolve();
    };
    navigator.serviceWorker.addEventListener("message", ready);
    navigator.serviceWorker.controller?.postMessage({ type: "WARM_ROUTES", routes: [] });
  }));
  await expect.poll(() => page.evaluate(async () => {
    const names = await caches.keys();
    const shell = await caches.open(names.find(name => name.endsWith("-shell")) || "missing-shell");
    const assets = await caches.open(names.find(name => name.endsWith("-assets")) || "missing-assets");
    const keys = await assets.keys();
    return Boolean(await shell.match("/scout")) && Boolean(await shell.match("/pit")) &&
      Boolean(await assets.match("/field.png")) && Boolean(await assets.match("/pineapples/pineapple1.gif")) &&
      keys.some(request => new URL(request.url).pathname.startsWith("/_next/static/"));
  })).toBe(true);
  await context.setOffline(true);
  await page.goto("/scout");
  await expect(page.getByRole("button", { name: "Start match" })).toBeVisible();
  await expect.poll(() => page.locator(".field-bg").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test("non-admin scouts cannot start a match from the scouting page", async ({ page, context }) => {
  await fixture(context, { admin: false, scoutId: "1" });
  await page.goto("/scout");
  await expect(page.getByRole("button", { name: "Start match" })).toBeDisabled();
});

test("raw match and pit data remain readable offline", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/data");
  await expect(page.getByText("1 match reports · 1 pit reports")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pit scouting" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "swerve", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Beautiful", exact: true }).click();
  await expect(page.getByText("Haze Power Rating", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scouting forms" })).toBeVisible();
  await page.getByText(/QM 1 · test-scout/).click();
  await expect(page.locator(".beautiful-form").first()).toContainText("client uuid");
  await expect(page.locator(".beautiful-form").first()).toContainText("raw-1");
  await expect(page.getByRole("button", { name: "Beautiful", exact: true })).toHaveClass("on");
  await page.reload();
  await expect(page.getByRole("button", { name: "Beautiful", exact: true })).toHaveClass("on");
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const shellName = (await caches.keys()).find(name => name.endsWith("-shell"));
    return !!shellName && !!await (await caches.open(shellName)).match("/data");
  });
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Offline route warm-up timed out")), 5000);
    const ready = (event: MessageEvent) => {
      if (event.data?.type !== "OFFLINE_READY") return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("message", ready);
      resolve();
    };
    navigator.serviceWorker.addEventListener("message", ready);
    navigator.serviceWorker.controller?.postMessage({ type: "WARM_ROUTES", routes: ["/data"] });
  }));
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.reload();
  await expect(page.getByText("1 match reports · 1 pit reports")).toBeVisible();
  await expect(page.getByRole("cell", { name: "swerve", exact: true })).toBeVisible();
});

test("admin edits a report with controls and reads a visual audit trail", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/data");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: "Edit scouting report" })).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/data-edit-dialog.png", fullPage: true });
  await editor.getByLabel("Auto misses").fill("2");
  await editor.getByText("Clear all heatmap dots").click();
  await editor.getByLabel(/Reason for this correction/).fill("Scout confirmed both taps were accidental.");
  await editor.getByRole("button", { name: "Save correction" }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  const audit = page.getByRole("dialog");
  await expect(audit.getByRole("heading", { name: "Report history" })).toBeVisible();
  await expect(audit).toContainText("Scout confirmed both taps were accidental.");
  await expect(audit).toContainText("auto missed");
  await expect(audit).toContainText("heatmap");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/data-audit-dialog.png", fullPage: true });
});

test("heatmap filters, shot toggle, expanded view and interactive trend points", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/admin/team-search");
  await expect(page.getByRole("heading", { name: "Performance Trend" })).toBeVisible();
  await expect(page.locator(".heatmap-stats")).toContainText("29");
  await expect(page.locator(".heatmap-stats")).toContainText("62%");
  await page.getByRole("button", { name: "Open pit photo 1 full size" }).click();
  await expect(page.getByRole("dialog")).toContainText("Pit photo 1 of 2");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog")).toContainText("Pit photo 2 of 2");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".shot-dot")).toHaveCount(0);
  await page.getByRole("button", { name: "Show each shot" }).click();
  await expect(page.locator(".shot-dot")).toHaveCount(29);
  await page.getByRole("button", { name: "Hide each shot" }).click();
  await expect(page.locator(".shot-dot")).toHaveCount(0);
  await page.getByRole("button", { name: "Show each shot" }).click();
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await expect(page.locator(".heatmap-stats")).toContainText("100%");
  await expect(page.locator(".shot-dot")).toHaveCount(10);
  await page.getByRole("button", { name: "Both", exact: true }).click();
  await page.getByLabel("Q24: 60 points").focus();
  await expect(page.locator(".trend-tip")).toContainText("60");
  await page.screenshot({ path: "test-results/analysis-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Open scoring heatmap full size" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "test-results/heatmap-expanded.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/analysis-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("authentication rejection does not fall back to a cached session", async ({ page, context }) => {
  await fixture(context);
  await context.route("**/api/auth/me", route => route.fulfill({ status: 401, json: { detail: "Sign in again" } }));
  await page.goto("/scout");
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => localStorage.getItem("hazehub.token"))).toBeNull();
});

test("a rejected report survives and can be corrected without changing its UUID", async ({ page, context }) => {
  const data = await fixture(context);
  let rejectedId = "";
  await context.route("**/api/sync/scout", async route => {
    rejectedId = route.request().postDataJSON().entries[0].client_uuid;
    await route.fulfill({ json: { accepted: [], duplicates: [], results: [{submission_id: rejectedId, status: "invalid", error: "Correct the report and retry"}] } });
  });
  await page.goto("/scout");
  await expect(page.getByText("Purple Haze", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Start match" }).click();
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  await expect(page.getByText("Teleop made 1", { exact: true })).toBeVisible();
  await page.locator(".heatmap-remove-target").click({ force: true });
  await expect(page.getByText("Teleop made 0", { exact: true })).toBeVisible();
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect(page.getByText("Correct the report and retry", { exact: false })).toBeVisible();
  await expect(page.locator(".heatmap-remove-target")).toHaveCount(1);
  await context.unroute("**/api/sync/scout");
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].client_uuid).toBe(rejectedId);
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeEnabled();
});
