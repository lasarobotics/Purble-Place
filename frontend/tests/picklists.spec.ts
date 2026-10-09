import { test, expect, BrowserContext } from "@playwright/test";

function state() {
  const board = (round: number) => ({ id: -round, event_key: "2026test", owner_id: "team", owner_name: "Meeting", owner_role: "master", priority: 0, is_master: true, pick_round: round, name: `Final ${round === 1 ? "First" : "Second"} Pick`, items: [], updated_at: new Date().toISOString() });
  return { event_key: "2026test", version: 0, status: "not_started", locked: false, view: "both", selected_team: null, boards: [board(1), board(2)], notes: {}, team_statuses: {}, published: null, updated_at: new Date().toISOString(), viewers: 2, can_undo: false, can_redo: false } as any;
}
async function setup(context: BrowserContext, admin: boolean, shared: any) {
  const id = admin ? "Admin" : "10217860";
  const token = Buffer.from(JSON.stringify({ sub: id, admin, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: id, is_admin: admin, role: admin ? "admin" : "scouter", display_name: admin ? "Administrator" : "Alex Scout", bucks: 100, picklist_only: false };
  await context.addInitScript(s => { localStorage.setItem("hazehub.token", s.token); localStorage.setItem("hazehub.session", JSON.stringify(s)); }, session);
  const profiles = [418, 436, 254].map(team_number => ({ team_number, nickname: `Team ${team_number}` }));
  const drafts = [1, 2].map(pick_round => ({ ...shared.boards[pick_round - 1], id: pick_round, owner_id: id, owner_name: "Alex Scout", is_master: false, name: `My ${pick_round} draft`, status: "Draft", version: 1, created_at: new Date().toISOString() }));
  let submissions: any[] = shared.submissions || [];
  await context.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let result: any = {};
    if (path === "/api/auth/me") result = session;
    else if (path === "/api/admin/analysis") result = { teams: profiles.map(t => ({ team: t.team_number })), profiles, scouting: {}, orders: { avg_points: [] } };
    else if (path === "/api/events") result = { now: new Date().toISOString(), events: [] };
    else if (path === "/api/matches") result = { matches: [] };
    else if (path === "/api/betting/mine") result = { bets: [] };
    else if (path === "/api/betting/leaderboard") result = [];
    else if (path === "/api/matches/current") result = { current: null, on_deck: [], event: "2026test" };
    else if (path === "/api/teams/batch") result = profiles;
    else if (/^\/api\/teams\/\d+$/.test(path)) result = profiles.find(t => t.team_number === Number(path.split("/").pop()));
    else if (path === "/api/picklists/mine") result = drafts;
    else if (path === "/api/picklists/submissions") result = submissions;
    else if (path === "/api/picklists/all") result = [...drafts, ...submissions];
    else if (path === "/api/picklists/finals") result = shared.published ? shared.published.boards.map((b: any) => ({ ...b, published_at: shared.published.published_at })) : [];
    else if (path === "/api/picklists/drafts") {
      for (const edit of route.request().postDataJSON().drafts) {
        const row = drafts.find(d => d.id === edit.id)!;
        if (row.version !== edit.version) return route.fulfill({ status: 409, json: { detail: "Version conflict" } });
        Object.assign(row, edit, { version: row.version + 1, updated_at: new Date().toISOString() });
      }
      result = drafts.filter(d => route.request().postDataJSON().drafts.some((r: any) => r.id === d.id));
    } else if (/\/api\/picklists\/\d+\/submit/.test(path)) {
      const body = route.request().postDataJSON();
      result = { ...body, id: 100 + submissions.length, source_id: body.id, status: "Submitted", latest: true, version: submissions.length + 1 };
      submissions = [result, ...submissions];
    } else if (path === "/api/picklists/meeting") {
      if (method === "POST") {
        const body = route.request().postDataJSON();
        if (!admin) return route.fulfill({ status: 403, json: { detail: "Admin only" } });
        if (body.version !== shared.version) return route.fulfill({ status: 409, json: { detail: "Version conflict" } });
        const action = body.action;
        if (action === "start" || action === "resume") shared.status = "live";
        if (action === "pause") shared.status = "paused";
        if (action === "end") shared.status = "ended";
        if (action === "lock") shared.locked = body.data.locked;
        if (action === "edit_boards") for (const [round, items] of Object.entries(body.data.boards)) shared.boards[Number(round) - 1].items = items;
        if (action === "import") shared.boards[body.data.pick_round - 1].items = structuredClone(submissions.find(l => l.id === body.data.source_id).items);
        if (action === "publish") shared.published = { boards: structuredClone(shared.boards), published_at: new Date().toISOString() };
        shared.version++; shared.updated_at = new Date().toISOString();
        shared.boards.forEach((b: any) => b.updated_at = shared.updated_at);
      }
      result = shared;
    }
    await route.fulfill({ json: result });
  });
  return { drafts, getSubmissions: () => submissions };
}

test("scout drafts autosave, submit a named immutable reference, and hide disabled tools", async ({ page, context }) => {
  const shared = state();
  const fixture = await setup(context, false, shared);
  await page.goto("/picklists");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect.poll(() => fixture.drafts[0].items.length).toBe(1);
  await page.getByRole("button", { name: "Submit Picklist", exact: true }).click();
  await expect(page.getByLabel("Submission name")).toHaveValue("AlexScout_FirstPick");
  await page.getByRole("button", { name: "Confirm submission" }).click();
  await expect(page.getByText("Your submissions")).toBeVisible();
  await expect.poll(() => fixture.getSubmissions().length).toBe(1);
  expect(fixture.getSubmissions()[0].items[0].team).toBe(254);
  await page.getByRole("button", { name: "Remove", exact: true }).first().click();
  await expect.poll(() => fixture.drafts[0].items.length).toBe(0);
  expect(fixture.getSubmissions()[0].items[0].team).toBe(254);
  for (const path of ["forms", "seasons"]) {
    await expect(page.locator(`.sidebar a[href="/admin/${path}"]`)).toHaveCount(0);
    await page.goto(`/admin/${path}`);
    await expect(page.getByText("This tool is temporarily disabled.")).toBeVisible();
  }
});

test("admin meeting updates viewers, pauses, recovers after reload, and publishes to home", async ({ browser }) => {
  const shared = state();
  const ac = await browser.newContext(); const vc = await browser.newContext();
  await setup(ac, true, shared); await setup(vc, false, shared);
  const admin = await ac.newPage(); const viewer = await vc.newPage();
  await Promise.all([admin.goto("/meeting"), viewer.goto("/meeting")]);
  await expect(viewer.getByText("Picklist Meeting Has Not Started Yet")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Start meeting" })).toHaveCount(0);
  await admin.getByRole("button", { name: "Start meeting", exact: true }).click();
  await expect(viewer.getByText("Picklist Meeting Has Not Started Yet")).toHaveCount(0, { timeout: 15000 });
  await admin.locator(".picklist-board").nth(0).getByRole("button", { name: "Add", exact: true }).first().click();
  await expect.poll(() => shared.boards[0].items.length).toBe(1);
  await admin.locator(".picklist-board").nth(1).getByRole("button", { name: "Add", exact: true }).nth(1).click();
  await expect.poll(() => shared.boards[1].items.length).toBe(1);
  await expect(viewer.locator(".pick-order .pick-row")).toHaveCount(2, { timeout: 15000 });
  await expect(viewer.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await admin.getByRole("button", { name: "Pause meeting", exact: true }).click();
  await expect(admin.getByText("Meeting paused · rankings are read-only")).toBeVisible();
  await admin.reload();
  await expect(admin.locator(".pick-order .pick-row")).toHaveCount(2);
  await admin.getByRole("button", { name: "Resume meeting", exact: true }).click();
  await admin.getByRole("button", { name: "Publish Final Picklists", exact: true }).click();
  await admin.getByRole("button", { name: "Confirm publication", exact: true }).click();
  await viewer.goto("/home");
  await expect(viewer.getByRole("heading", { name: "Official Picklists", exact: true })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Final First Pick", exact: true })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Final Second Pick", exact: true })).toBeVisible();
  await admin.screenshot({ path: "test-results/picklist-meeting-desktop.png", fullPage: true });
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({ path: "test-results/picklist-meeting-mobile.png", fullPage: true });
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await ac.close(); await vc.close();
});

test("admin finds references by list or scouter name, compares and imports a copy", async ({ page, context }) => {
  const shared = state(); shared.status = "live";
  shared.submissions = [1, 2].map(n => ({ ...shared.boards[0], id: n + 100, owner_name: n === 1 ? "Alex Scout" : "Jordan Scout", name: n === 1 ? "Alex_FirstPick" : "JordanStrategy", version: 1, latest: true, status: "Submitted", items: [{ team: n === 1 ? 418 : 436 }, { team: 254 }] }));
  await setup(context, true, shared);
  await page.goto("/meeting");
  await page.getByLabel("Search submitted picklists").fill("Jordan");
  await expect(page.getByRole("button", { name: "Open reference" })).toHaveCount(1);
  await page.getByRole("button", { name: "Open reference" }).click();
  await expect(page.getByRole("dialog")).toContainText("JordanStrategy");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Search submitted picklists").fill("");
  await page.getByLabel("Compare Alex_FirstPick version 1").check();
  await page.getByLabel("Compare JordanStrategy version 1").check();
  await expect(page.getByRole("heading", { name: "Compare First Pick · 2 lists" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "2/2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import copy" }).first().click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".pick-order .pick-row:not(.drop-tail)")).toHaveCount(2);
  expect(shared.submissions[0].items[0].team).toBe(418);
});
