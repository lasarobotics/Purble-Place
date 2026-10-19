import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync,verify } from "node:crypto";
import { FirestoreRest } from "../dist/shared/firestore.js";

test("REST adapter signs OAuth JWTs, deduplicates token refresh, preserves preconditions and retries aborted transactions",async()=>{
  const pair=generateKeyPairSync("rsa",{modulusLength:2048});let tokens=0,commits=0,rollbacks=0;
  const calls=[];
  const transport=async(url,options)=>{
    calls.push({url,options});
    if(url.includes("oauth2")) {
      tokens++;const jwt=options.body.get("assertion");const [h,b,s]=jwt.split(".");
      assert.equal(verify("RSA-SHA256",Buffer.from(h+"."+b),pair.publicKey,Buffer.from(s,"base64url")),true);
      assert.equal(JSON.parse(Buffer.from(b,"base64url")).scope,"https://www.googleapis.com/auth/datastore");
      return Response.json({access_token:"server-token",expires_in:3600});
    }
    assert.equal(options.headers.Authorization,"Bearer server-token");
    if(url.endsWith(":beginTransaction")) return Response.json({transaction:"tx"});
    if(url.endsWith(":rollback")) {rollbacks++;return Response.json({});}
    if(url.endsWith(":commit")) {commits++;if(commits===1)return Response.json({error:{status:"ABORTED"}},{status:409});return Response.json({commitTime:"now"});}
    return Response.json({name:"doc",fields:{value:{integerValue:"123"}},updateTime:"version"});
  };
  const rest=new FirestoreRest({project_id:"hazehub-test",client_email:"test@example.invalid",private_key:pair.privateKey.export({type:"pkcs8",format:"pem"}).toString()},transport);
  await Promise.all(Array.from({length:10},()=>rest.get("teams/418")));assert.equal(tokens,1);
  await rest.transaction(async tx=>{assert.equal(tx,"tx");await rest.get("teams/418",tx);return [{update:{name:"doc",fields:{}},currentDocument:{updateTime:"version"}}];});
  assert.equal(commits,2);assert.equal(rollbacks,1);
  assert.equal(JSON.parse(calls.find(c=>c.url.endsWith(":commit")).options.body).writes[0].currentDocument.updateTime,"version");
  assert.throws(()=>rest.get("../bad"));
});
