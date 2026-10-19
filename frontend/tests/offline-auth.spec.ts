import { test, expect, Page, BrowserContext } from "@playwright/test";
import { FALLBACK_GAME } from "../src/lib/game";
// Match the local API hostname so the test exercises SameSite cookies.
test.use({ baseURL: "http://localhost:3157" });

const id = "10217860";
const password = "Unique-offline-password-123";
async function signIn(page: Page, pw = password, account = id) {
  await page.getByLabel("Scouter ID", { exact: true }).fill(account);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill(pw);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function editStorage(page: Page, action: string) {
  return page.evaluate(action => new Promise<any>((resolve, reject) => {
    const request = indexedDB.open("hazehub");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("offlineCredentials", "readwrite");
      const store = tx.objectStore("offlineCredentials");
      const get = store.getAll();
      let result: any;
      get.onsuccess = () => {
        const rows = get.result;
        result = rows.map(r => ({ id: r.id, keyExtractable: r.key?.extractable, plaintext: JSON.stringify(r) }));
        for (const row of rows.filter(r => r.id.startsWith("account:"))) {
          if (action === "expire") { row.expires_at = Date.now() - 1; store.put(row); }
          if (action === "tamper") { row.envelope.ciphertext = new ArrayBuffer(20); store.put(row); }
          if (action === "lock") { row.failures = 5; store.put(row); }
          if (action === "clock") { row.last_seen = Date.now() + 120_000; store.put(row); }
        }
        if (action === "lost-key") store.delete("device-v1");
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => reject(tx.error);
    };
  }), action);
}

async function installMocks(context: BrowserContext) {
  const state = { unavailable: false, revoked: false, uploads: [] as any[] };
  const token = Buffer.from(JSON.stringify({ sub: id, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: id, role: "scouter", is_admin: false, picklist_only: false, display_name: "Scout", bucks: 100 };
  await context.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = await route.request().allHeaders();
    if (state.unavailable) return route.abort("connectionrefused");
    if (state.revoked && path.startsWith("/api/auth/") && path !== "/api/auth/account-status") return route.fulfill({ status: 401, json: { detail: "Account revoked" } });
    if (path === "/api/auth/account-status") return route.fulfill({ json: { needs_setup: false } });
    if (path === "/api/auth/login") return route.fulfill({ json: session, headers: { "Set-Cookie": "hazehub_session=test; Path=/api/auth; HttpOnly; SameSite=Lax" } });
    if (path === "/api/auth/me") return route.fulfill(headers["authorization"] || headers["cookie"]?.includes("hazehub_session") ? { json: session } : { status: 401, json: { detail: "Sign in" } });
    if (path === "/api/auth/offline-provision") return route.fulfill({ json: { version: 1, scout_id: id, s_number: 1, display_name: "Scout", issued_at: Date.now(), expires_at: Date.now() + 86399_000 } });
    if (path === "/api/scout/mine") return route.fulfill({ json: [] });
    if (path === "/api/game") return route.fulfill({ json: FALLBACK_GAME });
    if (path === "/api/scout/last-assignment") return route.fulfill({ json: { alliance: "red", station: 1 } });
    if (path === "/api/matches") return route.fulfill({ json: { event: "2026test", matches: [{ event_key: "2026test", match_key: "2026test_qm1", comp_level: "qm", match_number: 1, red: [418, 2, 3], blue: [4, 5, 6], red_teams: [{ team_number: 418, nickname: "Purple Haze" }] }] } });
    if (path === "/api/teams/batch") return route.fulfill({ json: [{ team_number: 418, nickname: "Purple Haze" }] });
    if (path === "/api/betting/mine") return route.fulfill({ json: { bets: [] } });
    if (path === "/api/sync/scout") {
      const entries = route.request().postDataJSON().entries;
      state.uploads.push(...entries);
      return route.fulfill({ json: { results: entries.map((e: any) => ({ submission_id: e.submission_id, status: "created" })) } });
    }
    return route.fulfill({ status: 503, json: { detail: "No event" } });
  });
  return { state, token };
}

test("prepared account unlocks in airplane mode, denies unknown accounts, and requires online reauthentication", async ({ page, context }) => {
  const { state, token } = await installMocks(context);
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL(/\/home\/?$/);
  await page.goto("/scout");
  await expect(page.getByText("Count made shots", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change team number", exact: true })).toBeVisible();
  await expect(page.getByText("Purple Haze", { exact: true }).first()).toBeVisible();
  await page.goto("/account");
  await expect(page.getByText("Your account is prepared", { exact: false })).toBeVisible();
  const stored = await editStorage(page, "inspect");
  expect(stored.find((r: any) => r.id === "device-v1").keyExtractable).toBe(false);
  expect(JSON.stringify(stored)).not.toContain(password);
  expect(JSON.stringify(stored)).not.toContain(token);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => new Promise<void>(resolve => {
    const done = (e: MessageEvent) => { if (e.data?.type === "OFFLINE_READY") { navigator.serviceWorker.removeEventListener("message", done); resolve(); } };
    navigator.serviceWorker.addEventListener("message", done);
    navigator.serviceWorker.controller!.postMessage({ type: "WARM_ROUTES", routes: ["/login", "/home", "/account", "/scout"] });
  }));
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await expect(page).toHaveURL(/login/);
  await context.setOffline(true);
  await page.getByLabel("Scouter ID", { exact: true }).fill("never-provisioned");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("This account needs an online sign-in", { exact: false })).toBeVisible();
  await signIn(page, "wrong-password");
  await expect(page.getByText("Incorrect password or damaged", { exact: false })).toBeVisible();
  await page.waitForTimeout(1100);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Offline sign-in · Scouting stays", { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Offline sign-in · Scouting stays", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("hazehub.token"))).toBeNull();
  await page.goto("/scout");
  await expect(page.getByRole("button", { name: "Change team number", exact: true })).toBeVisible();
  await page.locator(".field-wrap").click({ position: { x: 100, y: 60 } });
  await page.getByRole("group", { name: "Teleop missed shots", exact: true }).getByRole("button", { name: "Increase" }).click();
  await page.getByRole("button", { name: /^Submit/ }).click();
  await expect(page.getByRole("dialog", { name: "Scouting report saved" })).toBeVisible();
  await page.getByRole("button", { name: "Keep scouting" }).click();
  // Simulate two durable local submissions. Reconnection may upload only this
  // unlocked account's record, and only after fresh online authentication.
  await page.evaluate(id => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("hazehub");
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("pendingScouts", "readwrite");
      for (const owner of ["another-scouter"]) tx.objectStore("pendingScouts").put({
        client_uuid: `test-${owner}`, submission_id: `test-${owner}`, owner_id: owner,
        queued_at: Date.now(), sync_status: "queued", event_key: "2026test", match_number: 1,
        team_number: 418, alliance: "red", station: 1, comp_level: "qm", heatmap: [],
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), id);
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Sign in to synchronize" })).toBeVisible();
  expect(state.uploads).toHaveLength(0);
  await page.getByRole("button", { name: "Sign in to synchronize" }).click();
  await signIn(page);
  await expect(page).toHaveURL(/\/home\/?$/);
  await expect.poll(() => state.uploads.length, { timeout: 12000 }).toBe(1);
  expect(state.uploads[0].team_number).toBe(418);
  expect(state.uploads[0].heatmap).toHaveLength(1);
  expect(state.uploads[0].teleop_missed).toBe(1);
  await expect(page.getByText("Offline sign-in · Scouting stays", { exact: false })).toHaveCount(0);
  await page.goto("/account");
  await page.getByRole("button", { name: "Remove offline sign-ins" }).click();
  await expect(page.getByText("Sign in online with your password", { exact: false })).toBeVisible();
  expect(await editStorage(page, "inspect")).toHaveLength(0);
  const retained = await page.evaluate(() => new Promise<any[]>(resolve => {
    const request = indexedDB.open("hazehub");
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction("pendingScouts").objectStore("pendingScouts").getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
    };
  }));
  expect(retained).toHaveLength(2);
  expect(retained.find(row => row.owner_id === "another-scouter").sync_status).toBe("queued");
  expect(retained.find(row => row.owner_id === id).sync_status).toBe("acknowledged");
});

test("preparing a different scouter replaces the previous account verifier", async ({ page, context }) => {
  await installMocks(context);
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL(/\/home\/?$/);
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  const other = "10217861";
  const token = Buffer.from(JSON.stringify({ sub: other, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  await context.route("**/api/auth/login", route => route.fulfill({ json: { token, scout_id: other, role: "scouter", is_admin: false, picklist_only: false, display_name: "Other Scout", bucks: 0 } }));
  await context.route("**/api/auth/offline-provision", route => route.fulfill({ json: { version: 1, scout_id: other, s_number: 2, display_name: "Other Scout", issued_at: Date.now(), expires_at: Date.now() + 86399_000 } }));
  await signIn(page, password, other);
  await expect(page).toHaveURL(/\/home\/?$/);
  const accounts = (await editStorage(page, "inspect")).filter((row: any) => row.id.startsWith("account:"));
  expect(accounts.map((row: any) => row.id)).toEqual([`account:${other}`]);
});

for (const action of ["expire", "tamper", "lost-key", "lock", "clock", "revoked"]) {
  test(`offline sign-in refuses ${action} credentials`, async ({ page, context }) => {
    const { state } = await installMocks(context);
    await page.goto("/login");
    await signIn(page);
    await expect(page).toHaveURL(/\/home\/?$/);
    await editStorage(page, action);
    await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
    await expect(page).toHaveURL(/login/);
    if (action === "revoked") {
      state.revoked = true;
      await signIn(page);
      await expect(page.getByText("Account revoked", { exact: true })).toBeVisible();
      expect((await editStorage(page, "inspect")).filter((r: any) => r.id.startsWith("account:"))).toHaveLength(0);
      await page.reload();
    }
    state.unavailable = true;
    await page.getByLabel("Scouter ID", { exact: true }).fill(id);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (action === "expire" || action === "revoked") {
      await expect(page.getByText("This account needs an online sign-in", { exact: false })).toBeVisible();
    } else {
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByText(action === "tamper" ? "Incorrect password or damaged" : action === "lost-key" ? "This account is not prepared" : "Offline access is locked", { exact: false })).toBeVisible();
    }
    await expect(page).toHaveURL(/login/);
    expect(state.uploads).toHaveLength(0);
  });
}
