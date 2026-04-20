import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// Ensure tests pick up the project's .env (if present) so Prisma's schema
// parser, Redis client, and friends see DATABASE_URL/REDIS_URL.
loadDotenv({ path: resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "src/server/routers/__tests__/**/*.test.ts",
      "src/server/services/__tests__/**/*.test.ts",
    ],
    globals: false,
    // Router integration tests hit the real Postgres + Redis and need a
    // generous timeout for the first connection handshake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      ...(process.env.REDIS_URL ? { REDIS_URL: process.env.REDIS_URL } : {}),
    },
  },
  resolve: {
    alias: [
      // Stub `@/server/auth` before the `@` wildcard — router tests never
      // execute the real next-auth handler and it pulls a next/server chain
      // that doesn't resolve cleanly under vitest ESM.
      {
        find: /^@\/server\/auth$/,
        replacement: resolve(__dirname, "src/server/routers/__tests__/auth-stub.ts"),
      },
      { find: "@forge/plugins", replacement: resolve(__dirname, "plugins") },
      { find: /^@\//, replacement: resolve(__dirname, "src") + "/" },
      // `server-only` throws on import in a non-React-Server context.
      // Swap it for the empty variant in tests so server modules import cleanly.
      {
        find: "server-only",
        replacement: resolve(__dirname, "node_modules/server-only/empty.js"),
      },
    ],
  },
});
