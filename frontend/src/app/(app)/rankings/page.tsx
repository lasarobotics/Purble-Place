"use client";
import { useSnapshot } from "@/lib/snapshot";
import { ClickableTeam } from "@/components/TeamDetailModal";
import { PlayoffSection } from "@/components/PlayoffSection";
export default function RankingsPage(){
 const {data,error}=useSnapshot("/api/pages/external");
 const rankings=data?.rankings;
 return <div><div className="page-title"><h1>Rankings</h1><p className="faint">Official TBA event standings · {data?.event}</p></div>
 {error&&<p role="alert">{error}</p>}
 <div className="rankings-layout"><section className="card" style={{minWidth:0}}><h2>Official rankings</h2><div className="table-wrap"><table className="data"><thead><tr><th>Rank</th><th>Team</th><th>W–L–T</th><th>Played</th>{(rankings?.sort_order_info||[]).map((s:any,i:number)=><th key={i}>{s.name}</th>)}</tr></thead><tbody>{(rankings?.rankings||[]).map((r:any)=><tr key={r.team_key}><td>{r.rank}</td><td><ClickableTeam team={{team_number:Number(r.team_key.replace("frc",""))}}/></td><td>{r.record?`${r.record.wins}–${r.record.losses}–${r.record.ties}`:"—"}</td><td>{r.matches_played??"—"}</td>{(r.sort_orders||[]).map((v:number,i:number)=><td key={i}>{Number(v).toLocaleString(undefined,{maximumFractionDigits:3})}</td>)}</tr>)}</tbody></table></div>{!rankings?.rankings?.length&&<p className="faint">Official rankings are not available for this event yet.</p>}</section>
 <aside className="card"><h2>Match13 Simulate</h2><p className="faint">{data?.match13_simulation?.reason||"Loading provider availability…"}</p><p>Official standings and projections are separate. Unavailable projections are never filled with estimated ranks.</p></aside></div>
 <PlayoffSection/></div>;
}
