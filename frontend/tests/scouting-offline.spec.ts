import { FALLBACK_GAME } from "../src/lib/game";
import { test, expect, BrowserContext } from "@playwright/test";

async function fixture(context: BrowserContext) {
  const token = Buffer.from(JSON.stringify({ sub: "test-scout", admin: true, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: "test-scout", is_admin: true, role: "admin", picklist_only: false, display_name: "Test Scout", bucks: 100 };
  let synced = false;
  let bundleReads = 0;
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
    const points = Array.from({ length: 29 }, (_, i) => ({ x: .22 + (i % 7) * .085, y: .26 + (i % 5) * .09, phase: i < 10 ? "auto" : "teleop", result: i < 18 ? "made" : "missed" }));
    const heatmaps = Object.fromEntries(["all", "auto", "teleop"].map(phase => {
      const selected = points.filter(p => phase === "all" || p.phase === phase);
      const made = selected.filter(p => p.result === "made").length;
      return [phase, { points: selected, total: selected.length, made, accuracy: made / selected.length }];
    }));
    for (const heat of Object.values(heatmaps) as any[]) heat.filters = Object.fromEntries(Object.entries(heatmaps).map(([phase, h]: [string, any]) => [`${phase}|all`, {total: h.total, made: h.made, accuracy: h.accuracy}]));
    const metrics = [{ key: "avg_points", label: "Avg points", better: "high" }, { key: "accuracy", label: "Scoring accuracy", better: "high" }, { key: "trend", label: "Scoring trend", better: "high" }];
    let response: any = {};
    if (url.pathname === "/api/game") response = FALLBACK_GAME;
    else if (url.pathname === "/api/betting/mine") response = { bucks: 100, bets: [] };
    else if (url.pathname === "/api/betting/odds") { await route.fulfill({status: 503, json: {detail: "Unavailable"}}); return; }
    else if (url.pathname === "/api/auth/me") response = session;
    else if (url.pathname === "/api/admin/analysis") {
      bundleReads++;
      response = { event: "2026test", generated_at: new Date().toISOString(), teams: [summary], metrics,
        profiles: [{ team_number: 418, nickname: "Purple Haze", epa: 40 }],
        orders: { avg_points: [418], accuracy: [418], trend: [418] }, scouting: { "418": { summary, heatmap: heatmaps.all, heatmaps, reports: [] } },
        analysis: [], picklist: { teams: [], event_avg_epa: 40 }, consensus: { teams: [] } };
    } else if (url.pathname === "/api/matches") response = { event: "2026test", matches: [1, 2].map(n => ({ event_key: "2026test", match_key: `2026test_qm${n}`, comp_level: "qm", match_number: n, red: [418, 2, 3], blue: [4, 5, 6], red_teams: [{ team_number: 418, nickname: "Purple Haze", epa: 40 }] })) };
    else if (url.pathname === "/api/events") response = { now: new Date().toISOString(), events: [] };
    else if (url.pathname === "/api/scout/last-assignment") response = { alliance: "red", station: 1 };
    else if (url.pathname === "/api/sync/scout") {
      const entries = route.request().postDataJSON().entries;
      submissions.push(...entries);
      synced = true;
      response = { accepted: entries.map((e: any) => e.client_uuid), duplicates: [], rejected: {} };
    } else if (url.pathname.startsWith("/api/teams/")) response = { team_number: 418, nickname: "Purple Haze", epa: 40, photos: [] };
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
  await page.locator("th .metric-label").filter({hasText: "Avg points"}).hover();
  await expect(page.getByRole("tooltip")).toContainText("Mean performance points");
  await expect(page.locator(".metric-fraction")).toBeVisible();
  await page.screenshot({ path: "test-results/metric-tooltip.png", fullPage: true });
  await page.locator("select").selectOption("accuracy");
  await expect(page.locator("tbody")).toContainText("75%");
  expect(data.reads()).toBe(1);
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller && !!await (await caches.open("hazehub-v4-shell")).match("/scout"));
  // Wait until the scout route's own JavaScript is cached, not just its HTML.
  await page.goto("/scout");
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeEnabled();
  await page.getByRole("button", { name: "Change hotkeys" }).click();
  await page.getByLabel("Select auto", { exact: true }).fill("v");
  await page.getByRole("button", { name: "Save hotkeys" }).click();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Start match" }).click();
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeDisabled();
  await page.keyboard.press("v");
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveClass("on");
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  await expect(page.locator(".field-svg circle")).toHaveCount(1);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeDisabled();
  await expect(page.locator(".field-svg circle")).toHaveCount(1);
  await page.screenshot({ path: "test-results/scout-offline.png", fullPage: true });
  await page.getByRole("button", { name: /^Submit/ }).click();
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
  await page.locator("select").selectOption("avg_points");
  await expect(page.locator("tbody")).toContainText("55.0");
  await expect(page.getByText("1 queued", { exact: false })).toHaveCount(0);
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

test("heatmap filters, shot toggle, expanded view and interactive trend points", async ({ page, context }) => {
  await fixture(context);
  await page.goto("/admin/team-search");
  await expect(page.getByRole("heading", { name: "Performance Trend" })).toBeVisible();
  await expect(page.locator(".heatmap-stats")).toContainText("29");
  await expect(page.locator(".heatmap-stats")).toContainText("62%");
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
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect(page.getByText("Correct the report and retry", { exact: false })).toBeVisible();
  await expect(page.locator(".field-svg circle")).toHaveCount(1);
  await context.unroute("**/api/sync/scout");
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].client_uuid).toBe(rejectedId);
  await expect(page.getByRole("button", { name: "Change hotkeys" })).toBeEnabled();
});
