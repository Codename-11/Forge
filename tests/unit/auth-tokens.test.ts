import { describe, expect, it, vi } from "vitest";
import {
  consumeUserActionToken,
  hashUserActionToken,
  inspectUserActionToken,
  issueUserActionToken,
  newUserActionToken,
  normalizeAuthEmail,
} from "@/server/services/auth-tokens";

describe("user action tokens", () => {
  it("generates random bearer values and persists only stable digests", () => {
    const first = newUserActionToken();
    const second = newUserActionToken();
    expect(first.rawToken).not.toBe(second.rawToken);
    expect(first.rawToken).not.toContain(first.tokenHash);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashUserActionToken(first.rawToken)).toBe(first.tokenHash);
    expect(normalizeAuthEmail("  Bailey@Example.COM ")).toBe("bailey@example.com");
  });

  it("rotates an outstanding token before issuing its replacement", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi
      .fn()
      .mockImplementation(({ data }) => Promise.resolve({ id: "token-1", usedAt: null, ...data }));
    const database = { userActionToken: { updateMany, create } };

    const result = await issueUserActionToken(
      {
        userId: "user-1",
        type: "PASSWORD_RESET",
        emailSnapshot: " Bailey@Example.com ",
        ttlMinutes: 30,
        now,
      },
      database as never,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: now },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenHash: hashUserActionToken(result.rawToken),
        emailSnapshot: "bailey@example.com",
        expiresAt: new Date("2026-08-25T12:30:00.000Z"),
      }),
    });
  });

  it("distinguishes invalid, used, and expired inspection without exposing a secret", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const findUnique = vi.fn();
    const database = { userActionToken: { findUnique } } as never;

    findUnique.mockResolvedValueOnce(null);
    await expect(
      inspectUserActionToken({ rawToken: "missing", type: "PASSWORD_RESET", now }, database),
    ).resolves.toEqual({ state: "INVALID" });

    findUnique.mockResolvedValueOnce({
      type: "PASSWORD_RESET",
      usedAt: now,
      expiresAt: new Date("2026-08-25T13:00:00.000Z"),
    });
    await expect(
      inspectUserActionToken({ rawToken: "used", type: "PASSWORD_RESET", now }, database),
    ).resolves.toEqual({ state: "USED" });

    findUnique.mockResolvedValueOnce({
      type: "PASSWORD_RESET",
      usedAt: null,
      expiresAt: new Date("2026-08-25T11:59:59.000Z"),
    });
    await expect(
      inspectUserActionToken({ rawToken: "expired", type: "PASSWORD_RESET", now }, database),
    ).resolves.toEqual({ state: "EXPIRED" });
  });

  it("claims once and runs the credential mutation in the same transaction", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    const token = {
      id: "token-1",
      userId: "user-1",
      type: "PASSWORD_RESET" as const,
      tokenHash: hashUserActionToken("raw"),
      emailSnapshot: "bailey@example.com",
      expiresAt: new Date("2026-08-25T13:00:00.000Z"),
      usedAt: null,
      createdAt: now,
    };
    const tx = {
      userActionToken: {
        findUnique: vi.fn().mockResolvedValue(token),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const database = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    } as never;
    const mutate = vi.fn().mockResolvedValue("password-updated");

    const result = await consumeUserActionToken(
      { rawToken: "raw", type: "PASSWORD_RESET", now },
      mutate,
      database,
    );

    expect(result).toMatchObject({ state: "CONSUMED", value: "password-updated" });
    expect(tx.userActionToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: token.id, usedAt: null, expiresAt: { gt: now } }),
      data: { usedAt: now },
    });
    expect(mutate).toHaveBeenCalledWith(tx, expect.objectContaining({ usedAt: now }));
  });
});
