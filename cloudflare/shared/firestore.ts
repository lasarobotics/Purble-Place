/** Server-only REST adapter. Production routes still proxy Render until parity. */
export interface ServiceAccount { client_email:string; private_key:string; project_id:string }
export interface Document { name:string; fields:Record<string,unknown>; createTime?:string; updateTime?:string }
export interface Write { update?:Document; delete?:string; updateMask?:{fieldPaths:string[]}; currentDocument?:{exists?:boolean;updateTime?:string}; transform?:unknown }
export class FirestoreError extends Error { constructor(public status:number,public code:string) { super(`Firestore ${code}`); } }
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const encoded=(value:unknown)=>b64(new TextEncoder().encode(JSON.stringify(value)));
export class FirestoreRest {
  private access?:{token:string;expires:number};
  private refreshing?:Promise<string>;
  private key?:Promise<CryptoKey>;
  readonly root:string;
  constructor(private account:ServiceAccount,private transport:typeof fetch=fetch) {
    if(!/^[a-z][a-z0-9-]{4,62}$/.test(account.project_id)) throw new Error("Invalid project ID");
    this.root=`https://firestore.googleapis.com/v1/projects/${account.project_id}/databases/(default)/documents`;
  }
  private async token():Promise<string> {
    if(this.access && this.access.expires>Date.now()+60000) return this.access.token;
    if(this.refreshing) return this.refreshing;
    this.refreshing=(async()=>{
      this.key ||= crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(this.account.private_key.replace(/-----[^-]+-----|\s/g,"")),c=>c.charCodeAt(0)),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
      const seconds=Math.floor(Date.now()/1000);
      const unsigned=encoded({alg:"RS256",typ:"JWT"})+"."+encoded({iss:this.account.client_email,scope:"https://www.googleapis.com/auth/datastore",aud:"https://oauth2.googleapis.com/token",iat:seconds,exp:seconds+3600});
      const signature=await crypto.subtle.sign("RSASSA-PKCS1-v1_5",await this.key,new TextEncoder().encode(unsigned));
      const response=await this.transport("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:unsigned+"."+b64(new Uint8Array(signature))}),signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new FirestoreError(response.status,"OAUTH_FAILED");
      const data=await response.json() as any;
      if(typeof data.access_token!=="string" || !Number.isFinite(data.expires_in)) throw new FirestoreError(502,"INVALID_OAUTH_RESPONSE");
      this.access={token:data.access_token,expires:Date.now()+data.expires_in*1000}; return data.access_token;
    })().finally(()=>{this.refreshing=undefined;}); return this.refreshing;
  }
  private async call(path:string,method="GET",body?:unknown,retryAuth=true):Promise<any> {
    const response=await this.transport(this.root+path,{method,headers:{Authorization:`Bearer ${await this.token()}`,"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(response.status===401 && retryAuth) { this.access=undefined; return this.call(path,method,body,false); }
    if(!response.ok) { const error=await response.json().catch(()=>({})) as any; throw new FirestoreError(response.status,error.error?.status||"REQUEST_FAILED"); }
    return response.status===204?null:response.json();
  }
  private path(path:string) {
    if(!path || path.split("/").some(v=>!v || v==="." || v==="..")) throw new Error("Invalid document path");
    return "/"+path.split("/").map(encodeURIComponent).join("/");
  }
  get(path:string,transaction?:string):Promise<Document> { return this.call(this.path(path)+(transaction?`?transaction=${encodeURIComponent(transaction)}`:"")); }
  batchGet(paths:string[]) { if(paths.length>50) throw new Error("Batch limit 50"); return this.call(":batchGet","POST",{documents:paths.map(p=>this.root.replace("https://firestore.googleapis.com/v1/","")+this.path(p))}); }
  query(structuredQuery:unknown,parent="") { return this.call((parent?this.path(parent):"")+":runQuery","POST",{structuredQuery}); }
  commit(writes:Write[],transaction?:string) { if(writes.length>50) throw new Error("Batch limit 50"); return this.call(":commit","POST",{writes,...(transaction?{transaction}:{})}); }
  async transaction(build:(tx:string)=>Promise<Write[]>) {
    for(let attempt=0;attempt<3;attempt++) {
      const {transaction}=await this.call(":beginTransaction","POST",{options:{readWrite:{}}});
      try { return await this.commit(await build(transaction),transaction); }
      catch(error) {
        await this.call(":rollback","POST",{transaction}).catch(()=>{});
        if(!(error instanceof FirestoreError) || error.code!=="ABORTED" || attempt===2) throw error;
        await new Promise(resolve=>setTimeout(resolve,50*2**attempt));
      }
    }
  }
}
