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
  async headers() {
    return [
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
    ];
  },
};

export default config;
