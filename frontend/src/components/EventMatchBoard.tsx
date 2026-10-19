"use client";
import { useMemo, useState } from "react";
import { useSchedule } from "@/lib/schedule";
import { useSnapshot } from "@/lib/snapshot";
import { ClickableTeam } from "./TeamDetailModal";
const HOME=new Set([418,436]);
const levels:Record<string,number>={qm:0,ef:1,qf:2,sf:3,f:4};
const labels:Record<string,string>={qm:"Qualification",ef:"Round of 16",qf:"Quarterfinal",sf:"Playoff",f:"Final"};
export function together(red:number[],blue:number[],a:number,b:number){return red.includes(a)&&red.includes(b)||blue.includes(a)&&blue.includes(b);}
export function against(red:number[],blue:number[],a:number,b:number){return red.includes(a)&&blue.includes(b)||blue.includes(a)&&red.includes(b);}
function time(value?:number|null){return value?new Date(value*1000).toLocaleString(undefined,{weekday:"short",hour:"numeric",minute:"2-digit"}):"Time TBD";}
export function EventMatchBoard({mode}:{mode:"results"|"schedule"}){
 const schedule=useSchedule(),sources=useSnapshot("/api/pages/external");
 const [a,setA]=useState(""),[b,setB]=useState(""),[relation,setRelation]=useState("team"),[round,setRound]=useState("all"),[status,setStatus]=useState(mode==="results"?"completed":"all"),[sort,setSort]=useState("upcoming");
 const rows=useMemo(()=>{
  const official=new Map<string,any>((sources.data?.official_matches||[]).map((m:any)=>[m.key,m]));
  return schedule.matches.map(m=>({...m,official:official.get(m.match_key)})).filter(m=>{
   const complete=m.red_score!=null&&m.blue_score!=null&&m.red_score>=0&&m.blue_score>=0;
   if(status==="completed"&&!complete||status==="upcoming"&&complete)return false;
   if(round==="qm"&&m.comp_level!=="qm"||round==="playoff"&&m.comp_level==="qm")return false;
   if(!a)return true;const x=Number(a),y=Number(b);
   return relation==="together"?!!b&&together(m.red,m.blue,x,y):relation==="against"?!!b&&against(m.red,m.blue,x,y):[...m.red,...m.blue].includes(x);
  }).sort((x,y)=>{
   const order=(m:any)=>(levels[m.comp_level]??9)*10000+(m.official?.set_number||0)*100+m.match_number;
   if(sort==="time")return (x.official?.time||x.predicted_time||Infinity)-(y.official?.time||y.predicted_time||Infinity);
   if(sort==="recent")return (y.official?.actual_time||0)-(x.official?.actual_time||0)||order(y)-order(x);
   if(sort==="upcoming"){const c=(m:any)=>m.red_score!=null&&m.red_score>=0?1:0;return c(x)-c(y)||order(x)-order(y);}
   return (order(x)-order(y))*(sort==="desc"?-1:1);
  });
 },[schedule.matches,sources.data,a,b,relation,round,status,sort]);
 return <><div className="card"><div className="row" style={{flexWrap:"wrap",gap:12}}>
 <label className="field">Team<input type="number" min="1" value={a} onChange={e=>setA(e.target.value)} placeholder="All teams"/></label>
 <label className="field">Relationship<select value={relation} onChange={e=>setRelation(e.target.value)}><option value="team">Any alliance</option><option value="together">Together with</option><option value="against">Against</option></select></label>
 {relation!=="team"&&<label className="field">Other team<input type="number" min="1" value={b} onChange={e=>setB(e.target.value)}/></label>}
 <label className="field">Round<select value={round} onChange={e=>setRound(e.target.value)}><option value="all">All rounds</option><option value="qm">Qualifications</option><option value="playoff">Playoffs</option></select></label>
 <label className="field">Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All matches</option><option value="upcoming">Upcoming</option><option value="completed">Completed</option></select></label>
 <label className="field">Sort<select value={sort} onChange={e=>setSort(e.target.value)}><option value="upcoming">Upcoming first</option><option value="asc">Match ascending</option><option value="desc">Match descending</option><option value="time">Scheduled time</option><option value="recent">Most recent completed</option></select></label></div>
 <div className="row" style={{gap:8,marginTop:12}}>{[418,436].map(n=><button className="btn sm" key={n} onClick={()=>{setA(String(n));setRelation("team");}}>★ {n}</button>)}<button className="btn sm" onClick={()=>{setA("");setB("");setRelation("team");setRound("all");setStatus("all");}}>All matches</button></div></div>
 <p className="faint">{schedule.event} · {rows.length} matches · {schedule.source==="cache"?"Saved offline schedule":"Official schedule and results"}</p>
 <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:16}}>{rows.map(m=>{
 const completed=m.red_score!=null&&m.blue_score!=null&&m.red_score>=0&&m.blue_score>=0;
 const prediction=(sources.data?.statbotics_matches||[]).find((r:any)=>r.key===m.match_key)?.pred;
 return <article className={`event-match-card${[...m.red,...m.blue].some(t=>HOME.has(t))?" highlighted":""}`} key={m.match_key}>
 <header><div><b>{labels[m.comp_level]||m.comp_level} {m.official?.set_number>1?`${m.official.set_number} · `:""}{m.match_number}</b><span>{time(m.official?.actual_time||m.official?.time||m.predicted_time)}</span></div><span className="badge">{completed?"Completed":"Upcoming"}</span></header>
 {(["red","blue"] as const).map(color=><div className={`event-alliance ${color} ${m.winner===color?"winner":""}`} key={color}><span className="event-alliance-name">{color}{m.winner===color?" · Winner":""}</span><span className="event-team-numbers">{m[color].map(team=>{
 const alliance=m.official?.alliances?.[color],excluded=alliance?.dq_team_keys?.includes(`frc${team}`)||alliance?.surrogate_team_keys?.includes(`frc${team}`);
 const rp=completed&&m.comp_level==="qm"&&!excluded?m.official?.score_breakdown?.[color]?.rp:null;
 return <span key={team} style={{display:"inline-flex",alignItems:"center",gap:4}}>{HOME.has(team)&&<span style={{color:"#b68aff"}} aria-label="Home team">★</span>}<ClickableTeam team={{team_number:team}} showNickname={false}/>{rp!=null&&<small>{rp} RP</small>}</span>;
 })}</span><strong className="event-score">{completed?m[`${color}_score`]:"—"}</strong></div>)}
 {!completed&&<p className="faint" style={{padding:"8px 16px"}}>Statbotics prediction: {prediction?.red_score!=null&&prediction?.blue_score!=null?`${Math.round(prediction.red_score)} – ${Math.round(prediction.blue_score)}`:"Unavailable"}{typeof prediction?.red_win_prob==="number"?` · Red ${Math.round(prediction.red_win_prob*100)}% / Blue ${Math.round((1-prediction.red_win_prob)*100)}%`:""}. Match13 prediction: unavailable.</p>}
 </article>;})}</div>{!rows.length&&<p className="faint">{schedule.loading?"Loading saved schedule…":"No matches match these filters."}</p>}</>;
}
