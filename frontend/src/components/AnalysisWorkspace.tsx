"use client";
import { useEffect,useMemo,useState } from "react";
import { useSnapshot } from "@/lib/snapshot";
import { useAuth } from "@/lib/auth";
import { ClickableTeam } from "./TeamDetailModal";
import { MetricLabel } from "./MetricLabel";
import ComparePage from "@/app/(app)/admin/compare/page";
import TeamSearchPage from "@/app/(app)/admin/team-search/page";

type Column={key:string;label:string;source:string};
const externalColumns:Column[]=[
 {key:"tba_rank",label:"Official rank",source:"TBA"},{key:"tba_rs",label:"Ranking score",source:"TBA"},{key:"tba_opr",label:"OPR",source:"TBA"},
 {key:"sb_epa",label:"EPA",source:"Statbotics"},{key:"sb_auto",label:"Auto EPA",source:"Statbotics"},{key:"sb_tele",label:"Teleop EPA",source:"Statbotics"},{key:"sb_end",label:"Endgame EPA",source:"Statbotics"},
 ...[["xp","xP"],["x_auto","xAuto"],["x_tele","xTele"],["x_end","xEnd"],["match13_sos","SOS"],["match13_epa","EPA"],["opr","OPR"]].map(([key,label])=>({key,label,source:"Match13"}))
];
export function AnalysisWorkspace(){
 const {session}=useAuth();const internal=useSnapshot("/api/pages/analysis"),external=useSnapshot("/api/pages/external");
 const [tab,setTab]=useState("Overview"),[search,setSearch]=useState(""),[sort,setSort]=useState("avg_points"),[ascending,setAscending]=useState(false),[hidden,setHidden]=useState<string[]>([]),[prefReady,setPrefReady]=useState(false);
 const pref=`hazehub.analysis-layout.v1.${session?.scout_id}`;
 useEffect(()=>{try{setHidden(JSON.parse(localStorage.getItem(pref)||"[]"));}catch{setHidden([]);}setPrefReady(true);},[pref]);
 useEffect(()=>{if(prefReady)localStorage.setItem(pref,JSON.stringify(hidden));},[hidden,pref,prefReady]);
 const columns=useMemo(()=>{const basic:Column[]=(internal.data?.metrics||[]).map((m:any)=>({key:m.key,label:m.label,source:"Purble Place"}));
  for(const [key,label] of [["l4m_defense_capability","L4M Defense Capability"],["l4m_consistency","L4M Consistency"],["l4m_skew_distribution","L4M Skew Distribution"],["l4m_failure_rate","L4M Failure Rate"],["l4m_climb_success_rate","L4M Climb Success Rate"],["ranking_point_prediction","Ranking Point Prediction"]])if(!basic.some(c=>c.key===key))basic.push({key,label,source:"Purble Place"});
  return [...basic,...externalColumns];},[internal.data]);
 const rows=useMemo(()=>{const map=new Map<number,any>((internal.data?.teams||[]).map((r:any)=>[r.team,{...r}]));const get=(n:number)=>{if(!map.has(n))map.set(n,{team:n,matches:0});return map.get(n);};
  for(const r of external.data?.rankings?.rankings||[]){const n=Number(r.team_key?.replace("frc",""));if(n)Object.assign(get(n),{tba_rank:r.rank,tba_rs:r.sort_orders?.[0]});}
  for(const [key,value] of Object.entries(external.data?.oprs?.oprs||{}))get(Number(key.replace("frc",""))).tba_opr=value;
  for(const r of external.data?.statbotics_teams||[]){const e=r.epa||{};Object.assign(get(r.team),{sb_epa:e.total_points?.mean,sb_auto:e.breakdown?.auto_points,sb_tele:e.breakdown?.teleop_points,sb_end:e.breakdown?.endgame_points});}
  for(const [n,r] of Object.entries(external.data?.match13||{}))Object.assign(get(Number(n)),r);
  return [...map.values()].filter(r=>`${r.team} ${r.nickname||""}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>{const av=a[sort],bv=b[sort];if(av==null)return 1;if(bv==null)return -1;return (Number(av)-Number(bv))*(ascending?1:-1);});
 },[internal.data,external.data,search,sort,ascending]);
 return <div><div className="seg" style={{marginBottom:16}}>{["Overview","Compare","Team search"].map(t=><button key={t} className={tab===t?"on":""} onClick={()=>setTab(t)}>{t}</button>)}</div>
 {tab==="Compare"?<ComparePage/>:tab==="Team search"?<TeamSearchPage/>:<><div className="card"><label className="field">Search teams<input value={search} onChange={e=>setSearch(e.target.value)}/></label>
 <details><summary>Sources and columns</summary><div className="row" style={{flexWrap:"wrap",gap:16}}>{["Purble Place","TBA","Statbotics","Match13"].map(source=><label key={source}><input type="checkbox" checked={!hidden.includes(`source:${source}`)} onChange={()=>setHidden(h=>h.includes(`source:${source}`)?h.filter(x=>x!==`source:${source}`):[...h,`source:${source}`])}/>{source}</label>)}<button className="btn sm" onClick={()=>setHidden([])}>Reset to default</button></div><div className="grid" style={{gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",marginTop:12}}>{columns.map(c=><label key={c.source+c.key}><input type="checkbox" checked={!hidden.includes(c.key)} onChange={()=>setHidden(h=>h.includes(c.key)?h.filter(x=>x!==c.key):[...h,c.key])}/>{c.source} · {c.label}</label>)}</div></details></div>
 {internal.error&&<p role="alert">{internal.error} <button className="btn sm" onClick={internal.refresh}>Retry</button></p>}
 <p className="faint">External providers are shown separately. Missing data is —, never zero. Select a team for heatmaps, notes, pit reports and match history.</p>
 <div className="table-wrap"><table className="data"><thead><tr><th>Team</th><th>Reports</th>{columns.filter(c=>!hidden.includes(c.key)&&!hidden.includes(`source:${c.source}`)).map(c=><th key={c.source+c.key}><button className="analysis-sort" onClick={()=>{setAscending(sort===c.key?!ascending:false);setSort(c.key);}}><small>{c.source}</small><br/><MetricLabel metric={c.key}>{c.label}</MetricLabel>{sort===c.key?(ascending?" ↑":" ↓"):""}</button></th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.team}><td><ClickableTeam team={{team_number:r.team,nickname:r.nickname||""}}/></td><td>{r.matches||0}</td>{columns.filter(c=>!hidden.includes(c.key)&&!hidden.includes(`source:${c.source}`)).map(c=><td className="num" key={c.source+c.key}>{typeof r[c.key]==="number"&&Number.isFinite(r[c.key])?r[c.key].toLocaleString(undefined,{maximumFractionDigits:3}):"—"}</td>)}</tr>)}</tbody></table></div>{!rows.length&&<p className="faint">{internal.data?"No teams match this view.":"Loading saved analysis…"}</p>}</>}
 </div>;
}
