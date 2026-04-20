import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  serverExternalPackages: ["ioredis"],
  eslint: {
    // Lint in CI / pre-commit via `pnpm lint`; don't gate production
    // build on warnings.
    ignoreDuringBuilds: true,
  },
  webpack: (config, { nextRuntime }) => {
    // Middleware forces an edge-runtime bundle pass even for server-only
    // code. ioredis can't be bundled for edge — mark as external there.
    if (nextRuntime === "edge") {
      config.externals = [...(config.externals ?? []), "ioredis"];
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
