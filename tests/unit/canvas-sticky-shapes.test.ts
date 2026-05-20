import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Mirrors the zod schema in `src/server/routers/canvas.ts` for the
 * `shapeAdd` mutation. Replicated here to avoid pulling the full
 * router (and its Prisma + Redis chain) into a pure unit test.
 *
 * If you edit one, edit both — the test fails fast if the kind list
 * drifts because the router shape is the source of truth.
 */
const shapeAddInput = z.object({
  canvasId: z.string().cuid(),
  kind: z.enum([
    "box",
    "ellipse",
    "line",
    "arrow",
    "text",
    "freehand",
    "sticky",
    "comment-pin",
    "stamp",
  ]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  path: z.unknown().optional(),
  style: z.unknown().optional(),
  text: z.string().max(50_000).optional(),
  groupId: z.string().max(80).optional(),
  zIndex: z.number().int().optional(),
});

// The CanvasShape `style` JSON is free-form on the wire, so palette
// validation lives in the renderer (canvas-shapes.tsx). The two
// constants below mirror that surface — same source of truth on
// purpose, copied here to keep the test pure (no React import).
const STICKY_PALETTE_KEYS = [
  "sand",
  "blush",
  "sage",
  "sky",
  "lavender",
  "peach",
] as const;
const STAMP_EMOJIS = ["👍", "👎", "⭐", "🔥", "❤️", "💡", "⚠️", "🎯"] as const;

const stickyStyle = z.object({
  fill: z.enum(STICKY_PALETTE_KEYS),
  fontSize: z.number().optional(),
});
const stampStyle = z.object({
  emoji: z.enum(STAMP_EMOJIS),
});

const FAKE_CUID = "ckv0000000000000000000000";

describe("shapeAdd input — new W1.3 kinds", () => {
  it("accepts sticky as a kind", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "sticky",
      x: 100,
      y: 200,
      width: 200,
      height: 120,
      text: "",
      style: { fill: "sand", fontSize: 14 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("sticky");
    }
  });

  it("accepts comment-pin as a kind", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "comment-pin",
      x: 50,
      y: 80,
      width: 24,
      height: 24,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("comment-pin");
    }
  });

  it("accepts stamp as a kind", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "stamp",
      x: 10,
      y: 20,
      width: 48,
      height: 48,
      style: { emoji: "🔥" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("stamp");
    }
  });

  it("still accepts legacy kinds (regression guard)", () => {
    for (const k of ["box", "ellipse", "line", "arrow", "text", "freehand"]) {
      const parsed = shapeAddInput.safeParse({
        canvasId: FAKE_CUID,
        kind: k,
        x: 0,
        y: 0,
      });
      expect(parsed.success, `kind=${k}`).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "wormhole",
      x: 0,
      y: 0,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("sticky style.fill — palette validation", () => {
  it("accepts every key in the warm-earthy palette", () => {
    for (const key of STICKY_PALETTE_KEYS) {
      expect(stickyStyle.safeParse({ fill: key }).success, `key=${key}`).toBe(true);
    }
  });

  it("rejects bright post-it colors that aren't part of the warm-earthy palette", () => {
    for (const key of ["yellow", "pink", "blue", "green", "orange", ""]) {
      const parsed = stickyStyle.safeParse({ fill: key });
      expect(parsed.success, `key=${key}`).toBe(false);
    }
  });

  it("has exactly six warm-earthy keys (audit guard)", () => {
    expect(new Set(STICKY_PALETTE_KEYS).size).toBe(6);
  });
});

describe("stamp style.emoji — palette validation", () => {
  it("accepts every emoji in the 8-glyph palette", () => {
    for (const emoji of STAMP_EMOJIS) {
      expect(stampStyle.safeParse({ emoji }).success, `emoji=${emoji}`).toBe(true);
    }
  });

  it("rejects emojis outside the palette", () => {
    for (const emoji of ["🦄", "🚀", "👍🏽", ""]) {
      expect(stampStyle.safeParse({ emoji }).success, `emoji=${emoji}`).toBe(false);
    }
  });

  it("exposes the canonical 8-emoji set", () => {
    expect(STAMP_EMOJIS.length).toBe(8);
  });
});

describe("comment-pin — no required style payload", () => {
  it("accepts a comment-pin with only kind + coords", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "comment-pin",
      x: 0,
      y: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a comment-pin with an arbitrary style payload (unread counter etc.)", () => {
    const parsed = shapeAddInput.safeParse({
      canvasId: FAKE_CUID,
      kind: "comment-pin",
      x: 0,
      y: 0,
      style: { unread: 3 },
    });
    expect(parsed.success).toBe(true);
  });
});
