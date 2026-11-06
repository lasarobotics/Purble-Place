export type PitRow = { team: number; [key: string]: string | number };
export type PitsBoard = { rotations: PitRow[]; matches: PitRow[]; updated_at: string | null };
export type PitsConfig = { url: string; rotations_tab: string; matches_tab: string; rotation_columns: Record<string, string>; match_columns: Record<string, string> };
export const defaultPitsConfig: PitsConfig = {
  url: "", rotations_tab: "Pit rotations", matches_tab: "",
  rotation_columns: { team: "Team", time: "Time window", lead: "LEAD", slot1: "1", slot2: "2", slot3: "3", slot4: "4", slot5: "5" },
  match_columns: { team: "Team", match: "Match", queue: "Queue by", field: "On field", station: "Station", partners: "Partners" },
};
