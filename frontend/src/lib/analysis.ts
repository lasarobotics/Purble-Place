// Select and present results already calculated by the cloud. This module
// deliberately contains no scoring, averaging, regression, or rate formulas.
import { localAdmin } from "./identity";
export function isAnalysisPath(path: string): boolean {
  const url = new URL(path, "http://local");
  return /^\/api\/admin\/(metrics|event-teams|rank|compare|data-analysis|data-picklist|disagreements)$/.test(url.pathname) ||
    /^\/api\/admin\/team\/\d+\/(summary|heatmap|reports)$/.test(url.pathname) ||
    (localAdmin() && /^\/api\/teams\/\d+\/scouting$/.test(url.pathname));
}

export function selectAnalysis(bundle: any, path: string): any {
  const url = new URL(path, "http://local");
  const name = url.pathname.split("/").pop();
  if (name === "scouting") {
    const record = bundle.scouting[url.pathname.split("/")[3]];
    if (!record) throw new Error("Team is not in the saved event analysis");
    return record;
  }
  if (name === "data-analysis") return { teams: bundle.analysis };
  if (name === "metrics") return { metrics: bundle.metrics };
  if (name === "event-teams") return bundle.teams.map((t: any) => t.team);
  if (name === "data-picklist") return bundle.picklist;
  if (name === "disagreements") return bundle.consensus;
  if (name === "rank") {
    const metric = url.searchParams.get("metric") || "avg_points";
    const byTeam = new Map(bundle.teams.map((t: any) => [t.team, t]));
    return { metric, teams: (bundle.orders[metric] || bundle.orders.avg_points).map((team: number, i: number) => ({ ...byTeam.get(team) as any, rank: i + 1 })) };
  }
  if (name === "compare") {
    const selected = new Set((url.searchParams.get("teams") || "").split(",").map(Number).slice(0, 6));
    const teams = bundle.teams.filter((t: any) => selected.has(t.team));
    return { teams, metrics: bundle.metrics.map((metric: any) => {
      // Cloud ordering chooses the best selected team; equality also highlights ties.
      const first = bundle.orders[metric.key].find((team: number) => selected.has(team));
      const best = teams.find((t: any) => t.team === first)?.[metric.key];
      return { ...metric, values: teams.map((t: any) => ({ team: t.team, value: t[metric.key], best: best != null && t[metric.key] === best })) };
    }) };
  }
  const team = url.pathname.split("/")[4];
  const record = bundle.scouting[team];
  if (!record) throw new Error("Team is not in the saved event analysis");
  if (name === "summary") return record.summary;
  if (name === "reports") return record.reports;
  return record.heatmaps[url.searchParams.get("phase") || "all"];
}
