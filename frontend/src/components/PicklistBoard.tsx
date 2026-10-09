"use client";
// The picklist editor: a draggable ranked list on the left, the pool of
// available teams on the right.
//
// Drag and drop is written directly against the HTML drag events rather than
// a library. The interaction is small (reorder within a list, move between
// two lists) and these devices are borrowed Chromebooks, so the right answer
// is a few dozen lines rather than another dependency in the bundle. Touch
// gets explicit up and down buttons instead, because HTML5 drag does not fire
// on touch screens and a picklist meeting is not the place to discover that.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Picklist, PicklistItem, Team } from "@/lib/types";
import { TeamIdentity } from "@/components/ui";
import { TeamDetailModal } from "@/components/TeamDetailModal";
import { NoteEditor } from "@/components/MatchRef";

export interface BoardProps {
  list: Picklist;
  teams: Record<number, Team>;
  pool: number[];
  canEdit: boolean;
  onChange: (items: PicklistItem[]) => void;
  onSelectTeam?: (team: number) => void;
  selectedTeam?: number | null;
  teamStatuses?: Record<string, string>;
  hideUnavailable?: boolean;
}

const justificationOf = (it: PicklistItem) =>
  it.justification ?? it.note ?? it.comments ?? "";

export function PicklistBoard({ list, teams, pool, canEdit, onChange, onSelectTeam, selectedTeam, teamStatuses = {}, hideUnavailable = false }: BoardProps) {
  const [items, setItems] = useState<PicklistItem[]>(list.items || []);
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [poolOpen, setPoolOpen] = useState(true);
  const dragFrom = useRef<{ zone: "list" | "pool"; index: number } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => { setItems(list.items || []); }, [list.id, list.updated_at, list.items]);

  const ranked = new Set(items.map((i) => i.team));
  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pool
      .filter((t) => !ranked.has(t))
      .filter((t) => {
        if (!q) return true;
        const team = teams[t];
        return String(t).includes(q) || (team?.nickname || "").toLowerCase().includes(q);
      });
  }, [pool, ranked, search, teams]);

  function commit(next: PicklistItem[]) {
    if (!canEdit) return;
    setItems(next);
    onChange(next);
  }

  function addTeam(team: number, at?: number) {
    if (ranked.has(team)) return;
    const next = [...items];
    next.splice(at ?? next.length, 0, { team, note: "" });
    commit(next);
  }

  function removeAt(index: number) {
    commit(items.filter((_, i) => i !== index));
  }

  function moveTo(from: number, to: number) {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  }

  function setNote(index: number, value: string) {
    commit(items.map((it, i) => (i === index ? { ...it, note: value, justification: value } : it)));
  }

  // ---- drag handlers ------------------------------------------------------
  function onDrop(target: number) {
    const from = dragFrom.current;
    setDropIndex(null);
    dragFrom.current = null;
    if (!from || !canEdit) return;
    if (from.zone === "pool") addTeam(available[from.index], target);
    else moveTo(from.index, target);
  }

  return (
    <div className="picklist-board">
      <section className="picklist-ranked">
        <div className="card-h">
          <h3 style={{ margin: 0 }}>
            {list.pick_round === 1 ? "First pick order" : "Second pick order"}
          </h3>
          <span className="badge muted">{items.length} ranked</span>
        </div>

        {items.length === 0 && (
          <p className="faint" style={{ marginTop: 4 }}>
            {canEdit
              ? "Drag teams here from the list on the right, or press Add."
              : "Nothing ranked yet."}
          </p>
        )}

        <ol className="pick-order">
          {items.map((it, i) => {
            const team = teams[it.team] || { team_number: it.team, nickname: "" };
            return (
              <li
                key={it.team}
                hidden={hideUnavailable && ["Already Selected", "Unavailable", "Do Not Pick"].includes(teamStatuses[it.team])}
                style={selectedTeam === it.team ? { outline: "2px solid var(--haze)" } : undefined}
                className={"pick-row" + (dropIndex === i ? " drop-target" : "")}
                draggable={canEdit}
                onDragStart={() => { dragFrom.current = { zone: "list", index: i }; }}
                onDragOver={(e) => { e.preventDefault(); setDropIndex(i); }}
                onDragLeave={() => setDropIndex((d) => (d === i ? null : d))}
                onDrop={(e) => { e.preventDefault(); onDrop(i); }}
              >
                <span className="rank-chip">{i + 1}</span>

                <button type="button" className="team-click grow" onClick={() => onSelectTeam ? onSelectTeam(it.team) : setOpenTeam(it.team)}>
                  <TeamIdentity team={team} />
                  {teamStatuses[it.team] && teamStatuses[it.team] !== "Available" && <span className="badge muted">{teamStatuses[it.team]}</span>}
                </button>

                {canEdit && (
                  <div className="btn-row pick-move">
                    <button className="btn sm ghost" onClick={() => moveTo(i, i - 1)} disabled={i === 0} aria-label="Move up">↑</button>
                    <button className="btn sm ghost" onClick={() => moveTo(i, i + 1)} disabled={i === items.length - 1} aria-label="Move down">↓</button>
                    <button className="btn sm ghost" onClick={() => removeAt(i)} aria-label="Remove">✕</button>
                  </div>
                )}

                {/* Typing "@42" here offers the scouting data from qual 42
                    for this team, so the reason carries its evidence. */}
                <NoteEditor
                  value={justificationOf(it)}
                  onChange={(v) => setNote(i, v)}
                  team={it.team}
                  placeholder="Why this team, at this rank"
                  readOnly={!canEdit}
                />
              </li>
            );
          })}
          {canEdit && items.length > 0 && (
            <li
              className={"pick-row drop-tail" + (dropIndex === items.length ? " drop-target" : "")}
              onDragOver={(e) => { e.preventDefault(); setDropIndex(items.length); }}
              onDragLeave={() => setDropIndex((d) => (d === items.length ? null : d))}
              onDrop={(e) => { e.preventDefault(); onDrop(items.length); }}
            >
              Drop here to add at the bottom
            </li>
          )}
        </ol>
      </section>

      <aside className={"picklist-pool" + (poolOpen ? "" : " collapsed")}>
        <div className="card-h">
          <h3 style={{ margin: 0 }}>Teams</h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge muted">{available.length}</span>
            {/* Phones only: the pool is tall, and the ranked list is what
                people came to look at. */}
            <button
              type="button"
              className="btn sm ghost pool-toggle"
              onClick={() => setPoolOpen((v) => !v)}
            >
              {poolOpen ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <input
          className="pool-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search number or name"
          onKeyDown={e => { if (e.key === "Enter" && available.length && canEdit) { e.preventDefault(); addTeam(available[0]); } }}
          inputMode="search"
        />
        <div
          className="pool-list"
          onDragOver={(e) => { if (dragFrom.current?.zone === "list") e.preventDefault(); }}
          onDrop={(e) => {
            // Dragging a ranked team back to the pool removes it.
            e.preventDefault();
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from?.zone === "list" && canEdit) removeAt(from.index);
          }}
        >
          {available.map((t, i) => {
            const team = teams[t] || { team_number: t, nickname: "" };
            return (
              <div
                key={t}
                className="pool-row"
                draggable={canEdit}
                onDragStart={() => { dragFrom.current = { zone: "pool", index: i }; }}
              >
                <button type="button" className="team-click grow" onClick={() => setOpenTeam(t)}>
                  <TeamIdentity team={team} />
                  {teamStatuses[t] && teamStatuses[t] !== "Available" && <span className="badge muted">{teamStatuses[t]}</span>}
                </button>
                {canEdit && (
                  <button className="btn sm primary" onClick={() => addTeam(t)}>Add</button>
                )}
              </div>
            );
          })}
          {available.length === 0 && (
            <p className="faint" style={{ padding: "10px 4px" }}>
              {search ? "No team matches that search." : "Every scouted team is ranked."}
            </p>
          )}
        </div>
      </aside>

      {openTeam != null && (
        <TeamDetailModal teamNumber={openTeam} onClose={() => setOpenTeam(null)} />
      )}
    </div>
  );
}
