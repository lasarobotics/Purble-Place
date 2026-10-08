// Display metadata only. All metric values are computed by the cloud API.
export const METRICS: Record<string, { label: string; description: string; formula: string; percent?: boolean }> = {};
function metric(key: string, label: string, description: string, formula: string, percent = false) {
  METRICS[key] = { label, description, formula, percent };
}
metric("avg_points", "Avg points", "Mean performance points across attended scouting reports, using the configured scoring proxy.", "Σ report points ÷ attended reports");
metric("matches", "Matches", "Number of attended scouting reports; multiple observers count separately.", "count(attended reports)");
metric("match_points", "Points per match", "Mean performance points reported for each match; multiple scouts of the same match are averaged.", "Σ points reported for that match ÷ attended reports for that match");
metric("max_points", "Peak points", "Highest performance score reported for this team.", "max(report points)");
metric("min_points", "Floor", "Lowest performance score reported for this team.", "min(report points)");
metric("std_points", "Scoring deviation", "Population standard deviation of report scores; lower means less variation.", "σ = √[Σ(points − mean)² / n]");
metric("consistency", "Consistency", "How stable reported scoring is relative to its mean; one report receives 100% and is not strong evidence of consistency.", "max(0, 1 − σ / mean)", true);
metric("climb_rate", "Climb rate", "Share of attended reports with a recorded endgame climb.", "reports with a climb ÷ attended reports", true);
metric("defense_rate", "Defense rate", "Share of attended reports in which the robot played defense.", "defense reports ÷ attended reports", true);
metric("failure_rate", "Failure rate", "Share of attended reports recording a robot failure.", "failure reports ÷ attended reports", true);
metric("avg_driver", "Driver skill", "Average scout-assigned driver rating on a one-to-five scale.", "Σ driver ratings ÷ attended reports");
metric("avg_speed", "Speed", "Average scout-assigned speed rating on a one-to-five scale.", "Σ speed ratings ÷ attended reports");
metric("total_fouls", "Total fouls", "Total fouls recorded across attended reports.", "Σ report fouls");
metric("total_stops", "Defensive stops", "Total successful defensive stops across attended reports.", "Σ successful stops");
metric("epa", "EPA", "Expected Points Added supplied by Statbotics; its external model is not calculated by HazeHub.", "EPA = Statbotics model estimate");
metric("accuracy", "Scoring accuracy", "Share of recorded scoring attempts that were made; unavailable without attempts.", "made attempts ÷ all attempts", true);
metric("attempts", "Attempts", "Number of recorded scoring attempts in the selected phase.", "made attempts + missed attempts");
metric("made", "Made", "Number of successful scoring attempts in the selected phase.", "count(attempts marked made)");
for (const phase of ["auto", "teleop"]) {
  metric(`${phase}_accuracy`, `${phase === "auto" ? "Auto" : "Teleop"} accuracy`, `Share of ${phase} attempts that were made; unavailable without attempts.`, `${phase} made ÷ ${phase} attempts`, true);
  for (const result of ["made", "missed"]) metric(`${phase}_${result}`, `${phase === "auto" ? "Auto" : "Teleop"} ${result}`, `Total ${result} ${phase} attempts across attended reports.`, `Σ ${phase} ${result} attempts`);
}
metric("avg_auto_points", "Avg auto points", "Mean autonomous proxy points, including leave and auto-climb bonuses.", "Σ(auto attempt points + configured leave bonus + configured auto climb bonus) ÷ attended reports");
metric("avg_teleop_points", "Avg teleop points", "Mean teleoperated scoring-attempt points before endgame, defense bonuses, and penalties.", "Σ teleop attempt points ÷ attended reports");
metric("avg_endgame_points", "Avg endgame points", "Mean endgame climb points using each report’s season scoring definition.", "Σ endgame climb points ÷ attended reports");
metric("median_points", "Median points", "Middle report score after sorting; averages the middle pair for an even report count.", "median(report points)");
metric("recent_points", "Recent form", "Average of the latest three observed match means, or all available matches when fewer than three exist.", "Σ latest match means ÷ min(3, observed matches)");
metric("trend", "Scoring trend", "Least-squares scoring change per observed match, using chronological match means; requires two matches.", "Σ[(i − mean i)(pointsᵢ − mean points)] ÷ Σ(i − mean i)²");
metric("attendance_rate", "Attendance rate", "Share of all reports in which the robot showed up.", "attended reports ÷ all reports", true);
metric("operational_rate", "Operational reliability", "Share of all reports with both attendance and no recorded failure.", "attended reports without failure ÷ all reports", true);
metric("auto_leave_rate", "Auto leave rate", "Share of attended reports with a successful autonomous leave.", "reports with auto leave ÷ attended reports", true);
metric("avg_fouls", "Fouls per report", "Mean foul count across attended reports; lower is better.", "Σ fouls ÷ attended reports");
metric("avg_stops", "Stops per report", "Mean successful defensive stops across attended reports.", "Σ successful stops ÷ attended reports");
metric("base", "Base", "Mean reported performance before consistency and schedule adjustments.", "Σ report points ÷ attended reports");
metric("reliability", "Reliab.", "Scoring consistency used by the picklist; this is distinct from operational reliability.", "max(0, 1 − σ / mean)", true);
metric("opp_strength", "Opp EPA", "Mean opponent EPA across the scheduled alliances; missing EPA uses the event mean.", "Σ opponent EPA ÷ opponent appearances");
metric("partner_help", "Partner EPA", "Mean partner EPA across the scheduled alliances, excluding the team itself.", "Σ partner EPA ÷ partner appearances");
metric("sos", "SOS", "Schedule difficulty measured as opponent strength minus partner support.", "mean opponent EPA − mean partner EPA");
metric("sos_adjust", "Sched. Adj", "Schedule difficulty centered across ranked teams and scaled into points; zero when schedule spread is zero.", "0.5 × (base σ or 1) × (SOS − mean SOS) / SOS σ");
metric("true_score", "True Score", "Picklist heuristic combining scoring output, consistency, and schedule difficulty.", "base × (0.65 + 0.35 × consistency) + schedule adjustment");
metric("quant_pct", "Output percentile", "Fraction of other ranked teams with lower average scoring output.", "teams with lower average points ÷ (ranked teams − 1)", true);
metric("qual_pct", "Eye-test percentile", "Percentile of the rating, failure, and tag-based qualitative score.", "teams with lower qualitative score ÷ (ranked teams − 1)", true);
metric("score", "Review score", "Review priority combining scout disagreement and the gap between output and qualitative percentiles.", "0.55 × min(1, spread / max(6, avg points)) + 0.45 × |output percentile − eye-test percentile|");
metric("max_spread", "Max spread", "Largest score difference between scouts observing the same team and match.", "max over matches(max report points − min report points)");

metric("defense_capability", "Defense Capability", "Observed defensive contribution on a 0 to 100 scale. Non-defense and failed reports contribute zero; this is a heuristic, not opponent-adjusted impact.", "100 × Σ[active defense × (0.65 × rating / 5 + 0.35 × stops / (stops + 1))] ÷ attended reports");
metric("skew_distribution", "Skew Distribution", "Adjusted sample skewness of report scores. Positive values indicate a longer high-score tail; requires three reports. s is sample standard deviation.", "n × Σ[(score − mean) / s]³ ÷ [(n − 1)(n − 2)]");
metric("foul_match_rate", "Foul Match Rate", "Share of attended reports with at least one foul.", "reports with fouls > 0 ÷ attended reports", true);
metric("climb_success_rate", "Climb Success Rate", "Share of attended reports with an endgame climb other than none.", "reports with a climb ÷ attended reports", true);
metric("ranking_point_prediction", "Ranking Point Prediction", "Projected total across scheduled qualification matches: actual or projected result points plus fuel and climb bonuses at 90% of configured thresholds. Missing thresholds use event 75th-percentile projected totals; this is a heuristic.", "Σ qualification matches (result RP + fuel bonus + climb bonus)");
for (const key of ["defense_capability", "consistency", "skew_distribution", "failure_rate", "climb_success_rate"]) {
  const base = METRICS[key];
  metric(`l4m_${key}`, `L4M ${base.label}`, `The same measure using reports from the latest four observed matches (or fewer available). ${base.description}`, base.formula, base.percent);
}

const aliases: Record<string, string> = { floor: "min_points", avg: "avg_points", peak: "max_points", driver: "avg_driver", "defense stops": "total_stops", "consist.": "consistency", "statbotics epa": "epa" };
export function metricKey(label: string) {
  return aliases[label.toLowerCase()] || Object.keys(METRICS).find(k => METRICS[k].label.toLowerCase() === label.toLowerCase());
}
