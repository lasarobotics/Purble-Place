/** @type {import('next').NextConfig} */

// When building for Azure Static Web Apps, set HAZEHUB_STATIC_EXPORT=1 to emit
// a fully static site (out/). Locally we use the normal dev/server build.
const isStaticExport = process.env.HAZEHUB_STATIC_EXPORT === "1";

const nextConfig = {
  reactStrictMode: true,
  // Don't fail the production build on lint warnings.
  eslint: { ignoreDuringBuilds: true },
  images: { unoptimized: true },
  ...(isStaticExport ? { output: "export" } : {}),
};

module.exports = nextConfig;
