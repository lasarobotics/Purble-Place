"use client";
// Seasons: create one, configure its game, make it live.
//
// This is the screen the January test is about. A new FRC game is a new season
// here: name it, describe its phases, pieces, locations and actions, write the
// scoring rules, and generate the forms. No part of that is a code change.
//
// The game editor is one panel per concept rather than a JSON box, because the
// people who configure a game are strategy leads, not developers. A scoring
// rule reads as a sentence for the same reason: that is how somebody checks it
// is right.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  blankGame,
  createSeason,
  getChecklist,
  getSeason,
  getSeasonHistory,
  getSeasonMeta,
  listSeasons,
  revertGame,
  saveGame,
  seedSeasonForms,
  setSeasonStatus,
  validateGame,
  type ChecklistItem,
  type SeasonMeta,
  type SeasonRevisionSummary,
  type SeasonStatus,
  type SeasonSummary,
} from "@/lib/seasons";
import type { GameDefinition } from "@/lib/formdef";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { onBus } from "@/lib/bus";
import { Confirm, Empty, Loading, Modal } from "@/components/ui";

type Tab = "setup" | "game" | "history";

const STATUS_LABEL: Record<SeasonStatus, string> = {
  setup: "In setup",
  active: "Live",
  archived: "Archived",
};

function PreservedSeasonsPage() {
  const toast = useToast();
  const [seasons, setSeasons] = useState<SeasonSummary[]>([]);
  const [current, setCurrent] = useState("");
  const [selected, setSelected] = useState("");
  const [meta, setMeta] = useState<SeasonMeta | null>(null);
  const [tab, setTab] = useState<Tab>("setup");
  const [loading, setLoading] = useState(true);

  const [game, setGame] = useState<GameDefinition | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [history, setHistory] = useState<SeasonRevisionSummary[]>([]);

  const [creating, setCreating] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState<SeasonSummary | null>(null);

  const season = seasons.find((s) => s.season_id === selected);

  const loadSeasons = useCallback(async (keep?: string) => {
    try {
      const res = await listSeasons();
      setSeasons(res.seasons);
      setCurrent(res.current);
      setSelected((cur) => keep || cur || res.current || res.seasons[0]?.season_id || "");
    } catch (e: any) {
      toast(e?.message || "Could not load seasons", "err");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    loadSeasons();
    getSeasonMeta().then(setMeta).catch(() => {});
    return onBus((e) => { if (e === "season_changed") loadSeasons(); });
  }, [loadSeasons]);

  const open = useCallback(async (seasonId: string) => {
    if (!seasonId) return;
    try {
      const full = await getSeason(seasonId);
      setGame(full.definition?.phases ? full.definition : blankGame(full.year));
      setBaseVersion(full.game_version);
      setDirty(false);
      setChecklist(await getChecklist(seasonId).catch(() => []));
      setHistory(await getSeasonHistory(seasonId).catch(() => []));
    } catch (e: any) {
      toast(e?.message || "Could not open that season", "err");
    }
  }, [toast]);

  useEffect(() => { open(selected); }, [selected, open]);

  // Validate as you type, so a problem lands next to the thing that caused it.
  useEffect(() => {
    if (!game) return;
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const res = await validateGame(game);
        if (alive) setProblems(res.problems);
      } catch {}
    }, 400);
    return () => { alive = false; clearTimeout(id); };
  }, [game]);

  function edit(mutate: (draft: GameDefinition) => void) {
    if (!game) return;
    const draft: GameDefinition = JSON.parse(JSON.stringify(game));
    mutate(draft);
    setGame(draft);
    setDirty(true);
  }

  async function save() {
    if (!game || !selected) return;
    setSaving(true);
    try {
      const res = await saveGame(selected, game, message.trim(), baseVersion);
      toast(`Saved game version ${res.version}`, "ok");
      setMessage("");
      setShowSave(false);
      await loadSeasons(selected);
      await open(selected);
    } catch (e: any) {
      toast(e?.message || "Could not save the game", "err");
    } finally {
      setSaving(false);
    }
  }

  async function activate(row: SeasonSummary) {
    setActivating(null);
    try {
      await setSeasonStatus(row.season_id, "active");
      toast(`${row.season_id} is now the live season`, "ok");
      await loadSeasons(row.season_id);
      await open(row.season_id);
    } catch (e: any) {
      toast(e?.message || "Could not activate", "err");
    }
  }

  async function generateForms() {
    try {
      const res = await seedSeasonForms(selected);
      toast(`Forms ready: ${res.forms.join(", ")}`, "ok");
      setChecklist(await getChecklist(selected));
    } catch (e: any) {
      toast(e?.message || "Could not generate forms", "err");
    }
  }

  async function revert(version: number) {
    try {
      const res = await revertGame(selected, version);
      toast(`Reverted to version ${version}, saved as version ${res.version}`, "ok");
      await loadSeasons(selected);
      await open(selected);
    } catch (e: any) {
      toast(e?.message || "Could not revert", "err");
    }
  }

  const done = checklist.filter((c) => c.done).length;

  if (loading) return <Loading />;

  return (
    <div className="seasons-page">
      <div className="page-title">
        <h1>Seasons</h1>
        <span className="badge muted">{seasons.length}</span>
      </div>


      <div className="seasons-layout">
        <aside className="season-list">
          <div className="card-h">
            <h3>All seasons</h3>
            <button className="btn sm" onClick={() => setCreating(true)}>New</button>
          </div>
          {seasons.map((s) => (
            <button
              key={s.season_id}
              type="button"
              className={"season-item" + (s.season_id === selected ? " on" : "")}
              onClick={() => setSelected(s.season_id)}
            >
              <span className="season-item-name">
                <b>{s.season_id}</b>
                {s.season_id === current && <span className="badge green">live</span>}
                {s.status === "setup" && s.season_id !== current && (
                  <span className="badge amber">setup</span>
                )}
              </span>
              <span className="season-item-meta">
                {s.game_name || "Unnamed game"} - game v{s.game_version}
              </span>
            </button>
          ))}
          {!seasons.length && <p className="faint">No seasons yet.</p>}
        </aside>

        <div className="season-main">
          {!season || !game ? (
            <Empty icon="calendar" title="Pick a season" sub="Or create the next one." />
          ) : (
            <>
              <div className="season-toolbar">
                <div className="seg">
                  <button className={tab === "setup" ? "on" : ""} onClick={() => setTab("setup")}>
                    Setup ({done}/{checklist.length})
                  </button>
                  <button className={tab === "game" ? "on" : ""} onClick={() => setTab("game")}>
                    Game
                  </button>
                  <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
                    History ({history.length})
                  </button>
                </div>

                <span className="season-status">
                  {dirty ? (
                    <span className="badge amber">unsaved changes</span>
                  ) : (
                    <span className="badge muted">
                      {STATUS_LABEL[season.status]} - game v{season.game_version}
                    </span>
                  )}
                </span>

                <div className="btn-row">
                  {tab === "game" && (
                    <>
                      <button
                        className="btn sm primary"
                        disabled={!dirty || problems.length > 0}
                        onClick={() => setShowSave(true)}
                        title={problems.length ? "Fix the problems first" : undefined}
                      >
                        Save game
                      </button>
                      <button className="btn sm ghost" disabled={!dirty} onClick={() => open(selected)}>
                        Discard
                      </button>
                    </>
                  )}
                  {season.season_id !== current && (
                    <button className="btn sm" onClick={() => setActivating(season)}>
                      Make live
                    </button>
                  )}
                </div>
              </div>

              {problems.length > 0 && tab === "game" && (
                <div className="builder-messages">
                  {problems.map((p) => <p key={p} className="form-error">{p}</p>)}
                </div>
              )}

              {tab === "setup" && (
                <SetupChecklist
                  items={checklist}
                  onGenerateForms={generateForms}
                  onEditGame={() => setTab("game")}
                />
              )}

              {tab === "game" && meta && (
                <GameEditor game={game} meta={meta} onEdit={edit} />
              )}

              {tab === "history" && (
                <SeasonHistory history={history} onRevert={revert} />
              )}
            </>
          )}
        </div>
      </div>

      {creating && (
        <NewSeasonDialog
          seasons={seasons}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await loadSeasons(id);
            setSelected(id);
            setTab("setup");
          }}
        />
      )}

      {showSave && (
        <Modal onClose={() => setShowSave(false)}>
          <div className="confirm">
            <h3>Save the game</h3>
            <div className="confirm-body">

              <label className="field">
                <span>What changed?</span>
                <input
                  autoFocus
                  value={message}
                  placeholder="e.g. Doubled the value of a high goal"
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                />
              </label>
            </div>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => setShowSave(false)}>Cancel</button>
              <button className="btn primary" disabled={saving} onClick={save}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {activating && (
        <Confirm
          title={`Make ${activating.season_id} the live season?`}
          body={
            <>
              Activate this season and archive <b>{current || "the current season"}</b>?
            </>
          }
          confirmLabel="Make it live"
          onConfirm={() => activate(activating)}
          onCancel={() => setActivating(null)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Setup checklist
// --------------------------------------------------------------------------
function SetupChecklist({
  items,
  onGenerateForms,
  onEditGame,
}: {
  items: ChecklistItem[];
  onGenerateForms: () => void;
  onEditGame: () => void;
}) {
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  return (
    <div className="card">
      <div className="card-h">
        <h3>Season setup</h3>
        <span className="badge muted">{done} of {items.length}</span>
      </div>
      <div className="checklist-progress"><span style={{ width: `${pct}%` }} /></div>
      <ol className="checklist">
        {items.map((item) => (
          <li key={item.key} className={item.done ? "done" : ""}>
            <span className="mark">{item.done ? "x" : "-"}</span>
            <span>
              {item.label}
              {!item.done && item.hint && <span className="hint">{item.hint}</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={onEditGame}>Configure the game</button>
        <button className="btn sm ghost" onClick={onGenerateForms}>
          Generate starting forms
        </button>
      </div>

    </div>
  );
}

// --------------------------------------------------------------------------
// Game editor
// --------------------------------------------------------------------------
function GameEditor({
  game,
  meta,
  onEdit,
}: {
  game: GameDefinition;
  meta: SeasonMeta;
  onEdit: (mutate: (draft: GameDefinition) => void) => void;
}) {
  return (
    <div className="game-editor">
      <div className="card">
        <div className="card-h"><h3>The game</h3></div>
        <div className="builder-pair">
          <label className="field">
            <span>Name</span>
            <input value={game.name} placeholder="e.g. Rebuilt"
                   onChange={(e) => onEdit((d) => { d.name = e.target.value; })} />
          </label>
          <label className="field">
            <span>Year</span>
            <input type="number" value={game.year}
                   onChange={(e) => onEdit((d) => { d.year = Number(e.target.value); })} />
          </label>
        </div>
        <label className="field">
          <span>What the endgame is called</span>
          <input value={game.endgame_label} placeholder="e.g. Endgame climb"
                 onChange={(e) => onEdit((d) => { d.endgame_label = e.target.value; })} />
        </label>
      </div>

      <div className="game-groups">
        <KeyedGroup
          title="Phases"
          hint="The periods of a match, in order. Some games have had more than two."
          items={game.phases}
          onAdd={() => onEdit((d) => { d.phases.push({ key: `phase_${d.phases.length + 1}`, label: "New phase", order: d.phases.length }); })}
          onPatch={(i, patch) => onEdit((d) => { Object.assign(d.phases[i], patch); })}
          onRemove={(i) => onEdit((d) => { d.phases.splice(i, 1); })}
        />
        <KeyedGroup
          title="Game pieces"
          hint="What robots handle. Leave empty if the game has none."
          items={game.pieces}
          onAdd={() => onEdit((d) => { d.pieces.push({ key: `piece_${d.pieces.length + 1}`, label: "New piece" }); })}
          onPatch={(i, patch) => onEdit((d) => { Object.assign(d.pieces[i], patch); })}
          onRemove={(i) => onEdit((d) => { d.pieces.splice(i, 1); })}
        />
        <KeyedGroup
          title="Locations"
          hint="Where things happen: nodes, zones, levels."
          items={game.locations}
          onAdd={() => onEdit((d) => { d.locations.push({ key: `loc_${d.locations.length + 1}`, label: "New location" }); })}
          onPatch={(i, patch) => onEdit((d) => { Object.assign(d.locations[i], patch); })}
          onRemove={(i) => onEdit((d) => { d.locations.splice(i, 1); })}
        />
        <KeyedGroup
          title="Endgame states"
          hint="However a match can end for a robot. The first one means it did not happen."
          items={game.endgame}
          onAdd={() => onEdit((d) => { d.endgame.push({ key: `state_${d.endgame.length + 1}`, label: "New state", points: 0 }); })}
          onPatch={(i, patch) => onEdit((d) => { Object.assign(d.endgame[i], patch); })}
          onRemove={(i) => onEdit((d) => { d.endgame.splice(i, 1); })}
        />
      </div>

      <div className="game-group">
        <h3>Actions</h3>

        <div className="game-rows">
          {game.actions.map((a, i) => (
            <div key={i} className="rule-row">
              <div className="rule-line">
                <input className="mono" value={a.key} placeholder="key"
                       onChange={(e) => onEdit((d) => { d.actions[i].key = e.target.value; })} />
                <input value={a.label} placeholder="Label"
                       onChange={(e) => onEdit((d) => { d.actions[i].label = e.target.value; })} />
                <button className="btn sm ghost"
                        onClick={() => onEdit((d) => { d.actions.splice(i, 1); })}>x</button>
              </div>
              <div className="rule-line">
                <span className="rule-word">results</span>
                <input value={(a.results || []).join(", ")} placeholder="made, missed"
                       onChange={(e) => onEdit((d) => {
                         d.actions[i].results = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                       })} />
              </div>
              <MultiPick label="phases" all={game.phases} chosen={a.phases || []}
                         onChange={(v) => onEdit((d) => { d.actions[i].phases = v; })} />
              <MultiPick label="pieces" all={game.pieces} chosen={a.objects || []}
                         onChange={(v) => onEdit((d) => { d.actions[i].objects = v; })} />
              <MultiPick label="places" all={game.locations} chosen={a.locations || []}
                         onChange={(v) => onEdit((d) => { d.actions[i].locations = v; })} />
            </div>
          ))}
          <button className="btn sm" onClick={() => onEdit((d) => {
            d.actions.push({ key: `action_${d.actions.length + 1}`, label: "New action",
                             phases: [], objects: [], locations: [], results: ["made", "missed"] });
          })}>Add action</button>
        </div>
      </div>

      <div className="game-group">
        <h3>Scoring</h3>

        <div className="game-rows">
          {game.rules.map((r, i) => (
            <RuleRow key={i} rule={r} game={game} meta={meta}
                     onPatch={(patch) => onEdit((d) => { Object.assign(d.rules[i], patch); })}
                     onRemove={() => onEdit((d) => { d.rules.splice(i, 1); })} />
          ))}
          <button className="btn sm" onClick={() => onEdit((d) => {
            d.rules.push({ rule_id: `rule_${d.rules.length + 1}`, label: "New rule",
                           points: 1, per: "each", when: {} });
          })}>Add rule</button>
        </div>
      </div>
    </div>
  );
}

interface Keyed { key: string; label: string; points?: number }

function KeyedGroup({
  title, hint, items, onAdd, onPatch, onRemove,
}: {
  title: string;
  hint: string;
  items: any[];
  onAdd: () => void;
  onPatch: (i: number, patch: Record<string, any>) => void;
  onRemove: (i: number) => void;
}) {
  const scored = title === "Endgame states";
  return (
    <div className="game-group">
      <h3>{title}</h3>

      <div className="game-rows">
        {items.map((item: Keyed, i) => (
          <div key={i} className="game-row">
            <input className="mono" value={item.key} placeholder="key"
                   onChange={(e) => onPatch(i, { key: e.target.value })} />
            <input value={item.label} placeholder="Label"
                   onChange={(e) => onPatch(i, { label: e.target.value })} />
            {scored && (
              <input type="number" step="0.5" style={{ width: 62 }} value={item.points ?? 0}
                     onChange={(e) => onPatch(i, { points: Number(e.target.value) })} />
            )}
            <button className="btn sm ghost" onClick={() => onRemove(i)} aria-label="Remove">x</button>
          </div>
        ))}
        {!items.length && <p className="faint" style={{ fontSize: "0.76rem" }}>None yet.</p>}
        <button className="btn sm" onClick={onAdd}>Add</button>
      </div>
    </div>
  );
}

function MultiPick({
  label, all, chosen, onChange,
}: {
  label: string;
  all: { key: string; label: string }[];
  chosen: string[];
  onChange: (v: string[]) => void;
}) {
  if (!all.length) return null;
  return (
    <div className="rule-line">
      <span className="rule-word">{label}</span>
      <span className="tag-list">
        {all.map((o) => {
          const on = chosen.includes(o.key);
          return (
            <button key={o.key} type="button" className={"chip" + (on ? " on" : "")}
                    onClick={() => onChange(on ? chosen.filter((c) => c !== o.key) : [...chosen, o.key])}>
              {o.label}
            </button>
          );
        })}
      </span>
    </div>
  );
}

/** One scoring rule, written as a sentence. */
function RuleRow({
  rule, game, meta, onPatch, onRemove,
}: {
  rule: any;
  game: GameDefinition;
  meta: SeasonMeta;
  onPatch: (patch: Record<string, any>) => void;
  onRemove: () => void;
}) {
  const when = rule.when || {};
  const isFieldRule = "field" in when;

  function setWhen(key: string, value: string) {
    const next = { ...when };
    if (value === "") delete next[key];
    else next[key] = value;
    onPatch({ when: next });
  }

  const results = Array.from(
    new Set(game.actions.flatMap((a) => a.results || ["made", "missed"]))
  );

  return (
    <div className="rule-row">
      <div className="rule-line">
        <input value={rule.label} placeholder="What this rule is"
               onChange={(e) => onPatch({ label: e.target.value })} />
        <input className="mono" value={rule.rule_id} placeholder="rule_id"
               onChange={(e) => onPatch({ rule_id: e.target.value })} />
        <button className="btn sm ghost" onClick={onRemove} aria-label="Remove rule">x</button>
      </div>

      <div className="rule-line">
        <span className="rule-word">score</span>
        <input className="rule-points" type="number" step="0.5" value={rule.points}
               onChange={(e) => onPatch({ points: Number(e.target.value) })} />
        <select value={rule.per} onChange={(e) => onPatch({ per: e.target.value })}>
          {meta.per_modes.map((m) => (
            <option key={m} value={m}>{m === "each" ? "for each one" : "once"}</option>
          ))}
        </select>
        <span className="rule-word">when</span>
        <select
          value={isFieldRule ? "field" : "action"}
          onChange={(e) => onPatch({ when: e.target.value === "field" ? { field: "" } : {} })}
        >
          <option value="action">a recorded action</option>
          <option value="field">a form answer</option>
        </select>
      </div>

      {isFieldRule ? (
        <div className="rule-line">
          <span className="rule-word">answer</span>
          <input className="mono" value={when.field || ""} placeholder="field key"
                 onChange={(e) => setWhen("field", e.target.value)} />
          <span className="rule-word">equals</span>
          <input value={when.equals ?? ""} placeholder="(any truthy value)"
                 onChange={(e) => setWhen("equals", e.target.value)} />
        </div>
      ) : (
        <div className="rule-line">
          <Pick label="action" value={when.action} options={game.actions.map((a) => [a.key, a.label])}
                onChange={(v) => setWhen("action", v)} />
          <Pick label="phase" value={when.phase} options={game.phases.map((p) => [p.key, p.label])}
                onChange={(v) => setWhen("phase", v)} />
          <Pick label="piece" value={when.object} options={game.pieces.map((p) => [p.key, p.label])}
                onChange={(v) => setWhen("object", v)} />
          <Pick label="where" value={when.location} options={game.locations.map((l) => [l.key, l.label])}
                onChange={(v) => setWhen("location", v)} />
          <Pick label="result" value={when.result} options={results.map((r) => [r, r])}
                onChange={(v) => setWhen("result", v)} />
        </div>
      )}
    </div>
  );
}

function Pick({
  label, value, options, onChange,
}: {
  label: string;
  value?: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <>
      <span className="rule-word">{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any</option>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </>
  );
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------
function SeasonHistory({
  history,
  onRevert,
}: {
  history: SeasonRevisionSummary[];
  onRevert: (version: number) => void;
}) {
  const [reverting, setReverting] = useState<SeasonRevisionSummary | null>(null);

  if (!history.length) return <p className="faint">No history yet.</p>;

  return (
    <div className="history">

      <ol className="history-list">
        {history.map((r) => (
          <li key={r.version} className="history-item">
            <div className="history-head" style={{ cursor: "default" }}>
              <span className="history-version mono">v{r.version}</span>
              <span className="history-body">
                <span className="history-message">
                  {r.message || "(no message)"}
                  {r.reverted_from > 0 && (
                    <span className="badge muted">revert of v{r.reverted_from}</span>
                  )}
                </span>
                <span className="history-meta">
                  {r.author_name} - {timeAgo(r.created_at)} - {r.summary}
                </span>
              </span>
              {r.current && <span className="badge green">current</span>}
              {!r.current && (
                <button className="btn sm ghost" onClick={() => setReverting(r)}>
                  Revert to this
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {reverting && (
        <Confirm
          title={`Revert the game to version ${reverting.version}?`}
          body={
            <>
              Restore <b>v{reverting.version}</b> as a new version?
            </>
          }
          confirmLabel="Revert"
          onConfirm={() => { onRevert(reverting.version); setReverting(null); }}
          onCancel={() => setReverting(null)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// New season
// --------------------------------------------------------------------------
function NewSeasonDialog({
  seasons,
  onClose,
  onCreated,
}: {
  seasons: SeasonSummary[];
  onClose: () => void;
  onCreated: (seasonId: string) => void;
}) {
  const toast = useToast();
  const nextYear = (Math.max(...seasons.map((s) => s.year), new Date().getFullYear())) + 1;
  const [year, setYear] = useState(nextYear);
  const [seasonId, setSeasonId] = useState(String(nextYear));
  const [copyFrom, setCopyFrom] = useState("");
  const [copyForms, setCopyForms] = useState(true);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await createSeason({
        season_id: seasonId.trim().toLowerCase(),
        year,
        copy_from: copyFrom,
        copy_forms: copyForms,
      });
      toast(`Created season ${seasonId}`, "ok");
      onCreated(seasonId.trim().toLowerCase());
    } catch (e: any) {
      toast(e?.message || "Could not create the season", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="confirm">
        <h3>New season</h3>
        <div className="confirm-body">
          <div className="builder-pair">
            <label className="field">
              <span>Year</span>
              <input type="number" value={year} onChange={(e) => {
                const y = Number(e.target.value);
                setYear(y);
                setSeasonId(String(y));
              }} />
            </label>
            <label className="field">
              <span>ID</span>
              <input className="mono" value={seasonId}
                     onChange={(e) => setSeasonId(e.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>Start from</span>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">An empty game</option>
              {seasons.map((s) => (
                <option key={s.season_id} value={s.season_id}>
                  Copy {s.season_id} ({s.game_name || "unnamed"})
                </option>
              ))}
            </select>
          </label>

          {copyFrom && (
            <label className="pill-check">
              <input type="checkbox" checked={copyForms}
                     onChange={(e) => setCopyForms(e.target.checked)} />
              Also copy its forms
            </label>
          )}


        </div>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={create}>
            {busy ? "Creating..." : "Create season"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Temporarily disabled for all roles; the implementation and API remain intact.
export default function DisabledTool() { return <section className="card"><h1>Tool unavailable</h1><p>This tool is temporarily disabled.</p></section>; }
