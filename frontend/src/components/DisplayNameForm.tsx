"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
export function DisplayNameForm() {
  const {session,refresh}=useAuth();const [name,setName]=useState(session?.display_name||"");const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  return <form className="card" onSubmit={async e=>{e.preventDefault();setBusy(true);try{await api("/api/auth/profile",{method:"PUT",body:{display_name:name.trim()}});await refresh();setError("Name saved");}catch(e:any){setError(e.message);}finally{setBusy(false);}}}>
    <h2>{session?.name_confirmed?"Display name":"What name should we show?"}</h2><p className="faint">Your name appears with your scouting reports and picklists. Your account ID stays the same.</p>
    <label className="field">Display name<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)} /></label>
    <button className="btn primary" disabled={busy||!name.trim()||!!session?.offline_until}>{busy?"Saving…":"Save name"}</button>{error&&<p role="status">{error}</p>}
  </form>;
}
