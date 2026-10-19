"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { api,apiBase } from "./api";
import { db } from "./db";
import { localOwner } from "./identity";
import { useLiveRefetch } from "./bus";
const memory=new Map<string,any>();
export function useSnapshot<T=any>(path:string) {
  const owner=localOwner(), key=`${apiBase()}|${owner}|${path}`;
  const [data,setData]=useState<T|null>(()=>memory.get(key)||null);
  const [error,setError]=useState("");const generation=useRef(0);
  useEffect(()=>{
    let active=true;setData(memory.get(key)||null);
    void db().responses.get(key).then(row=>{if(active&&row&&localOwner()===owner)setData(old=>old||JSON.parse(row.json));}).catch(()=>{});
    return()=>{active=false;};
  },[key,owner]);
  const refresh=useCallback(async()=>{
    const g=++generation.current;
    try {const next=await api<T>(path);if(g!==generation.current||localOwner()!==owner)return;
      if(memory.size>=100)memory.delete(memory.keys().next().value!);memory.set(key,next);setData(next);setError("");
    } catch(e:any){if(g===generation.current)setError(e.message||"Could not refresh");}
  },[path,key,owner]);
  useLiveRefetch(refresh);
  return {data,error,refresh};
}
