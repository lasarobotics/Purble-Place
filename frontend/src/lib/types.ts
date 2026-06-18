export interface Session {
  token: string;
  scout_id: string;
  is_admin: boolean;
  display_name: string;
  bucks: number;
}

export interface HeatPoint {
  x: number; // 0..1
  y: number; // 0..1
  phase: "auto" | "teleop";
  result: "made" | "missed";
  value?: number;
  match?: number;
}

export interface ScoutEntry {
  id?: number;
  client_uuid?: string;
  event_key?: string;
  match_number: number;
  comp_level: string;
  team_number: number;
  alliance: "red" | "blue";
  station: number;
  auto_leave: boolean;
  auto_climb: boolean;
  heatmap: HeatPoint[];
  climb: string;
  climb_seconds?: number | null;
  played_defense: boolean;
  defense_rating: number;
  defense_on: string;
  successful_stops: number;
  driver_skill: number;
  speed_rating: number;
  fouls: number;
  failure: boolean;
  failure_details: string;
  notes: string;
  points?: number;
  created_at?: string;
}

export interface Team {
  team_number: number;
  nickname: string;
  name?: string;
  city?: string;
  state?: string;
  country?: string;
  avatar?: string;
  photos?: string[];
  epa?: number | null;
}

export interface MatchRec {
  match_key: string;
  event_key: string;
  comp_level: string;
  match_number: number;
  red: number[];
  blue: number[];
  red_score?: number | null;
  blue_score?: number | null;
  winner?: string | null;
  betting_locked: boolean;
  youtube_key: string;
  video_url?: string;
  film_summary?: string;
  film_events?: FilmEvent[];
  predicted_time?: number | null;
  red_teams?: Team[];
  blue_teams?: Team[];
}

export interface FilmEvent {
  time: string;
  team: number | string;
  type: string;
  detail: string;
}

export interface Bet {
  id: number;
  scout_id: string;
  match_key: string;
  match_number: number;
  comp_level: string;
  pick: "red" | "blue";
  wager: number;
  win_prob: number;
  multiplier: number;
  potential_payout: number;
  status: "open" | "won" | "lost" | "refunded";
  payout: number;
  created_at: string;
}

export interface Odds {
  match_key: string;
  match_number: number;
  comp_level: string;
  red: number[];
  blue: number[];
  locked: boolean;
  betting_enabled: boolean;
  source: string;
  red_teams?: Team[];
  blue_teams?: Team[];
  red_odds: { win_prob: number; profit_pct: number; multiplier: number };
  blue_odds: { win_prob: number; profit_pct: number; multiplier: number };
}

export interface LeaderRow {
  rank: number;
  scout_id: string;
  display_name: string;
  bucks: number;
  is_admin: boolean;
  bets: number;
  won: number;
  win_rate: number;
}

export interface PicklistItem {
  team: number;
  tier: "first" | "second" | "third" | "dnp";
  note?: string;
}

export interface Picklist {
  id: number;
  event_key: string;
  owner_id: string;
  owner_name: string;
  name: string;
  is_master: boolean;
  items: PicklistItem[];
  updated_at: string;
}

export interface TeamSummary {
  team: number;
  nickname: string;
  avatar?: string;
  epa?: number | null;
  matches: number;
  avg_points: number;
  max_points: number;
  min_points: number;
  std_points: number;
  consistency: number;
  climb_rate: number;
  defense_rate: number;
  failure_rate: number;
  avg_driver: number;
  avg_speed: number;
  total_fouls: number;
  total_stops: number;
  counts: { auto_made: number; auto_missed: number; teleop_made: number; teleop_missed: number };
  match_points: { match: number; points: number }[];
  rank?: number;
  // data-picklist extras
  true_score?: number;
  base?: number;
  reliability?: number;
  sos?: number;
  sos_adjust?: number;
  opp_strength?: number;
  partner_help?: number;
}
