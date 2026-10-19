import { test, expect } from "@playwright/test";

test.use({ baseURL: "http://localhost:3157", serviceWorkers: "block" });

for (const failure of ["endpoint401", "outage", "revoked"] as const) {
  test(`Data Analysis handles ${failure} without losing a valid session`, async ({ page, context }) => {
    const token = Buffer.from(JSON.stringify({ sub: "Admin", admin: true, auth_version: 2, exp: 9999999999 })).toString("base64url") + ".test";
    const session = { token, scout_id: "Admin", is_admin: true, role: "admin", picklist_only: false, display_name: "Admin", bucks: 100 };
    let analysisCalls = 0, meCalls = 0, recovered = false;
    await context.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me") {
        meCalls++;
        return route.fulfill(failure === "revoked" && analysisCalls > 0
          ? { status: 401, json: { detail: "Credentials changed" } } : { json: session });
      }
      if (path === "/api/admin/data-analysis") {
        analysisCalls++;
        if (!recovered && (failure !== "endpoint401" || analysisCalls === 1))
          return route.fulfill({ status: failure === "outage" ? 503 : 401, json: { detail: "Unavailable" } });
        return route.fulfill({ json: { teams: [{ team: 418, nickname: "Purple Haze", matches: 3, consistency: .8, failure_rate: 0 }] } });
      }
      if (path === "/api/admin/metrics") return route.fulfill({ json: { metrics: [] } });
      if (path === "/api/admin/rank") return route.fulfill({ json: { teams: [] } });
      return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    });
    await page.goto("/admin/team-rank");
    if (failure === "revoked") {
      await expect(page).toHaveURL(/login/);
      expect(meCalls).toBeGreaterThan(1);
      return;
    }
    await page.getByRole("button", { name: "Data Analysis", exact: true }).click();
    if (failure === "outage") {
      await expect(page.getByRole("alert").filter({ hasText: "could not refresh" })).toBeVisible();
      recovered = true;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
    }
    await expect(page.getByText("418", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/admin\/team-rank/);
    if (failure === "endpoint401") expect(meCalls).toBeGreaterThan(1);
    // A full document navigation restores the session from the server.
    await page.reload();
    await page.getByRole("button", { name: "Data Analysis", exact: true }).click();
    await expect(page.getByText("418", { exact: true })).toBeVisible();
  });
}
