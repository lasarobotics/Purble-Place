export type PitRow = { team: number; [key: string]: string | number };
export type PitsBoard = { rotations: PitRow[]; matches: PitRow[]; updated_at: string | null };
export type PitsConfig = { url: string; rotations_tab: string; matches_tab: string; rotation_columns: Record<string, string>; match_columns: Record<string, string> };
export const defaultPitsConfig: PitsConfig = {
  url: "", rotations_tab: "Pit rotations", matches_tab: "Match schedule",
  rotation_columns: { team: "Team", time: "Time window", lead: "Pit lead", mechanical: "Mechanical", electrical: "Electrical", runner: "Runner", driver: "Driver", handoff: "Focus / handoff" },
  match_columns: { team: "Team", match: "Match", queue: "Queue by", field: "On field", station: "Station", partners: "Partners" },
};
