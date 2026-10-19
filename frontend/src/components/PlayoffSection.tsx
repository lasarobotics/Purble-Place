"use client";
import { useSnapshot } from "@/lib/snapshot";
import { ClickableTeam } from "./TeamDetailModal";
export function PlayoffSection(){
 const {data}=useSnapshot("/api/pages/external");
 const alliances=data?.alliances;
 if(!Array.isArray(alliances)||!alliances.length)return null;
 const matches=(data?.official_matches||[]).filter((m:any)=>m.comp_level!=="qm").sort((a:any,b:any)=>(a.time||0)-(b.time||0)||a.set_number-b.set_number||a.match_number-b.match_number);
 return <section style={{marginTop:24}}><div className="page-title"><h2>Official playoff alliances</h2><p className="faint">TBA selections and scheduled playoff rounds. Pairings follow the event schedule, including lower-bracket matches when scheduled.</p></div>
 <div className="table-wrap"><table className="data"><thead><tr><th>Alliance</th><th>Captain</th><th>First pick</th><th>Second pick</th><th>Backup</th><th>Status</th></tr></thead><tbody>{alliances.map((a:any,i:number)=><tr key={i}><td>{a.name||`Alliance ${i+1}`}</td>{[0,1,2].map(n=><td key={n}>{a.picks?.[n]?<ClickableTeam team={{team_number:Number(a.picks[n].replace("frc",""))}}/>:"—"}</td>)}<td>{a.backup?.in?<ClickableTeam team={{team_number:Number(a.backup.in.replace("frc",""))}}/>:"—"}</td><td>{a.status?.status||"Selected"}{a.status?.level?` · ${a.status.level}`:""}</td></tr>)}</tbody></table></div>
 {!!matches.length&&<div className="card" style={{marginTop:16}}><h3>Official playoff match progression</h3><div style={{display:"grid",gap:12}}>{matches.map((m:any)=><article className="event-match-card" key={m.key}><header><b>{m.comp_level.toUpperCase()} {m.set_number} · Match {m.match_number}</b><span>{m.winning_alliance?`${m.winning_alliance} wins`:"Upcoming / awaiting result"}</span></header>{["red","blue"].map(color=><div className={`event-alliance ${color} ${m.winning_alliance===color?"winner":""}`} key={color}><span>{color}</span><span className="event-team-numbers">{m.alliances[color].team_keys.map((k:string)=><ClickableTeam key={k} team={{team_number:Number(k.replace("frc",""))}} showNickname={false}/>)}</span><strong>{m.alliances[color].score>=0?m.alliances[color].score:"—"}</strong></div>)}</article>)}</div></div>}</section>;
}
