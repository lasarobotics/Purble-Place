require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const express = require("express");

const app = express();

const PORT = Number(process.env.PORT || 4000);
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || "purplerain";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173";
const TBA_BASE_URL = process.env.TBA_BASE_URL || "https://www.thebluealliance.com/api/v3";
const TBA_AUTH_KEY = process.env.TBA_AUTH_KEY || "";
const STATBOTICS_BASE_URL = process.env.STATBOTICS_BASE_URL || "https://api.statbotics.io/v3";
const SEASON = Number(process.env.SEASON || 2026);
const DEFAULT_EVENT_KEY = process.env.TBA_EVENT_KEY || "";

const STATE_DIR = path.join(__dirname, "state");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const CACHE_TTL_MS = 1000 * 60 * 4;
const VALID_STATIONS = new Set(["red1", "red2", "red3", "blue1", "blue2", "blue3"]);
const VALID_BET_SIDES = new Set(["red", "blue", "tie"]);

app.use(
  cors({
    origin(origin, callback) {
      const allowed = new Set([
        CLIENT_ORIGIN,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]);
      if (!origin || allowed.has(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed`));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));

let state = loadState();
const cache = new Map();

function loadState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) {
    const initial = {
      reports: [],
      picklists: [],
      accounts: {},
      bets: [],
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { reports: [], picklists: [], accounts: {}, bets: [] };
  }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function id() {
  return crypto.randomUUID();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanEventKey(value) {
  return String(value || DEFAULT_EVENT_KEY || "").trim().toLowerCase();
}

function parseTeamKey(teamKey) {
  return Number(String(teamKey || "").replace("frc", ""));
}

function normalizeStation(value) {
  const station = String(value || "").trim().toLowerCase();
  return VALID_STATIONS.has(station) ? station : "";
}

function teamForStation(match, station) {
  const alliance = station.startsWith("red") ? "red" : "blue";
  const index = Number(station.slice(-1)) - 1;
  return match?.[alliance]?.[index] || null;
}

function getAccount(scoutName) {
  const key = String(scoutName || "").trim();
  if (!key) return null;
  if (!state.accounts[key]) {
    state.accounts[key] = {
      balance: 1000,
      createdAt: new Date().toISOString(),
    };
    saveState();
  }
  return state.accounts[key];
}

async function cached(key, loader, ttl = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await loader();
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }
  return response.json();
}

async function tbaGet(pathname) {
  if (!TBA_AUTH_KEY) {
    throw new Error("Missing TBA_AUTH_KEY in .env");
  }
  return fetchJson(`${TBA_BASE_URL}${pathname}`, {
    headers: {
      accept: "application/json",
      "X-TBA-Auth-Key": TBA_AUTH_KEY,
    },
  });
}

async function statboticsTeamYear(teamNumber) {
  return cached(`statbotics:${teamNumber}:${SEASON}`, async () => {
    try {
      return await fetchJson(`${STATBOTICS_BASE_URL}/team_year/${teamNumber}/${SEASON}`, {
        headers: { accept: "application/json" },
      });
    } catch {
      return null;
    }
  }, 1000 * 60 * 30);
}

function epaFromStatbotics(payload) {
  const epa = payload?.epa || {};
  const total = Number(epa?.total_points?.mean ?? epa?.mean ?? payload?.norm_epa ?? 0);
  const auto = Number(epa?.auto_points?.mean ?? total * 0.28);
  const teleop = Number(epa?.teleop_points?.mean ?? total * 0.58);
  const endgame = Number(epa?.endgame_points?.mean ?? total * 0.14);
  return {
    total: Number.isFinite(total) ? total : 0,
    auto: Number.isFinite(auto) ? auto : 0,
    teleop: Number.isFinite(teleop) ? teleop : 0,
    endgame: Number.isFinite(endgame) ? endgame : 0,
  };
}

async function getEventTeams(eventKey) {
  return cached(`tba:teams:${eventKey}`, async () => {
    const teams = await tbaGet(`/event/${eventKey}/teams/simple`);
    return teams
      .map((team) => ({
        number: Number(team.team_number),
        name: team.nickname || team.name || `Team ${team.team_number}`,
        city: team.city || "",
        stateProv: team.state_prov || "",
        country: team.country || "",
      }))
      .sort((a, b) => a.number - b.number);
  });
}

async function getEventMatches(eventKey) {
  return cached(`tba:matches:${eventKey}`, async () => {
    const matches = await tbaGet(`/event/${eventKey}/matches`);
    return matches
      .map(transformMatch)
      .filter((match) => match.red.length === 3 && match.blue.length === 3)
      .sort((a, b) => a.order - b.order);
  });
}

function transformMatch(match) {
  const video = Array.isArray(match.videos)
    ? match.videos.find((item) => item.type === "youtube" && item.key)
    : null;
  const redScore = match.alliances?.red?.score ?? null;
  const blueScore = match.alliances?.blue?.score ?? null;
  const hasScore = Number.isFinite(redScore) && Number.isFinite(blueScore) && redScore >= 0 && blueScore >= 0;
  const winner = hasScore && redScore === blueScore ? "tie" : match.winning_alliance || "";

  return {
    id: match.key,
    key: match.key,
    label: `${labelForLevel(match.comp_level)} ${match.match_number}`,
    matchNumber: Number(match.match_number),
    setNumber: Number(match.set_number || 1),
    compLevel: match.comp_level,
    order: matchSortOrder(match),
    red: (match.alliances?.red?.team_keys || []).map(parseTeamKey),
    blue: (match.alliances?.blue?.team_keys || []).map(parseTeamKey),
    redScore,
    blueScore,
    winner: winner || null,
    played: Boolean(hasScore && winner),
    video: video ? `https://www.youtube.com/embed/${video.key}` : "",
    youtubeUrl: video ? `https://www.youtube.com/watch?v=${video.key}` : "",
    predictedTime: match.predicted_time || match.time || null,
    events: [],
    summary: hasScore
      ? `Final score ${redScore}-${blueScore}. Winner: ${winner || "unknown"}.`
      : "Match has not posted official TBA results yet.",
  };
}

function labelForLevel(level) {
  return {
    qm: "Qualification",
    ef: "Octofinal",
    qf: "Quarterfinal",
    sf: "Semifinal",
    f: "Final",
  }[level] || String(level || "Match").toUpperCase();
}

function matchSortOrder(match) {
  const level = { qm: 1, ef: 2, qf: 3, sf: 4, f: 5 }[match.comp_level] || 9;
  return level * 10000 + Number(match.set_number || 0) * 1000 + Number(match.match_number || 0);
}

async function getTeamProfiles(eventKey) {
  const tbaTeams = await getEventTeams(eventKey);
  const statRows = await Promise.all(
    tbaTeams.map(async (team) => ({
      team,
      stats: await statboticsTeamYear(team.number),
    })),
  );

  return statRows.map(({ team, stats }) => {
    const epa = epaFromStatbotics(stats);
    return {
      number: team.number,
      name: team.name,
      city: team.city,
      stateProv: team.stateProv,
      epa,
      efficiency: clamp(Math.round(48 + epa.total * 1.7), 1, 99),
      reliability: clamp(Math.round(68 + epa.total * 0.75), 1, 99),
      auto: clamp(Math.round(50 + epa.auto * 3.2), 1, 99),
      teleop: clamp(Math.round(50 + epa.teleop * 1.9), 1, 99),
      defense: 50,
      trend: 0,
      tags: tagsForTeam(epa),
      notes: `Statbotics ${SEASON} EPA: ${epa.total.toFixed(1)} total points.`,
    };
  });
}

function tagsForTeam(epa) {
  const tags = [];
  if (epa.total >= 25) tags.push("high EPA");
  if (epa.auto >= 6) tags.push("auto value");
  if (epa.teleop >= 16) tags.push("teleop output");
  if (epa.endgame >= 4) tags.push("endgame value");
  return tags.length ? tags : ["needs scout data"];
}

function reportsForEvent(eventKey) {
  return state.reports
    .filter((report) => report.eventKey === eventKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function picklistsForEvent(eventKey) {
  return state.picklists.filter((list) => list.eventKey === eventKey);
}

function rankedTeams(teams, reports, picklists) {
  const picklistAverage = new Map();
  for (const team of teams) {
    const positions = picklists
      .map((list) => list.rankings.indexOf(team.number))
      .filter((index) => index >= 0)
      .map((index) => index + 1);
    picklistAverage.set(
      team.number,
      positions.length ? Number((positions.reduce((sum, rank) => sum + rank, 0) / positions.length).toFixed(1)) : null,
    );
  }

  return teams
    .map((team) => {
      const teamReports = reports.filter((report) => report.team === team.number);
      const reportBoost = teamReports.reduce(
        (sum, report) => sum + Number(report.reliability) + Number(report.defenseResistance),
        0,
      );
      const defense = teamReports.length
        ? Math.round(
            teamReports.reduce((sum, report) => sum + Number(report.defenseResistance), 0) / teamReports.length * 10,
          )
        : team.defense;
      const score = Math.round(
        team.efficiency * 0.4 +
          team.reliability * 0.28 +
          team.teleop * 0.16 +
          team.auto * 0.1 +
          defense * 0.04 +
          reportBoost * 0.18,
      );
      return { ...team, defense, score, picklistAverage: picklistAverage.get(team.number) };
    })
    .sort((a, b) => b.score - a.score);
}

function aiInsight(teams, reports) {
  if (!teams.length) {
    return {
      headline: "Choose a TBA event key to load live matches and teams.",
      bullets: [
        "Use an event key like 2026txcmp once the event exists on TBA.",
        "Scouting is locked to the selected alliance station.",
        "Betting markets price red/blue/tie from Statbotics EPA and settle from TBA scores.",
      ],
    };
  }

  const top = teams[0];
  const watched = reports.find((report) => report.team === top.number);
  const riser = teams.slice().sort((a, b) => b.epa.total - a.epa.total)[0];
  return {
    headline: `${top.number} ${top.name} is the current highest combined profile.`,
    bullets: [
      `${top.name} has ${top.efficiency}% derived efficiency and ${top.reliability}% derived reliability from ${SEASON} EPA.`,
      `${riser.number} ${riser.name} leads raw Statbotics EPA at ${riser.epa.total.toFixed(1)} points.`,
      watched
        ? `Latest scout note on ${top.number}: ${watched.note}`
        : "Add qualitative reports to validate EPA against event-specific match context.",
    ],
  };
}

function probabilityFromEpa(redEpa, blueEpa) {
  const redRaw = 1 / (1 + Math.exp(-(redEpa - blueEpa) / 12));
  const red = clamp(redRaw * 0.96, 0.05, 0.93);
  const blue = clamp((1 - redRaw) * 0.96, 0.05, 0.93);
  const tie = 0.04;
  const total = red + blue + tie;
  return {
    red: Number((red / total).toFixed(3)),
    blue: Number((blue / total).toFixed(3)),
    tie: Number((tie / total).toFixed(3)),
  };
}

function buildMarkets(matches, teams) {
  const teamByNumber = new Map(teams.map((team) => [team.number, team]));
  return matches.map((match) => {
    const redEpa = match.red.reduce((sum, teamNumber) => sum + (teamByNumber.get(teamNumber)?.epa.total || 0), 0);
    const blueEpa = match.blue.reduce((sum, teamNumber) => sum + (teamByNumber.get(teamNumber)?.epa.total || 0), 0);
    const prices = match.played
      ? {
          red: match.winner === "red" ? 1 : 0.01,
          blue: match.winner === "blue" ? 1 : 0.01,
          tie: match.winner === "tie" ? 1 : 0.01,
        }
      : probabilityFromEpa(redEpa, blueEpa);
    return {
      matchId: match.id,
      label: match.label,
      red: match.red,
      blue: match.blue,
      redEpa: Number(redEpa.toFixed(1)),
      blueEpa: Number(blueEpa.toFixed(1)),
      prices,
      played: match.played,
      winner: match.winner,
    };
  });
}

function settleOpenBets(eventKey, matches) {
  let changed = false;
  const matchById = new Map(matches.map((match) => [match.id, match]));
  for (const bet of state.bets) {
    if (bet.eventKey !== eventKey || bet.status !== "open") continue;
    const match = matchById.get(bet.matchId);
    if (!match?.played || !match.winner) continue;
    bet.status = "settled";
    bet.settledAt = new Date().toISOString();
    bet.winner = match.winner;
    bet.payout = bet.side === match.winner ? Number(bet.shares.toFixed(2)) : 0;
    const account = getAccount(bet.scout);
    if (account) account.balance = Number((account.balance + bet.payout).toFixed(2));
    changed = true;
  }
  if (changed) saveState();
}

async function loadDashboard(eventKey) {
  if (!eventKey) {
    return {
      eventKey: "",
      needsEvent: true,
      teams: [],
      matches: [],
      picklists: [],
      reports: [],
      markets: [],
      bets: [],
      accounts: state.accounts,
      insight: aiInsight([], []),
    };
  }

  const [matches, teamProfiles] = await Promise.all([getEventMatches(eventKey), getTeamProfiles(eventKey)]);
  settleOpenBets(eventKey, matches);
  const reports = reportsForEvent(eventKey);
  const picklists = picklistsForEvent(eventKey);
  const teams = rankedTeams(teamProfiles, reports, picklists);
  const markets = buildMarkets(matches, teams);
  return {
    eventKey,
    needsEvent: false,
    season: SEASON,
    teams,
    matches,
    picklists,
    reports,
    markets,
    bets: state.bets.filter((bet) => bet.eventKey === eventKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    accounts: state.accounts,
    insight: aiInsight(teams, reports),
  };
}

function sendValidation(res, message, details = {}) {
  return res.status(400).json({ message, ...details });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    tbaConfigured: Boolean(TBA_AUTH_KEY),
    defaultEventKey: DEFAULT_EVENT_KEY,
    season: SEASON,
  });
});

app.post("/api/login", (req, res) => {
  const { firstName, lastName, password } = req.body;
  const cleanFirst = String(firstName || "").trim();
  const cleanLast = String(lastName || "").trim();
  if (!cleanFirst || !cleanLast || password !== TEAM_PASSWORD) {
    return res.status(401).json({ message: "Invalid scout credentials" });
  }

  const name = `${cleanFirst} ${cleanLast}`;
  const account = getAccount(name);
  res.json({
    scout: {
      name,
      initials: `${cleanFirst[0] || ""}${cleanLast[0] || ""}`.toUpperCase(),
      balance: account.balance,
    },
  });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const eventKey = cleanEventKey(req.query.eventKey);
    res.json(await loadDashboard(eventKey));
  } catch (error) {
    res.status(502).json({
      message: "Unable to load event data",
      detail: error.message,
    });
  }
});

app.post("/api/reports", async (req, res) => {
  try {
    const eventKey = cleanEventKey(req.body.eventKey);
    const { scout, matchId, station, cycleCount, reliability, defenseResistance, note } = req.body;
    const cleanScout = String(scout || "").trim();
    const cleanStation = normalizeStation(station);
    const cleanNote = String(note || "").trim();
    if (!eventKey) return sendValidation(res, "Choose an event before scouting.");
    if (!cleanScout) return sendValidation(res, "Scout name is required.");
    if (!matchId) return sendValidation(res, "Match is required.");
    if (!cleanStation) return sendValidation(res, "Choose red1-red3 or blue1-blue3.");
    if (cleanNote.length < 8) return sendValidation(res, "Write a useful note with at least 8 characters.");

    const matches = await getEventMatches(eventKey);
    const match = matches.find((item) => item.id === matchId);
    if (!match) return sendValidation(res, "Selected match was not found on TBA.");
    const expectedTeam = teamForStation(match, cleanStation);
    if (!expectedTeam) return sendValidation(res, "That station is not assigned for this match.");

    const duplicate = state.reports.find(
      (report) =>
        report.eventKey === eventKey &&
        report.matchId === matchId &&
        report.station === cleanStation &&
        report.scout === cleanScout,
    );
    if (duplicate) {
      return res.status(409).json({ message: "You already submitted this station for this match." });
    }

    const report = {
      id: id(),
      eventKey,
      scout: cleanScout,
      matchId,
      station: cleanStation,
      alliance: cleanStation.startsWith("red") ? "red" : "blue",
      team: expectedTeam,
      cycleCount: clamp(Number(cycleCount), 0, 40),
      reliability: clamp(Number(reliability), 1, 10),
      defenseResistance: clamp(Number(defenseResistance), 1, 10),
      note: cleanNote.slice(0, 400),
      createdAt: new Date().toISOString(),
    };
    state.reports.unshift(report);
    saveState();
    const dashboard = await loadDashboard(eventKey);
    res.status(201).json({ report, ...dashboard });
  } catch (error) {
    res.status(502).json({ message: "Report was not saved", detail: error.message });
  }
});

app.put("/api/picklists/:scout", async (req, res) => {
  try {
    const eventKey = cleanEventKey(req.body.eventKey);
    const scout = String(req.params.scout || "").trim();
    const { rankings } = req.body;
    if (!eventKey) return sendValidation(res, "Choose an event before editing a picklist.");
    if (!scout) return sendValidation(res, "Scout name is required.");
    if (!Array.isArray(rankings)) return sendValidation(res, "rankings must be an array");

    const teams = await getTeamProfiles(eventKey);
    const validTeams = new Set(teams.map((team) => team.number));
    const normalized = [...new Set(rankings.map(Number).filter((team) => validTeams.has(team)))];
    const existing = state.picklists.find((list) => list.eventKey === eventKey && list.scout === scout);
    if (existing) {
      existing.rankings = normalized;
      existing.updatedAt = new Date().toISOString();
    } else {
      state.picklists.push({ eventKey, scout, rankings: normalized, updatedAt: new Date().toISOString() });
    }
    saveState();
    res.json(await loadDashboard(eventKey));
  } catch (error) {
    res.status(502).json({ message: "Picklist was not saved", detail: error.message });
  }
});

app.post("/api/bets/place", async (req, res) => {
  try {
    const eventKey = cleanEventKey(req.body.eventKey);
    const scout = String(req.body.scout || "").trim();
    const matchId = String(req.body.matchId || "").trim();
    const side = String(req.body.side || "").toLowerCase();
    const amount = Number(req.body.amount);
    if (!eventKey) return sendValidation(res, "Choose an event before betting.");
    if (!scout) return sendValidation(res, "Scout name is required.");
    if (!matchId) return sendValidation(res, "Match is required.");
    if (!VALID_BET_SIDES.has(side)) return sendValidation(res, "Bet side must be red, blue, or tie.");
    if (!Number.isFinite(amount) || amount < 1) return sendValidation(res, "Bet amount must be at least 1.");

    const dashboard = await loadDashboard(eventKey);
    const market = dashboard.markets.find((item) => item.matchId === matchId);
    if (!market) return sendValidation(res, "Market was not found.");
    if (market.played) return sendValidation(res, "That match is already finalized.");

    const account = getAccount(scout);
    if (!account || account.balance < amount) {
      return sendValidation(res, "Insufficient balance.", { balance: account?.balance || 0 });
    }

    const price = Number(market.prices[side]);
    const shares = Number((amount / clamp(price, 0.01, 1)).toFixed(2));
    account.balance = Number((account.balance - amount).toFixed(2));
    const bet = {
      id: id(),
      eventKey,
      scout,
      matchId,
      matchLabel: market.label,
      side,
      amount,
      price,
      shares,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    state.bets.unshift(bet);
    saveState();
    res.status(201).json(await loadDashboard(eventKey));
  } catch (error) {
    res.status(502).json({ message: "Bet was not placed", detail: error.message });
  }
});

app.post("/api/bets/settle", async (req, res) => {
  try {
    const eventKey = cleanEventKey(req.body.eventKey);
    if (!eventKey) return sendValidation(res, "Choose an event before settling bets.");
    const matches = await getEventMatches(eventKey);
    settleOpenBets(eventKey, matches);
    res.json(await loadDashboard(eventKey));
  } catch (error) {
    res.status(502).json({ message: "Bets were not settled", detail: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Purple Rain scouting API listening on http://127.0.0.1:${PORT}`);
});
