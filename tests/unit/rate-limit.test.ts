import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, number>();
const ttls = new Map<string, number>();

vi.mock("@/server/redis", () => ({
  redis: {
    incr: vi.fn(async (k: string) => {
      const n = (store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    }),
    expire: vi.fn(async (k: string, s: number) => {
      ttls.set(k, s);
      return 1;
    }),
    ttl: vi.fn(async (k: string) => ttls.get(k) ?? -1),
  },
}));

import { rateLimit } from "@/server/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    store.clear();
    ttls.clear();
  });

  it("allows up to the limit then blocks", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await rateLimit("k", 3, 60);
      expect(r.ok).toBe(true);
    }
    const r = await rateLimit("k", 3, 60);
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("decreases remaining each call", async () => {
    const a = await rateLimit("k", 5, 60);
    const b = await rateLimit("k", 5, 60);
    expect(a.remaining).toBe(4);
    expect(b.remaining).toBe(3);
  });
});
