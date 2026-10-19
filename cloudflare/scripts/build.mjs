import { build } from "esbuild";
await build({ entryPoints: ["gateway/index.ts", "domain/index.ts", "shared/firestore.ts"], outdir: "dist", outbase: ".", bundle: true, format: "esm", target: "es2022", external: ["cloudflare:workers"] });
