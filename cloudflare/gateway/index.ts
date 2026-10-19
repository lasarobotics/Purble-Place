export interface Env { ASSETS?: Fetcher; RENDER?: Fetcher }
const ORIGIN = "https://hazehub.onrender.com";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/ws")
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("HazeHub gateway");
    const id = crypto.randomUUID(), started = performance.now();
    const headers = new Headers(request.headers);
    headers.delete("Host"); headers.set("X-Forwarded-Host",url.host);
    headers.set("X-Forwarded-Proto",url.protocol.replace(":","")); headers.set("X-Correlation-ID",id);
    const upstream = new Request(new URL(url.pathname+url.search,ORIGIN),{method:request.method,headers,body:request.body,redirect:"manual",signal:AbortSignal.timeout(30000)});
    try {
      const response = env.RENDER ? await env.RENDER.fetch(upstream) : await fetch(upstream,{cf:{cacheTtl:0,cacheEverything:false}});
      if (response.status === 101) return response;
      const out = new Response(response.body,response);
      out.headers.set("Cache-Control",url.pathname.startsWith("/api/auth/")?"private, no-store":"private, no-cache");
      out.headers.set("CDN-Cache-Control","no-store"); out.headers.set("Cloudflare-CDN-Cache-Control","no-store");
      out.headers.set("X-Correlation-ID",id); out.headers.set("Server-Timing",`gateway;dur=${(performance.now()-started).toFixed(2)}`);
      const location=out.headers.get("Location");
      if(location?.startsWith(ORIGIN+"/")) out.headers.set("Location",location.slice(ORIGIN.length));
      console.log(JSON.stringify({id,status:response.status,duration_ms:Math.round(performance.now()-started)}));
      return out;
    } catch {
      return Response.json({detail:"Backend temporarily unavailable. Your locally saved reports can retry.",correlation_id:id},{status:503,headers:{"Cache-Control":"private, no-store","Retry-After":"15"}});
    }
  }
} satisfies ExportedHandler<Env>;
