import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
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
