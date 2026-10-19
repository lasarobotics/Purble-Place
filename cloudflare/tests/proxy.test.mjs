import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare,convertV4MiniflareOptions,Log,LogLevel } from "miniflare";

test("same-origin proxy preserves methods, body, cookies, statuses, ETag and WebSockets",async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({log:new Log(LogLevel.ERROR),workers:[
    {name:"gateway",modules:true,scriptPath:"dist/gateway/index.js",compatibilityDate:"2026-10-01",serviceBindings:{RENDER:"origin"}},
    {name:"origin",modules:true,compatibilityDate:"2026-10-01",script:`export default {async fetch(r) {
      const u=new URL(r.url);
      if(u.pathname==='/ws'){ const [a,b]=Object.values(new WebSocketPair());b.accept();b.addEventListener('message',e=>b.send(e.data));return new Response(null,{status:101,webSocket:a}); }
      if(u.pathname==='/api/fail') throw new Error('unavailable');
      if(u.pathname==='/api/auth/me') return Response.json({detail:'Not signed in'},{status:401});
      if(r.headers.has('If-None-Match')) return new Response(null,{status:304,headers:{ETag:'"r1"'}});
      return Response.json({method:r.method,url:r.url,body:await r.text(),authorization:r.headers.get('Authorization'),cookie:r.headers.get('Cookie')},{headers:{'Set-Cookie':'hazehub_session=test; HttpOnly; Secure; SameSite=Lax; Path=/api/auth',ETag:'"r1"'}});
    }} `}
  ]}));
  try {
    const r=await mf.dispatchFetch("https://staging.test/api/auth/account-status?x=1",{method:"POST",body:'{"scout_id":"Scout"}',headers:{Authorization:"Bearer test",Cookie:"hazehub_session=test"}});
    const data=await r.json(); assert.equal(data.url,"https://hazehub.onrender.com/api/auth/account-status?x=1");
    assert.equal(data.method,"POST");assert.equal(data.body,'{"scout_id":"Scout"}');assert.equal(data.authorization,"Bearer test");assert.equal(data.cookie,"hazehub_session=test");
    assert.match(r.headers.get("Cache-Control"),/no-store/);assert.match(r.headers.get("Set-Cookie"),/HttpOnly/);
    assert.equal((await mf.dispatchFetch("https://staging.test/api/auth/me")).status,401);
    assert.equal((await mf.dispatchFetch("https://staging.test/api/data",{headers:{"If-None-Match":'"r1"'}})).status,304);
    const upgraded=await mf.dispatchFetch("https://staging.test/ws",{headers:{Upgrade:"websocket"}});
    assert.equal(upgraded.status,101);const ws=upgraded.webSocket;ws.accept();
    const echoed=new Promise(resolve=>ws.addEventListener("message",e=>resolve(e.data),{once:true}));ws.send("ping");assert.equal(await echoed,"ping");ws.close();
  } finally {await mf.dispose();}
});
