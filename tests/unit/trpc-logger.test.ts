import { describe, expect, it } from "vitest";
import { shouldLogTrpcOperation, verboseTrpcLoggingEnabled } from "@/lib/trpc-logger";

describe("tRPC client logging", () => {
  it("keeps successful operations quiet unless verbose logging is enabled", () => {
    expect(shouldLogTrpcOperation({ direction: "up" }, false)).toBe(false);
    expect(shouldLogTrpcOperation({ direction: "down", result: { ok: true } }, false)).toBe(false);
    expect(shouldLogTrpcOperation({ direction: "up" }, true)).toBe(true);
  });

  it("always logs response errors", () => {
    expect(shouldLogTrpcOperation({ direction: "down", result: new Error("boom") }, false)).toBe(
      true,
    );
  });

  it("accepts only explicit public opt-in values", () => {
    expect(verboseTrpcLoggingEnabled("1")).toBe(true);
    expect(verboseTrpcLoggingEnabled("true")).toBe(true);
    expect(verboseTrpcLoggingEnabled("development")).toBe(false);
    expect(verboseTrpcLoggingEnabled(undefined)).toBe(false);
  });
});
