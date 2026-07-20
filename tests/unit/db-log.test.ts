import { describe, expect, it } from "vitest";
import { prismaLogLevels } from "@/server/db-log";

describe("prismaLogLevels", () => {
  it("keeps normal development output concise", () => {
    expect(prismaLogLevels({ NODE_ENV: "development" })).toEqual(["warn", "error"]);
  });

  it("enables query diagnostics explicitly", () => {
    expect(prismaLogLevels({ NODE_ENV: "development", FORGE_LOG_PRISMA_QUERIES: "1" })).toEqual([
      "query",
      "warn",
      "error",
    ]);
  });

  it("logs only errors in production", () => {
    expect(prismaLogLevels({ NODE_ENV: "production" })).toEqual(["error"]);
  });
});
