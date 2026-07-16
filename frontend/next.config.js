/** @type {import('next').NextConfig} */

// Build targets:
//   default                      -> normal server build (next dev / next start)
//   HAZEHUB_STATIC_EXPORT=1      -> static site in out/ (Azure Static Web Apps)
//   HAZEHUB_STANDALONE=1         -> self-contained server in .next/standalone
//                                   (used by the Dockerfile / Container Apps)
const isStaticExport = process.env.HAZEHUB_STATIC_EXPORT === "1";
const isStandalone = process.env.HAZEHUB_STANDALONE === "1";

const nextConfig = {
  reactStrictMode: true,
  // Don't fail the production build on lint warnings.
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  ...(isStaticExport ? { output: "export" } : {}),
  ...(isStandalone ? { output: "standalone" } : {}),
};

module.exports = nextConfig;
