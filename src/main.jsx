import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BadgeDollarSign,
  BarChart3,
  Bot,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Eye,
  Film,
  Lock,
  LogOut,
  MessageSquareText,
  PlayCircle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Target,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000/api";
const tabs = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "reports", label: "Scout", icon: ClipboardList },
  { id: "picklists", label: "Picklists", icon: Users },
  { id: "film", label: "Film", icon: Film },
  { id: "betting", label: "Betting", icon: BadgeDollarSign },
];

function App() {
  const [scout, setScout] = useState(() => readJson("purple-rain-scout"));
  const [eventKey, setEventKey] = useState(() => localStorage.getItem("purple-rain-event") || "");
  const [activeTab, setActiveTab] = useState("overview");
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadDashboard(nextEventKey = eventKey) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/dashboard?eventKey=${encodeURIComponent(nextEventKey)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.message || "Dashboard failed to load");
      setDashboard(data);
      localStorage.setItem("purple-rain-event", nextEventKey);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (scout) loadDashboard(eventKey);
  }, [scout]);

  function handleLogin(nextScout) {
    setScout(nextScout);
    localStorage.setItem("purple-rain-scout", JSON.stringify(nextScout));
  }

  function signOut() {
    setScout(null);
    localStorage.removeItem("purple-rain-scout");
  }

  if (!scout) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">PR</div>
          <div>
            <strong>Purple Rain</strong>
            <span>Strategy console</span>
          </div>
        </div>

        <nav className="nav-stack" aria-label="Primary">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={activeTab === tab.id ? "active" : ""}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={18} /> {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <span>Event</span>
          <strong>{eventKey || "not selected"}</strong>
          <small>{dashboard?.teams?.length || 0} teams loaded</small>
        </div>

        <button className="ghost-button" type="button" onClick={signOut}>
          <LogOut size={17} /> Sign out
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">TBA + Statbotics live event mode</p>
            <h1>Purple Rain picklist command</h1>
          </div>
          <EventSelector
            eventKey={eventKey}
            setEventKey={setEventKey}
            scout={scout}
            dashboard={dashboard}
            loading={loading}
            onLoad={loadDashboard}
          />
        </header>

        {error && <div className="error-banner">{error}</div>}
        {loading && !dashboard ? (
          <div className="loading-state">Loading TBA matches and Statbotics team profiles...</div>
        ) : (
          <section className="tab-stage">
            {!dashboard || dashboard.needsEvent ? (
              <EventEmptyState onPick={(key) => setEventKey(key)} onLoad={loadDashboard} />
            ) : (
              <>
                {activeTab === "overview" && <Overview dashboard={dashboard} />}
                {activeTab === "reports" && (
                  <ReportComposer
                    scout={scout}
                    dashboard={dashboard}
                    onUpdate={(patch) => setDashboard(patch)}
                  />
                )}
                {activeTab === "picklists" && (
                  <Picklists
                    scout={scout}
                    dashboard={dashboard}
                    onUpdate={(patch) => setDashboard(patch)}
                  />
                )}
                {activeTab === "film" && <FilmReview dashboard={dashboard} />}
                {activeTab === "betting" && (
                  <BettingPanel
                    scout={scout}
                    dashboard={dashboard}
                    onUpdate={(patch) => setDashboard(patch)}
                  />
                )}
              </>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function LoginScreen({ onLogin }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", password: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Login failed");
      onLogin(data.scout);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <div className="login-copy">
          <div className="brand-lockup">
            <div className="brand-mark">PR</div>
            <div>
              <strong>Purple Rain</strong>
              <span>FRC strategy suite</span>
            </div>
          </div>
          <h1>Scout login</h1>
          <p>
            Enter your name and the team password to unlock guarded station scouting,
            multiplayer picklists, YouTube film review, and match markets.
          </p>
        </div>

        <form className="login-form" onSubmit={submit}>
          <label>
            First name
            <input
              value={form.firstName}
              onChange={(event) => setForm({ ...form, firstName: event.target.value })}
              autoComplete="given-name"
              required
            />
          </label>
          <label>
            Last name
            <input
              value={form.lastName}
              onChange={(event) => setForm({ ...form, lastName: event.target.value })}
              autoComplete="family-name"
              required
            />
          </label>
          <label>
            Team password
            <input
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={submitting}>
            <Lock size={17} /> {submitting ? "Checking..." : "Enter console"}
          </button>
        </form>
      </section>
    </main>
  );
}

function EventSelector({ eventKey, setEventKey, scout, dashboard, loading, onLoad }) {
  const balance = dashboard?.accounts?.[scout.name]?.balance ?? scout.balance ?? 1000;
  return (
    <div className="event-selector">
      <label>
        TBA event key
        <input
          value={eventKey}
          onChange={(event) => setEventKey(event.target.value.toLowerCase())}
          placeholder="ex: 2026txcmp"
        />
      </label>
      <button className="primary-button" type="button" onClick={() => onLoad(eventKey)} disabled={loading || !eventKey}>
        <RefreshCw size={17} /> Load
      </button>
      <div className="scout-chip">
        <span>{scout.initials}</span>
        <div>
          <strong>{scout.name}</strong>
          <small>${Number(balance).toFixed(2)}</small>
        </div>
      </div>
    </div>
  );
}

function EventEmptyState({ onPick, onLoad }) {
  const examples = ["2026txcmp", "2026txaus", "2026casj"];
  return (
    <div className="empty-event panel">
      <Target size={28} />
      <h2>Choose an event before scouting</h2>
      <p>
        This app no longer uses demo matches. Enter a TBA event key and the backend will load teams,
        schedules, YouTube match videos, and Statbotics EPA.
      </p>
      <div className="example-row">
        {examples.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              onPick(key);
              onLoad(key);
            }}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}

function Overview({ dashboard }) {
  const topTeam = dashboard.teams[0];
  const reportCount = dashboard.reports.length;
  const unplayedMarkets = dashboard.markets.filter((market) => !market.played).length;
  const averageReliability = Math.round(
    dashboard.teams.reduce((sum, team) => sum + team.reliability, 0) / Math.max(dashboard.teams.length, 1),
  );

  return (
    <section className="section-block overview-grid">
      <div className="metric-grid">
        <Metric icon={ShieldCheck} label="Top pick" value={`${topTeam?.number || "-"}`} detail={topTeam?.name || "No teams"} />
        <Metric icon={Activity} label="Avg reliability" value={`${averageReliability}%`} detail="Statbotics-derived" />
        <Metric icon={MessageSquareText} label="Reports" value={reportCount} detail="Guarded station rows" />
        <Metric icon={BadgeDollarSign} label="Markets" value={unplayedMarkets} detail="Open match markets" />
      </div>

      <div className="two-column stage-grid">
        <div className="panel ranking-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">EPA + scout evidence</p>
              <h2>Strategic ranking</h2>
            </div>
            <Search size={19} />
          </div>
          <div className="team-list">
            {dashboard.teams.map((team, index) => (
              <article className="team-row" key={team.number}>
                <span className="rank">{index + 1}</span>
                <div className="team-main">
                  <strong>{team.number} {team.name}</strong>
                  <div className="tag-row">
                    {team.tags.slice(0, 3).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <ScoreBars team={team} />
              </article>
            ))}
          </div>
        </div>

        <div className="panel insight-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">AI-style strategy brief</p>
              <h2>{dashboard.insight.headline}</h2>
            </div>
            <Bot size={20} />
          </div>
          <ul className="insight-list">
            {dashboard.insight.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Metric({ icon: Icon, label, value, detail }) {
  return (
    <article className="metric-card">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ScoreBars({ team }) {
  return (
    <div className="score-bars" aria-label={`${team.name} score profile`}>
      <Meter label="Eff" value={team.efficiency} />
      <Meter label="Rel" value={team.reliability} />
    </div>
  );
}

function Meter({ label, value }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div>
        <i style={{ width: `${value}%` }} />
      </div>
      <b>{value}</b>
    </div>
  );
}

function ReportComposer({ scout, dashboard, onUpdate }) {
  const [form, setForm] = useState({
    matchId: dashboard.matches.find((match) => !match.played)?.id || dashboard.matches[0]?.id || "",
    alliance: "blue",
    station: "blue1",
    cycleCount: 10,
    reliability: 8,
    defenseResistance: 7,
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedMatch = dashboard.matches.find((match) => match.id === form.matchId) || dashboard.matches[0];
  const stationOptions = form.alliance === "red" ? ["red1", "red2", "red3"] : ["blue1", "blue2", "blue3"];
  const assignedTeam = selectedMatch ? selectedMatch[form.alliance]?.[Number(form.station.slice(-1)) - 1] : null;

  useEffect(() => {
    if (!form.station.startsWith(form.alliance)) {
      setForm((current) => ({ ...current, station: `${current.alliance}1` }));
    }
  }, [form.alliance, form.station]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const payload = { ...form, eventKey: dashboard.eventKey, scout: scout.name };
    const response = await fetch(`${API_URL}/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    setSaving(false);
    if (response.ok) {
      onUpdate(data);
      setForm((current) => ({ ...current, note: "" }));
    } else {
      setError(data.message || data.detail || "Report was not saved");
    }
  }

  return (
    <section className="section-block report-stage">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Guarded match observations</p>
          <h2>Submit a station-locked report</h2>
        </div>
        <ShieldAlert size={21} />
      </div>

      <div className="two-column report-grid">
        <form className="panel report-form" onSubmit={submit}>
          <div className="guardrail-banner">
            <ShieldCheck size={18} />
            <span>
              Assignment is locked by match + alliance + station. Blue scouts can only submit blue1-blue3.
            </span>
          </div>
          <label>
            Match
            <select value={form.matchId} onChange={(event) => setForm({ ...form, matchId: event.target.value })}>
              {dashboard.matches.map((match) => (
                <option value={match.id} key={match.id}>
                  {match.label} - R {match.red.join(", ")} vs B {match.blue.join(", ")}
                </option>
              ))}
            </select>
          </label>
          <div className="split-fields">
            <label>
              Alliance
              <select
                value={form.alliance}
                onChange={(event) =>
                  setForm({
                    ...form,
                    alliance: event.target.value,
                    station: `${event.target.value}1`,
                  })
                }
              >
                <option value="blue">Blue</option>
                <option value="red">Red</option>
              </select>
            </label>
            <label>
              Station
              <select value={form.station} onChange={(event) => setForm({ ...form, station: event.target.value })}>
                {stationOptions.map((station) => (
                  <option key={station} value={station}>{station.toUpperCase()}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="assignment-card">
            <span>Locked team</span>
            <strong>{assignedTeam || "No team assigned"}</strong>
            <small>{selectedMatch?.label || "Select a match"}</small>
          </div>
          <div className="slider-grid">
            <Slider label="Cycles" min="0" max="40" value={form.cycleCount} onChange={(cycleCount) => setForm({ ...form, cycleCount })} />
            <Slider label="Reliability" min="1" max="10" value={form.reliability} onChange={(reliability) => setForm({ ...form, reliability })} />
            <Slider label="Defense resistance" min="1" max="10" value={form.defenseResistance} onChange={(defenseResistance) => setForm({ ...form, defenseResistance })} />
          </div>
          <label>
            Qualitative note
            <textarea
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              placeholder="Driver awareness, traffic behavior, failures, partner compatibility..."
              required
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={saving || !assignedTeam}>
            <Save size={17} /> {saving ? "Saving..." : "Save guarded report"}
          </button>
        </form>

        <div className="panel report-feed">
          {dashboard.reports.length === 0 ? (
            <div className="empty-mini">No scout reports for this event yet.</div>
          ) : (
            dashboard.reports.map((report) => (
              <article className="report-item" key={report.id}>
                <div>
                  <strong>{report.station.toUpperCase()} - {report.team}</strong>
                  <span>{report.scout} - {matchLabel(dashboard, report.matchId)}</span>
                </div>
                <p>{report.note}</p>
                <small>{report.cycleCount} cycles - reliability {report.reliability}/10 - defense resistance {report.defenseResistance}/10</small>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Slider({ label, value, min, max, onChange }) {
  return (
    <label className="range-label">
      <span>{label}</span>
      <strong>{value}</strong>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Picklists({ scout, dashboard, onUpdate }) {
  const scoutFirstName = scout.name.split(" ")[0];
  const existing = dashboard.picklists.find((list) => list.scout === scoutFirstName);
  const [ranking, setRanking] = useState(existing?.rankings || dashboard.teams.map((team) => team.number));
  const teamByNumber = useMemo(
    () => new Map(dashboard.teams.map((team) => [team.number, team])),
    [dashboard.teams],
  );

  useEffect(() => {
    setRanking(existing?.rankings || dashboard.teams.map((team) => team.number));
  }, [dashboard.eventKey]);

  function move(index, direction) {
    const next = ranking.slice();
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRanking(next);
  }

  async function save() {
    const response = await fetch(`${API_URL}/picklists/${encodeURIComponent(scoutFirstName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventKey: dashboard.eventKey, rankings: ranking }),
    });
    if (response.ok) onUpdate(await response.json());
  }

  return (
    <section className="section-block">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Multiplayer picklists</p>
          <h2>Collaborative alliance ranking</h2>
        </div>
        <Trophy size={21} />
      </div>

      <div className="two-column stage-grid">
        <div className="panel picklist-editor">
          {ranking.map((teamNumber, index) => {
            const team = teamByNumber.get(teamNumber);
            return (
              <article className="pick-row" key={teamNumber}>
                <span>{index + 1}</span>
                <strong>{teamNumber} {team?.name}</strong>
                <div className="row-actions">
                  <button type="button" aria-label="Move up" onClick={() => move(index, -1)}>
                    <ChevronUp size={17} />
                  </button>
                  <button type="button" aria-label="Move down" onClick={() => move(index, 1)}>
                    <ChevronDown size={17} />
                  </button>
                </div>
              </article>
            );
          })}
          <button className="primary-button" type="button" onClick={save}>
            <Save size={17} /> Sync picklist
          </button>
        </div>

        <div className="panel multiplayer-board">
          {dashboard.picklists.length === 0 ? (
            <div className="empty-mini">No synced picklists yet.</div>
          ) : (
            dashboard.picklists.map((list) => (
              <article key={list.scout}>
                <strong>{list.scout}</strong>
                <ol>
                  {list.rankings.slice(0, 5).map((teamNumber) => (
                    <li key={teamNumber}>{teamNumber} {teamByNumber.get(teamNumber)?.name}</li>
                  ))}
                </ol>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function FilmReview({ dashboard }) {
  const [selectedId, setSelectedId] = useState(dashboard.matches[0]?.id);
  const selected = dashboard.matches.find((match) => match.id === selectedId) || dashboard.matches[0];
  const relatedReports = dashboard.reports.filter((report) => report.matchId === selected?.id);
  const youtubeSearch = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${dashboard.eventKey} ${selected?.label || ""} FRC`)}`;

  return (
    <section className="section-block">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YouTube film review</p>
          <h2>Video-grounded scouting</h2>
        </div>
        <Film size={21} />
      </div>

      <div className="film-layout">
        <div className="panel video-panel">
          <div className="video-frame">
            {selected?.video ? (
              <iframe src={selected.video} title={selected.label} allowFullScreen />
            ) : (
              <a className="youtube-empty" href={youtubeSearch} target="_blank" rel="noreferrer">
                <PlayCircle size={42} />
                Open YouTube search for this match
              </a>
            )}
          </div>
        </div>
        <div className="panel event-panel">
          <select value={selected?.id || ""} onChange={(event) => setSelectedId(event.target.value)}>
            {dashboard.matches.map((match) => (
              <option key={match.id} value={match.id}>{match.label}</option>
            ))}
          </select>
          <p>{selected?.summary}</p>
          <div className="match-card">
            <strong>Red</strong>
            <span>{selected?.red.join(", ")}</span>
            <strong>Blue</strong>
            <span>{selected?.blue.join(", ")}</span>
          </div>
          <div className="event-list">
            {relatedReports.length === 0 ? (
              <article>
                <span>Scout data</span>
                <strong>No reports attached yet</strong>
                <small>Submit guarded reports to connect notes to this film.</small>
              </article>
            ) : (
              relatedReports.map((report) => (
                <article key={report.id}>
                  <span>{report.station.toUpperCase()}</span>
                  <strong>{report.team} - {report.scout}</strong>
                  <small>{report.note}</small>
                </article>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function BettingPanel({ scout, dashboard, onUpdate }) {
  const firstOpen = dashboard.markets.find((market) => !market.played);
  const [form, setForm] = useState({
    matchId: firstOpen?.matchId || dashboard.markets[0]?.matchId || "",
    side: "blue",
    amount: 25,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const account = dashboard.accounts?.[scout.name] || { balance: scout.balance || 1000 };
  const selected = dashboard.markets.find((market) => market.matchId === form.matchId) || firstOpen;

  async function placeBet(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch(`${API_URL}/bets/place`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, eventKey: dashboard.eventKey, scout: scout.name }),
    });
    const data = await response.json();
    setSaving(false);
    if (response.ok) {
      onUpdate(data);
    } else {
      setError(data.message || data.detail || "Bet was not placed");
    }
  }

  async function settle() {
    setSaving(true);
    setError("");
    const response = await fetch(`${API_URL}/bets/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventKey: dashboard.eventKey }),
    });
    const data = await response.json();
    setSaving(false);
    if (response.ok) onUpdate(data);
    else setError(data.message || data.detail || "Bets were not settled");
  }

  return (
    <section className="section-block">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Statbotics-priced markets</p>
          <h2>Scout match betting</h2>
        </div>
        <Wallet size={21} />
      </div>

      <div className="two-column betting-grid">
        <form className="panel betting-form" onSubmit={placeBet}>
          <div className="wallet-card">
            <span>Balance</span>
            <strong>${Number(account.balance).toFixed(2)}</strong>
            <small>Markets pay like simple prediction shares.</small>
          </div>
          <label>
            Match
            <select value={form.matchId} onChange={(event) => setForm({ ...form, matchId: event.target.value })}>
              {dashboard.markets.map((market) => (
                <option key={market.matchId} value={market.matchId}>
                  {market.label} {market.played ? "(final)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="price-grid">
            {["red", "blue", "tie"].map((side) => (
              <button
                key={side}
                type="button"
                className={form.side === side ? "selected" : ""}
                onClick={() => setForm({ ...form, side })}
                disabled={selected?.played}
              >
                <span>{side}</span>
                <strong>{selected ? Math.round(selected.prices[side] * 100) : 0}c</strong>
              </button>
            ))}
          </div>
          <label>
            Amount
            <input
              type="number"
              min="1"
              max={Math.max(1, Math.floor(account.balance))}
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: Number(event.target.value) })}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" type="submit" disabled={saving || selected?.played}>
            <BadgeDollarSign size={17} /> {saving ? "Working..." : "Place bet"}
          </button>
          <button className="ghost-button" type="button" onClick={settle} disabled={saving}>
            <RefreshCw size={17} /> Settle from TBA results
          </button>
        </form>

        <div className="panel markets-panel">
          <div className="markets-list">
            {dashboard.markets.map((market) => (
              <article className="market-row" key={market.matchId}>
                <div>
                  <strong>{market.label}</strong>
                  <small>R {market.red.join(", ")} | B {market.blue.join(", ")}</small>
                </div>
                <div className="market-prices">
                  <span>R {Math.round(market.prices.red * 100)}c</span>
                  <span>B {Math.round(market.prices.blue * 100)}c</span>
                  <span>T {Math.round(market.prices.tie * 100)}c</span>
                </div>
                <b>{market.played ? `Final: ${market.winner}` : "Open"}</b>
              </article>
            ))}
          </div>
          <div className="bet-feed">
            {dashboard.bets.filter((bet) => bet.scout === scout.name).slice(0, 8).map((bet) => (
              <article key={bet.id}>
                <strong>{bet.matchLabel} - {bet.side}</strong>
                <span>${bet.amount} at {Math.round(bet.price * 100)}c - {bet.status}</span>
                {bet.status === "settled" && <small>Payout ${Number(bet.payout).toFixed(2)}</small>}
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function matchLabel(dashboard, matchId) {
  return dashboard.matches.find((match) => match.id === matchId)?.label || matchId;
}

createRoot(document.getElementById("root")).render(<App />);
