"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLiveRefetch } from "@/lib/bus";
import { useToast } from "@/lib/toast";
import { matchLabel, youtubeEmbedUrl, youtubeId } from "@/lib/format";
import type { MatchRec, FilmEvent } from "@/lib/types";
import { Loading, Empty, TeamIdentity } from "@/components/ui";

export default function FilmPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [matches, setMatches] = useState<MatchRec[]>([]);
  const [sel, setSel] = useState<MatchRec | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  // editable film fields (admin)
  const [link, setLink] = useState("");
  const [summary, setSummary] = useState("");
  const [events, setEvents] = useState<FilmEvent[]>([]);

  // Reload when the admin changes the event / saves film on another device.
  const load = useCallback(() => {
    api<{ matches: MatchRec[] }>("/api/matches?include_teams=true")
      .then((r) => {
        setMatches(r.matches);
        setSel((s) => r.matches.find((m) => m.match_key === s?.match_key) || r.matches[0] || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useLiveRefetch(load);

  useEffect(() => {
    if (!sel) return;
    setLink(sel.youtube_key || "");
    setSummary(sel.film_summary || "");
    setEvents(sel.film_events || []);
    setEditing(false);
  }, [sel?.match_key]);

  const videoSrc = useMemo(
    () => youtubeEmbedUrl(link || sel?.video_url || sel?.youtube_key || ""),
    [link, sel],
  );

  async function saveFilm() {
    if (!sel) return;
    try {
      await api("/api/admin/match/youtube", {
        method: "POST",
        body: { match_key: sel.match_key, youtube_key: youtubeId(link) || link.trim(), film_summary: summary, film_events: events },
      });
      toast("Film saved for this match", "ok");
      const savedKey = youtubeId(link) || link.trim();
      const savedVideoUrl = youtubeEmbedUrl(savedKey);
      setMatches((ms) => ms.map((m) => (m.match_key === sel.match_key
        ? { ...m, youtube_key: savedKey, video_url: savedVideoUrl, film_summary: summary, film_events: events } : m)));
      setSel((m) => (m ? { ...m, youtube_key: savedKey, video_url: savedVideoUrl, film_summary: summary, film_events: events } : m));
      setEditing(false);
    } catch (e: any) {
      toast(e.message || "Could not save", "err");
    }
  }

  // Film review is a strategy tool. The nav hides it for scouters; this is
  // the guard for anyone who types the URL. The API keeps film editing behind
  // the same roles, so this is presentation, not the security boundary.
  if (session && !session.is_admin) {
    return (
      <div>
        <div className="page-title"><h1>Film Review</h1></div>
        <Empty
          icon="film"
          title="Strategy and admin only"
          sub="Film review lives with the strategy team. Ask them if you need a match pulled up."
        />
      </div>
    );
  }

  if (loading) return <Loading />;
  if (!matches.length) return (<div><h1>Film Review</h1><Empty icon="film" title="No schedule loaded" sub="Set an event in the Dashboard. If it's already set, TBA hasn't published that event's schedule yet." /></div>);

  return (
    <div className="film-page">
      <div className="page-title"><h1>Film Review</h1></div>
      <p className="page-sub">Match video next to the scouting record.</p>

      <div className="card film-control-card">
        <div className="spread film-toolbar">
          <label className="field film-match-select">
            <span>Match</span>
            <select value={sel?.match_key || ""} onChange={(e) => setSel(matches.find((m) => m.match_key === e.target.value) || null)}>
              {matches.map((m) => (
                <option key={m.match_key} value={m.match_key}>
                  {matchLabel(m.comp_level, m.match_number)}{m.youtube_key ? " · video" : ""}
                </option>
              ))}
            </select>
          </label>
          {session?.is_admin && (
            <div className="film-toolbar-action">
              <button className="btn" onClick={() => setEditing((v) => !v)}>{editing ? "Close editor" : "Edit film"}</button>
            </div>
          )}
        </div>
        {sel && (
          <div className="film-alliance-preview">
            <div className="match-team-list">
              <span className="badge red">RED</span>
              {(sel.red_teams?.length ? sel.red_teams : sel.red.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                <TeamIdentity key={t.team_number} team={t} showNickname={false} />
              ))}
            </div>
            <div className="match-team-list">
              <span className="badge blue">BLUE</span>
              {(sel.blue_teams?.length ? sel.blue_teams : sel.blue.map((team_number) => ({ team_number, nickname: "" }))).map((t) => (
                <TeamIdentity key={t.team_number} team={t} showNickname={false} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid cols-2 film-grid">
        {/* Video panel */}
        <div className="card film-video-card">
          <div className="card-h"><h3>Video</h3>
            {sel?.winner && <span className={`badge ${sel.winner === "red" ? "red" : sel.winner === "blue" ? "blue" : "muted"}`}>{sel.winner.toUpperCase()} won {sel.red_score}-{sel.blue_score}</span>}
          </div>
          {videoSrc ? (
            <div className="video-frame">
              <iframe
                src={videoSrc}
                title="match film"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <div className="video-frame video-frame-empty">
              <div>
                <strong>NO VIDEO AVAILABLE</strong>
                {session?.is_admin && <span>Use Edit film to add a YouTube link.</span>}
              </div>
            </div>
          )}
        </div>

        {/* Summary + timestamped key events (the "copied" film structure) */}
        <div className="card film-detail-card">
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
                <Empty icon="clock" title="No timestamped events" sub={session?.is_admin ? "Add key moments with Edit film." : undefined} />
              )}
            </>
          )}
        </div>
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
      <div className="spread film-editor-head">
        <span className="muted" style={{ fontSize: "0.85rem", fontWeight: 600 }}>Key moments</span>
        <button className="btn sm" type="button" onClick={() => setEvents([...events, { time: "0:00", team: "", type: "Cycle", detail: "" }])}>+ Add moment</button>
      </div>
      <div className="film-events" style={{ marginBottom: 12 }}>
        {events.map((ev, i) => (
          <div key={i} className="film-event" style={{ gridTemplateColumns: "1fr", gap: 8 }}>
            <div className="row film-event-editor-row">
              <input value={ev.time} onChange={(e) => upd(i, { time: e.target.value })} placeholder="1:02" />
              <input value={ev.team} onChange={(e) => upd(i, { team: e.target.value })} placeholder="Team" />
              <input value={ev.type} onChange={(e) => upd(i, { type: e.target.value })} placeholder="Type" />
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
