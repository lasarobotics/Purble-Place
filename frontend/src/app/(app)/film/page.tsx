"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { matchLabel, youtubeId } from "@/lib/format";
import type { MatchRec, ScoutEntry, FilmEvent } from "@/lib/types";
import { Loading, Empty } from "@/components/ui";
import { FieldHeatmap } from "@/components/Field";

export default function FilmPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [sel, setSel] = useState<MatchRec | null>(null);
  const [entries, setEntries] = useState<ScoutEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  // editable film fields (admin)
  const [link, setLink] = useState("");
  const [summary, setSummary] = useState("");
  const [events, setEvents] = useState<FilmEvent[]>([]);

  useEffect(() => {
    api<{ matches: MatchRec[] }>("/api/matches")
      .then((r) => { setMatches(r.matches); setSel((s) => s || r.matches[0] || null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!sel) return;
    setLink(sel.youtube_key || "");
    setSummary(sel.film_summary || "");
    setEvents(sel.film_events || []);
    setEditing(false);
    api<ScoutEntry[]>(`/api/scout/match/${sel.match_number}`).then(setEntries).catch(() => setEntries([]));
  }, [sel?.match_key]);

  const vid = useMemo(() => youtubeId(link || sel?.youtube_key || ""), [link, sel]);

  async function saveFilm() {
    if (!sel) return;
    try {
      await api("/api/admin/match/youtube", {
        method: "POST",
        body: { match_key: sel.match_key, youtube_key: link, film_summary: summary, film_events: events },
      });
      toast("Film saved for this match", "ok");
      setMatches((ms) => ms.map((m) => (m.match_key === sel.match_key
        ? { ...m, youtube_key: link, film_summary: summary, film_events: events } : m)));
      setSel((m) => (m ? { ...m, youtube_key: link, film_summary: summary, film_events: events } : m));
      setEditing(false);
    } catch (e: any) {
      toast(e.message || "Could not save", "err");
    }
  }

  if (loading) return <Loading />;
  if (!matches.length) return (<div><h1>🎥 Film Review</h1><Empty icon="🎬" title="No matches yet" sub="Set an event in the Dashboard to load the schedule." /></div>);

  return (
    <div>
      <div className="page-title"><h1>🎥 Film Review</h1>
        <span className="badge haze">Video-grounded scouting</span>
      </div>
      <p className="page-sub">Pair match video with scouting data — validate observations against what actually happened.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}>
            <span>Match</span>
            <select value={sel?.match_key || ""} onChange={(e) => setSel(matches.find((m) => m.match_key === e.target.value) || null)}>
              {matches.map((m) => (
                <option key={m.match_key} value={m.match_key}>
                  {matchLabel(m.comp_level, m.match_number)} — Red {m.red.join(", ")} vs Blue {m.blue.join(", ")}{m.youtube_key ? " 🎥" : ""}
                </option>
              ))}
            </select>
          </label>
          {session?.is_admin && (
            <div className="field" style={{ margin: 0, display: "flex", alignItems: "flex-end" }}>
              <button className="btn" onClick={() => setEditing((v) => !v)}>{editing ? "Close editor" : "✎ Edit film"}</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2">
        {/* Video panel */}
        <div className="card">
          <div className="card-h"><h3>Video</h3>
            {sel?.winner && <span className={`badge ${sel.winner === "red" ? "red" : sel.winner === "blue" ? "blue" : "muted"}`}>{sel.winner.toUpperCase()} won {sel.red_score}-{sel.blue_score}</span>}
          </div>
          {vid ? (
            <div className="video-frame">
              <iframe
                src={`https://www.youtube.com/embed/${vid}`}
                title="match film"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <Empty icon="📺" title="No film linked" sub={session?.is_admin ? "Use Edit film to paste a YouTube link." : "An admin can link film for this match."} />
          )}
        </div>

        {/* Summary + timestamped key events (the "copied" film structure) */}
        <div className="card">
          <div className="card-h"><h3>Video-grounded scouting</h3>
            <span className="badge muted">{(sel?.film_events?.length || 0)} key moments</span>
          </div>

          {editing ? (
            <FilmEditor
              link={link} setLink={setLink}
              summary={summary} setSummary={setSummary}
              events={events} setEvents={setEvents}
              onSave={saveFilm}
            />
          ) : (
            <>
              {sel?.film_summary ? (
                <p style={{ marginTop: 0 }}>{sel.film_summary}</p>
              ) : (
                <p className="muted" style={{ marginTop: 0 }}>No film summary yet for this match.</p>
              )}
              {sel?.film_events && sel.film_events.length > 0 ? (
                <div className="film-events">
                  {sel.film_events.map((ev, i) => (
                    <article key={i} className="film-event">
                      <span className="t">{ev.time}</span>
                      <div className="meta">
                        <strong>{ev.team} · {ev.type}</strong>
                        <small>{ev.detail}</small>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty icon="⏱️" title="No timestamped events" sub={session?.is_admin ? "Add key moments with Edit film." : undefined} />
              )}
            </>
          )}
        </div>
      </div>

      {/* Our existing scouting reports, kept as a secondary section */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h3>Scout Reports</h3><span className="badge muted">{entries.length} entries</span></div>
        {entries.length === 0 ? (
          <Empty icon="📋" title="No scouting for this match yet" />
        ) : (
          <div className="grid auto" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))" }}>
            {entries.map((e) => (
              <div key={e.id} className={`card tight ${e.alliance === "red" ? "alliance-red" : "alliance-blue"}`}>
                <div className="spread">
                  <b>Team {e.team_number}</b>
                  <span className="badge haze">{e.points} pts</span>
                </div>
                <div className="row" style={{ gap: 6, margin: "8px 0", flexWrap: "wrap" }}>
                  <span className="badge muted">Climb {e.climb.toUpperCase()}</span>
                  {e.played_defense && <span className="badge amber">Defense {e.defense_rating}/5</span>}
                  {e.failure && <span className="badge red">Failure</span>}
                  <span className="badge muted">Drv {e.driver_skill}/5</span>
                </div>
                {e.heatmap?.length > 0 && <FieldHeatmap points={e.heatmap as any} height={130} />}
                {e.notes && <p style={{ marginTop: 8, fontSize: "0.85rem" }}>“{e.notes}”</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilmEditor({
  link, setLink, summary, setSummary, events, setEvents, onSave,
}: {
  link: string; setLink: (v: string) => void;
  summary: string; setSummary: (v: string) => void;
  events: FilmEvent[]; setEvents: (v: FilmEvent[]) => void;
  onSave: () => void;
}) {
  const upd = (i: number, patch: Partial<FilmEvent>) => setEvents(events.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  return (
    <div>
      <label className="field"><span>YouTube link or ID</span>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/… or video ID" />
      </label>
      <label className="field"><span>Film summary / takeaway</span>
        <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What the video shows that the numbers miss…" />
      </label>
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>Key moments</span>
        <button className="btn sm" type="button" onClick={() => setEvents([...events, { time: "0:00", team: "", type: "Cycle", detail: "" }])}>+ Add moment</button>
      </div>
      <div className="film-events" style={{ marginBottom: 12 }}>
        {events.map((ev, i) => (
          <div key={i} className="film-event" style={{ gridTemplateColumns: "1fr", gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <input value={ev.time} onChange={(e) => upd(i, { time: e.target.value })} placeholder="1:02" style={{ width: 72 }} />
              <input value={ev.team} onChange={(e) => upd(i, { team: e.target.value })} placeholder="Team" style={{ width: 90 }} />
              <input value={ev.type} onChange={(e) => upd(i, { type: e.target.value })} placeholder="Type" style={{ width: 110 }} />
              <button className="btn sm ghost" type="button" onClick={() => setEvents(events.filter((_, k) => k !== i))}>✕</button>
            </div>
            <input value={ev.detail} onChange={(e) => upd(i, { detail: e.target.value })} placeholder="What happened…" />
          </div>
        ))}
        {events.length === 0 && <span className="faint" style={{ fontSize: "0.8rem" }}>No moments yet.</span>}
      </div>
      <button className="btn primary block" type="button" onClick={onSave}>Save film</button>
    </div>
  );
}
