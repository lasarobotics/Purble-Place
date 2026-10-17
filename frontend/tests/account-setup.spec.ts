import { test, expect } from "@playwright/test";

test("first use opens password confirmation and submits the roster ID", async ({ page }) => {
  await page.route("**/api/auth/account-status", route => route.fulfill({ json: { needs_setup: true } }));
  let setup: any;
  await page.route("**/api/auth/setup", route => {
    setup = route.request().postDataJSON();
    return route.fulfill({ status: 409, json: { detail: "This account is already set up. Sign in instead." } });
  });
  await page.goto("/login");
  await page.getByLabel("Scouter ID", { exact: true }).fill("10217860");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const popup = page.getByRole("dialog");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("THIS SHOULD NOT BE A PASSWORD YOU USE NORMALLY AS WE CAN ACCESS THIS.");
  await page.getByLabel("Create password", { exact: true }).fill("Unique-password-1");
  await page.getByLabel("Retype password", { exact: true }).fill("Different-password");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(popup.getByRole("alert")).toHaveText("Passwords do not match.");
  expect(setup).toBeUndefined();
  await page.getByLabel("Retype password", { exact: true }).fill("Unique-password-1");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(popup.getByRole("alert")).toContainText("already set up");
  expect(setup).toEqual({ scout_id: "10217860", password: "Unique-password-1", password_confirmation: "Unique-password-1" });
});

test("an existing account is prompted for its password without setup", async ({ page }) => {
  await page.route("**/api/auth/account-status", route => route.fulfill({ json: { needs_setup: false } }));
  await page.goto("/login");
  await page.getByLabel("Scouter ID", { exact: true }).fill("Admin");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("members can see other tools but cannot open event control pages", async ({ page }) => {
  const token = Buffer.from(JSON.stringify({ sub: "10217860", admin: false, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: "10217860", role: "scouter", is_admin: false, picklist_only: false, display_name: "Scout", bucks: 100 };
  await page.addInitScript(session => {
    localStorage.setItem("hazehub.token", session.token);
    localStorage.setItem("hazehub.session", JSON.stringify(session));
  }, session);
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: session });
    if (path === "/api/scout/mine") return route.fulfill({ json: [] });
    if (path === "/api/betting/mine") return route.fulfill({ json: { bets: [] } });
    return route.fulfill({ status: 503, json: { detail: "No event in this test" } });
  });
  await page.goto("/account");
  const sidebar = page.locator(".sidebar");
  for (const path of ["team-search", "team-rank", "compare", "picklists", "data-picklist"]) {
    await expect(sidebar.locator(`a[href="/admin/${path}"]`)).toBeVisible();
  }
  for (const path of ["forms", "seasons"]) await expect(sidebar.locator(`a[href="/admin/${path}"]`)).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Dashboard", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "System Health", exact: true })).toHaveCount(0);
  await page.goto("/admin/system");
  await expect(page).toHaveURL(/\/home\/?$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/home\/?$/);
});

test("admin can reset a member password from the Accounts popup", async ({ page }) => {
  const token = Buffer.from(JSON.stringify({ sub: "Admin", admin: true, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
  const session = { token, scout_id: "Admin", role: "admin", is_admin: true, picklist_only: false, display_name: "Administrator", bucks: 100 };
  let submitted: any;
  await page.addInitScript(session => {
    localStorage.setItem("hazehub.token", session.token);
    localStorage.setItem("hazehub.session", JSON.stringify(session));
  }, session);
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: session });
    if (path === "/api/admin/settings") return route.fulfill({ json: { current_event: "", current_match: 0, betting_enabled: true, post_comp_mode: false, season: 2026, environment: "firebase" } });
    if (path === "/api/admin/scouters") return route.fulfill({ json: [{ scout_id: "10217860", display_name: "Scout 10217860", role: "scouter", is_admin: false, bucks: 100, matches_scouted: 0 }] });
    if (path === "/api/matches") return route.fulfill({ json: { matches: [] } });
    if (path === "/api/admin/bets" || path === "/api/admin/archives") return route.fulfill({ json: [] });
    if (path === "/api/admin/event-teams") return route.fulfill({ json: [] });
    if (path === "/api/admin/scouters/password-reset") {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, scout_id: submitted.scout_id } });
    }
    return route.fulfill({ status: 503, json: { detail: "Not needed in this test" } });
  });

  await page.goto("/admin");
  await page.getByRole("button", { name: "Import match schedule CSV" }).click();
  await expect(page.getByRole("dialog")).toContainText("match_number,comp_level,red1,red2,red3,blue1,blue2,blue3");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reset user password", exact: true }).click();
  const popup = page.getByRole("dialog");
  await expect(popup).toContainText("usual create-and-retype-password popup");
  await popup.getByLabel("User ID", { exact: true }).fill("10217860");
  await popup.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(popup).toHaveCount(0);
  expect(submitted).toEqual({ scout_id: "10217860" });
});
