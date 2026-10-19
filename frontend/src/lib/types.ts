export type Role = "scouter" | "strategy" | "admin" | "picklist";

export interface Session {
  name_confirmed?: boolean;
  offline_until?: number;
  s_number?: number;
  token: string;
  scout_id: string;
  role: Role;
  /** True for strategy and admin. Kept as the shorthand most screens use. */
  is_admin: boolean;
  /** Picklist meeting account: picklists and team data only. */
  picklist_only: boolean;
  display_name: string;
  bucks: number;
}

export const ROLE_LABEL: Record<Role, string> = {
  scouter: "Scouter",
  strategy: "Strategy",
  admin: "Admin",
  picklist: "Picklist Meeting",
};

export interface HeatPoint {
  x: number; // 0..1
  y: number; // 0..1
  phase: "auto" | "teleop";
  result: "made" | "missed";
  value?: number;
  match?: number;
  /** Where the robot started. Set on aggregated heatmaps so the map can be
   *  split by driver station, which is what tells a near-side-only scorer
   *  apart from one that scores from anywhere. */
  alliance?: "red" | "blue";
  station?: number;
}

export interface ScoutEntry {
  season_id?: string;
  game_version?: number;
  id?: number;
  client_uuid?: string;
  submission_id?: string;
  client_ts?: string;
  payload_hash?: string;
  schema_version?: number;
  supersedes_submission_id?: string | null;
  azure_received_at?: string | null;
  cloud_status?: "queued" | "synced" | "failed";
  event_key?: string;
  match_number: number;
  comp_level: string;
  team_number: number;
  alliance: "red" | "blue";
  station: number;
  auto_leave: boolean;
  auto_climb: boolean;
  heatmap: HeatPoint[];
  auto_missed?: number;
  teleop_missed?: number;
  climb: string;
  climb_seconds?: number | null;
  tags: string[];
  played_defense: boolean;
  defense_rating: number;
  defense_on: string;
  successful_stops: number;
  driver_skill: number;
  speed_rating: number;
  fouls: number;
  failure: boolean;
  failure_details: string;
  no_show: boolean;
  notes: string;
  points?: number;
  created_at?: string;
}

/** A pit report: one per team per event. */
export interface PitEntry {
  team_number: number;
  drivetrain?: string;
  archetype?: string;
  weight_lbs?: number | null;
  width_in?: number | null;
  length_in?: number | null;
  can_climb?: string;
  auto_routine?: string;
  capabilities?: string[];
  robot_photo?: string;
  robot_photos?: string[];
  photo_count?: number;
  has_photo?: boolean;
  notes?: string;
  /** Answers to questions the pit form asks that have no column of their own. */
  responses?: Record<string, any>;
  /** Which version of the pit form produced this report. */
  form_version?: number;
  scout_id?: string;
  updated_at?: string;
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
  /** Plain-language reason betting is closed, empty when it is open. */
  lock_reason?: string;
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
  team_num?: number;
  rank?: number;
  tier?: string;
  /** Why this team is ranked here. note, comments and justification are the
   *  same value under three names, kept in step by the server. */
  note?: string;
  comments?: string;
  justification?: string;
}

/** 1 = first pick, 2 = second pick. A user may keep any number of each. */
export type PickRound = 1 | 2;

export interface Picklist {
  id: number;
  event_key: string;
  owner_id: string;
  owner_name: string;
  owner_role: Role | "master";
  /** 0 master, 1 strategy and admin, 2 scouter. Lower shows first. */
  priority: number;
  name: string;
  is_master: boolean;
  pick_round: PickRound;
  workspace_id?: string;
  robot_number?: number;
  robot_name?: string;
  items: PicklistItem[];
  updated_at: string;
}

/** One scouting report as the server returns it, used by the @match
 *  references inside picklist notes. */
export interface MatchReport extends ScoutEntry {
  scout_id?: string;
}

export interface MeetingPicklists {
  event: string;
  master: Picklist[];
  strategy: Picklist[];
  scouter: Picklist[];
}

export interface InsightBullet {
  text: string;
  evidence: string;
}

export interface TeamInsight {
  team: number;
  event: string;
  generated_at: string;
  matches: number;
  headline: string;
  role: string;
  verdict: "first-pick" | "second-pick" | "third-pick" | "avoid" | "unknown";
  strengths: InsightBullet[];
  concerns: InsightBullet[];
  watch: string[];
  source: "rules" | "claude";
}

export interface DisagreementConflict {
  match: number;
  comp_level?: string;
  spread: number;
  reports: { scout_id: string; points: number }[];
}

export interface DisagreementRow {
  team: number;
  nickname: string;
  avatar?: string;
  matches: number;
  avg_points: number | null;
  quant_pct: number;
  qual_pct: number;
  gap: number;
  max_spread: number;
  conflicts: DisagreementConflict[];
  score: number;
  flags: string[];
}

export interface TeamSummary {
  scoring_benchmark?: { team: number | null; avg_points: number | null };
  relative_scoring?: number | null;
  team: number;
  nickname: string;
  avatar?: string;
  epa?: number | null;
  matches: number;
  avg_points: number | null;
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
  match_points: { match: number; comp_level?: string; points: number }[];
  accuracy?: number | null;
  auto_accuracy?: number | null;
  teleop_accuracy?: number | null;
  avg_auto_points?: number | null;
  avg_teleop_points?: number | null;
  avg_endgame_points?: number | null;
  median_points?: number | null;
  recent_points?: number | null;
  trend?: number | null;
  attendance_rate?: number | null;
  operational_rate?: number | null;
  auto_leave_rate?: number | null;
  avg_fouls?: number | null;
  avg_stops?: number | null;
  tags?: { tag: string; count: number }[];
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
export interface PicklistRecord extends Picklist {
  status: "Draft" | "Submitted" | "Final" | "Archived";
  version: number;
  source_id?: number;
  latest?: boolean;
  created_at: string;
  submitted_at?: string;
  submission_number?: number;
}
export interface MeetingRobot { team_number: number; name: string; custom?: boolean }
export interface PicklistMeetingState {
  event_key: string;
  session_id?: string;
  presenter?: string | null;
  version: number;
  status: "not_started" | "live" | "paused" | "ended";
  locked: boolean;
  view: "first" | "second" | "both";
  selected_team: number | null;
  active_robot: number;
  robots: MeetingRobot[];
  presentation: { type: "none" | "team" | "analysis" | "comparison" | "reference"; team: number | null; comparison_ids: number[]; match?: number | "all"; field?: string };
  boards: Picklist[];
  notes: Record<string, string>;
  team_statuses: Record<string, string>;
  published: { boards: Picklist[]; published_at: string; by: string } | null;
  updated_at: string;
  viewers: number;
  can_undo: boolean;
  can_redo: boolean;
}
