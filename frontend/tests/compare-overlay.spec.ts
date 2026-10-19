import { test, expect } from "@playwright/test";

test("compare overlays up to six colored team heatmaps and filters phase and station", async ({ page }) => {
  const token =
    Buffer.from(JSON.stringify({ sub: "Admin", admin: true, auth_version: 2, exp: 9999999999 })).toString("base64url") +
    ".test";
  const session = {
    token,
    scout_id: "Admin",
    role: "admin",
    is_admin: true,
    picklist_only: false,
    display_name: "Administrator",
    bucks: 100,
  };
  await page.addInitScript((value) => {
    localStorage.setItem("hazehub.token", value.token);
    localStorage.setItem("hazehub.session", JSON.stringify(value));
  }, session);

  const points = (offset: number) => [
    { x: 0.2 + offset, y: 0.3, phase: "auto", result: "made", alliance: "red", station: 1 },
    { x: 0.25 + offset, y: 0.4, phase: "teleop", result: "missed", alliance: "blue", station: 2 },
  ];
  const teamNums = [418, 436, 254, 1678, 2056, 1114];
  const teams = teamNums.map((team, index) => ({
    team,
    team_number: team,
    nickname: `Team ${team}`,
    matches: 2,
    avg_points: 50 - index * 4,
  }));
  const bundle = {
    teams,
    profiles: teams,
    metrics: [{ key: "avg_points", label: "Haze Power Rating", better: "high" }],
    orders: { avg_points: teamNums },
    scouting: Object.fromEntries(
      teams.map((team, index) => {
        const heat = { team: team.team, points: points(index * 0.05), total: 2, made: 1, accuracy: 0.5 };
        return [String(team.team), { summary: team, reports: [], heatmap: heat, heatmaps: { all: heat, auto: heat, teleop: heat } }];
      })
    ),
    analysis: [],
    picklist: { teams: [] },
    consensus: { teams: [] },
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: session });
    if (path === "/api/admin/analysis") return route.fulfill({ json: bundle });
    if (path === "/api/admin/event-teams") return route.fulfill({ json: teamNums });
    if (path === "/api/teams/batch") return route.fulfill({ json: teams });
    if (path === "/api/admin/compare") return route.fulfill({ json: { teams, metrics: [] } });
    const heatTeam = path.match(/^\/api\/admin\/team\/(\d+)\/heatmap$/)?.[1];
    if (heatTeam) return route.fulfill({ json: bundle.scouting[heatTeam].heatmap });
    if (path === "/api/events") return route.fulfill({ json: { events: [] } });
    if (path === "/api/matches") return route.fulfill({ json: { matches: [] } });
    if (path === "/api/betting/mine") return route.fulfill({ json: { bucks: 100, bets: [] } });
    return route.fulfill({ json: [] });
  });

  await page.goto("/admin/compare");
  for (let i = 0; i < teamNums.length; i++) {
    await page.getByLabel(i < 2 ? `Robot ${i + 1}` : `Robot ${i + 1} (optional)`).selectOption(String(teamNums[i]));
  }

  await expect(page.getByRole("heading", { name: "Heatmap Overlay" })).toBeVisible();
  await expect(page.getByText("Up to 6 teams")).toBeVisible();
  await expect(page.locator(".overlay-team-toggle.on")).toHaveCount(6);
  await expect(page.locator(".overlay-field circle")).toHaveCount(12);

  const overlay = page.locator(".overlay-heatmap");
  await overlay.getByRole("button", { name: "Auto", exact: true }).click();
  await expect(page.locator(".overlay-field circle")).toHaveCount(6);

  await page.getByLabel("Overlay driver station").selectOption("blue2");
  await expect(page.locator(".overlay-field circle")).toHaveCount(0);

  await overlay.getByRole("button", { name: "Teleop", exact: true }).click();
  await expect(page.locator(".overlay-field circle")).toHaveCount(6);
});
