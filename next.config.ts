import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  serverExternalPackages: ["ioredis", "bullmq"],
  eslint: {
    // Lint in CI / pre-commit via `pnpm lint`; don't gate production
    // build on warnings.
    ignoreDuringBuilds: true,
  },
  webpack: (config, { nextRuntime }) => {
    // Middleware forces an edge-runtime bundle pass even for server-only
    // code. ioredis + bullmq can't be bundled for edge — mark as external
    // there so the instrumentation hook (which boots the BullMQ workers
    // in-process) doesn't drag node:* builtins into the edge graph.
    // The function-form catches every `node:*` builtin since BullMQ pulls
    // node:crypto / node:net / node:worker_threads transitively.
    if (nextRuntime === "edge") {
      const existing = config.externals ?? [];
      config.externals = [
        ...(Array.isArray(existing) ? existing : [existing]),
        "ioredis",
        "bullmq",
        ({ request }: { request?: string }, callback: (err?: Error | null, result?: string) => void) => {
          if (request && request.startsWith("node:")) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
  // Prisma's generated client and engines are loaded dynamically so
  // Next's trace doesn't pick them up. Include them explicitly so the
  // standalone bundle runs without node_modules on the side.
  outputFileTracingIncludes: {
    "*": [
      "./node_modules/.pnpm/@prisma+client*/**/*",
      "./node_modules/.pnpm/prisma*/**/*",
      "./node_modules/@prisma/client/**/*",
      "./prisma/schema.prisma",
    ],
  },
  async rewrites() {
    return [
      // The in-app VitePress docs live under /public/docs/ as static
      // files. With `cleanUrls: false` in vitepress config, the home
      // page is `index.html` — but Next's default trailing-slash
      // redirect rewrites `/docs/` → `/docs`, which then 404s because
      // the public folder doesn't auto-extension-resolve. Map both
      // `/docs` and `/docs/` to the index file so the iframe lands.
      { source: "/docs", destination: "/docs/index.html" },
      { source: "/docs/", destination: "/docs/index.html" },
    ];
  },
  async headers() {
    return [
      // Default: deny framing site-wide (clickjacking guard).
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      // Override for the in-app VitePress docs at /docs/*. The workspace
      // /docs route iframes this path; SAMEORIGIN keeps clickjacking
      // guards in place while letting the Forge shell embed it.
      // VitePress static assets (HTML, JS, CSS, images) all live under
      // /docs/ in the public dir thanks to `base: "/docs/"` in
      // docs/.vitepress/config.ts, so the two matchers below cover the
      // whole site.
      {
        source: "/docs",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      {
        source: "/docs/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default config;
