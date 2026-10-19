"use client";
import {useState} from "react";
import {api} from "@/lib/api";
import {useSnapshot} from "@/lib/snapshot";
import {ClickableTeam} from "@/components/TeamDetailModal";

function Column({row,onSave,onDelete,onDuplicate,onFinal}:{row:any;onSave:(r:any)=>Promise<void>;onDelete?:()=>void;onDuplicate?:()=>void;onFinal?:()=>void}){
 const [draft,setDraft]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const current=draft||row,items=current.items||[];
 const edit=(changes:any)=>setDraft({...current,...changes});
 const numbers=items.map((i:any)=>Number(i.team));
 const invalid=numbers.some((n:number)=>!Number.isInteger(n)||n<1||n>99999)||new Set(numbers).size!==numbers.length;
 async function save(){setBusy(true);setError("");try{await onSave(current);setDraft(null);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <section style={{minWidth:245,maxWidth:320,flex:"1 0 245px",border:"1px solid var(--border)",borderRadius:12,padding:12}}>
 <label className="field">List name<input aria-label="List name" value={current.name||""} maxLength={100} onChange={e=>edit({name:e.target.value})}/></label>
 <p className="faint">For <ClickableTeam team={{team_number:row.robot_number}} showNickname={false}/> · {row.pick_round===1?"First pick":"Second pick"}</p>
 {items.map((item:any,index:number)=><div key={index} style={{display:"flex",alignItems:"center",gap:4,marginBottom:4}}><small style={{width:22}}>{index+1}</small><input aria-label={`Rank ${index+1}`} list="event-teams" type="number" min={1} max={99999} value={item.team||""} style={{minWidth:60,width:85}} onChange={e=>edit({items:items.map((v:any,i:number)=>i===index?{...v,team:Number(e.target.value)}:v)})}/>{item.team>0&&<ClickableTeam team={{team_number:item.team}} showNickname={false}/>}<button className="btn sm" aria-label={`Move rank ${index+1} up`} disabled={!index} onClick={()=>{const next=[...items];[next[index-1],next[index]]=[next[index],next[index-1]];edit({items:next});}}>↑</button><button className="btn sm" aria-label={`Remove rank ${index+1}`} onClick={()=>edit({items:items.filter((_:any,i:number)=>i!==index)})}>×</button></div>)}
 <button className="btn sm" onClick={()=>edit({items:[...items,{team:0}]})}>Add team</button>
 <details style={{marginTop:8}}><summary>Paste team numbers</summary><textarea aria-label="Paste team numbers" placeholder="One team per line, or separated by commas" onBlur={e=>{if(!e.target.value.trim())return;edit({items:e.target.value.trim().split(/[\s,;]+/).map(n=>({team:Number(n)}))});e.target.value="";}}/></details>
 {invalid&&<p role="alert">Use valid team numbers with no duplicates.</p>}{error&&<p role="alert">{error} Your edits are retained.</p>}
 {draft&&row.version!==draft.version&&<p role="alert">This list changed elsewhere. Discard your edits to load the current version.</p>}
 <div className="btn-row" style={{marginTop:12,flexWrap:"wrap"}}><button className="btn primary sm" disabled={!draft||busy||invalid||!current.name?.trim()} onClick={save}>{busy?"Saving…":draft?"Save changes":"Saved"}</button>{draft&&<button className="btn sm" onClick={()=>{setDraft(null);setError("");}}>Discard edits</button>}{onDuplicate&&<button className="btn sm" disabled={!!draft} onClick={onDuplicate}>Duplicate</button>}{onFinal&&<button className="btn sm" disabled={!!draft} onClick={onFinal}>Copy to final</button>}{onDelete&&<button className="btn sm" onClick={onDelete}>Delete</button>}</div>
 </section>;
}
export default function FinalPicklistPage(){
 const final=useSnapshot("/api/picklists/final-workspace"),simulations=useSnapshot<any[]>("/api/picklists/mine"),teams=useSnapshot("/api/pages/analysis");
 const [round,setRound]=useState(1),[robot,setRobot]=useState(418),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 async function perform(fn:()=>Promise<any>){setBusy(true);setError("");try{await fn();await Promise.all([final.refresh(),simulations.refresh()]);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 async function action(action:string,data:any={}){return api("/api/picklists/final-workspace",{method:"POST",body:{event_key:final.data?.event_key,version:final.data?.version,action,data}});}
 const rows=(simulations.data||[]).filter(r=>r.robot_number===robot&&r.pick_round===round);
 const board=final.data?.boards?.find((b:any)=>b.robot_number===robot&&b.pick_round===round);
 return <div><div className="page-title"><h1>Final Picklist</h1><p className="faint">Admin working lists and side-by-side simulations. Publishing updates Home; individual submissions stay separate.</p></div>
 <datalist id="event-teams">{(teams.data?.teams||[]).map((t:any)=><option value={t.team} key={t.team}>{t.nickname}</option>)}</datalist>
 <div className="card"><div className="row" style={{gap:12,flexWrap:"wrap"}}><label>For robot <select value={robot} onChange={e=>setRobot(Number(e.target.value))}>{(final.data?.robots||[]).map((r:any)=><option key={r.team_number} value={r.team_number}>{r.team_number} · {r.name}</option>)}</select></label><div className="seg">{[1,2].map(n=><button key={n} className={round===n?"on":""} onClick={()=>setRound(n)}>{n===1?"First pick":"Second pick"}</button>)}</div>
 <button className="btn" disabled={busy} onClick={()=>{const n=Number(prompt("Robot team number"));if(Number.isInteger(n)&&n>0)void perform(()=>action("add_robot",{robot_number:n,name:`Team ${n}`}));}}>Add robot</button>
 <button className="btn primary" disabled={busy||!final.data} onClick={()=>{if(confirm("Publish the saved final lists for all robots to Home?"))void perform(()=>action("publish"));}}>Publish all final lists</button>
 {final.data?.published&&<button className="btn" disabled={busy} onClick={()=>{if(confirm("Remove the published lists from Home? Saved lists will remain."))void perform(()=>action("unpublish"));}}>Unpublish</button>}</div></div>
 {(error||final.error)&&<p role="alert">{error||final.error}</p>}
 <h2>Official working list</h2>{board&&<Column key={`final-${robot}-${round}`} row={{...board,version:final.data.version}} onSave={async r=>{await api("/api/picklists/final-workspace",{method:"POST",body:{event_key:final.data.event_key,version:r.version,action:"edit",data:{robot_number:robot,pick_round:round,items:r.items}}});await final.refresh();}}/>}
 <div className="page-title" style={{marginTop:28}}><h2>Simulated picklists</h2><button className="btn" disabled={busy} onClick={()=>{const name=prompt("Simulation name");if(name?.trim())void perform(()=>api("/api/picklists/workspace",{method:"POST",body:{event_key:final.data?.event_key,name,robot_number:robot,robot_name:`Team ${robot}`}}));}}>New simulation</button></div>
 <p className="faint">Compare columns side by side. Edit cells, move teams up, or paste a list. Save before copying to the official working list.</p>
 <div style={{display:"flex",gap:12,overflowX:"auto",alignItems:"flex-start",paddingBottom:16}}>{rows.map(row=><Column key={row.id} row={row} onSave={async r=>{await api(`/api/picklists/${row.id}`,{method:"PUT",body:{...r,event_key:final.data?.event_key}});await simulations.refresh();}} onDelete={()=>{if(confirm(`Delete ${row.name}?`))void perform(()=>api(`/api/picklists/${row.id}?event=${encodeURIComponent(row.event_key)}`,{method:"DELETE"}));}} onDuplicate={()=>void perform(()=>api("/api/picklists",{method:"POST",body:{...row,name:`${row.name} copy`,version:undefined}}))} onFinal={()=>{if(confirm(`Replace the saved ${round===1?"first":"second"}-pick final working list for team ${robot}?`))void perform(()=>action("edit",{robot_number:robot,pick_round:round,items:row.items}));}}/>)}</div>
 </div>;
}
