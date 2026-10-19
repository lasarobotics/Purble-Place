import { spawnSync } from "node:child_process";
import { readdir,readFile } from "node:fs/promises";
const result=spawnSync(process.platform==="win32"?"npm.cmd":"npm",["run","build"],{cwd:"../frontend",env:{...process.env,HAZEHUB_STATIC_EXPORT:"1",NEXT_PUBLIC_API_URL:""},stdio:"inherit",shell:process.platform==="win32"});
if(result.status!==0) process.exit(result.status||1);
const paths=await readdir("../frontend/out",{recursive:true});
for(const path of paths.filter(p=>p.endsWith(".js")||p.endsWith(".html"))) {
  const text=await readFile(`../frontend/out/${path}`,"utf8");
  if(/https?:\/\/localhost:8000|https?:\/\/127\.0\.0\.1:8000/.test(text)) throw new Error(`Local API URL embedded in ${path}`);
}
if(!(await readFile("../frontend/out/index.html","utf8")).includes('name="mobile-web-app-capable"')) throw new Error("Mobile PWA metadata missing");
console.log("Static export verified: no localhost API URLs; mobile PWA metadata present.");
