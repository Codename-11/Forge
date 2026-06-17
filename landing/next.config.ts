import type { NextConfig } from "next";
import path from "node:path";

/**
 * Forge landing site — standalone Next.js app.
 *
 * `output: "export"` emits a fully static site to `out/`, so it can be
 * hosted on any static host (GitHub Pages, S3/CloudFront, Netlify, Vercel,
 * or behind the same reverse proxy as the app). No Node server required.
 *
 * If you later need server features (ISR, route handlers), drop the
 * `output` line and deploy as a normal Next server.
 */
const nextConfig: NextConfig = {
  output: "export",
  // Static export can't use the Image Optimization API.
  images: { unoptimized: true },
  // Emit `dir/index.html` so static hosts resolve clean URLs (`/releases`).
  trailingSlash: true,
  reactStrictMode: true,
  // This app has its own lockfile; pin tracing to it so Next doesn't infer
  // the parent monorepo root (the main Forge app's lockfile sits above).
  outputFileTracingRoot: path.join(import.meta.dirname, "."),
};

export default nextConfig;
