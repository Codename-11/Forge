import { describe, expect, it } from "vitest";
import { tryParseDataBlock } from "@/components/data-blocks/data-block-parser";

/**
 * Unit coverage for the `:::data <kind>` directive parser. The
 * `attachment-renderer.tsx` block-parser calls into this on every
 * markdown render, so we lock in the JSON-validation contracts here.
 */

function parse(body: string) {
  const lines = body.split("\n");
  return tryParseDataBlock(lines, 0);
}

describe("tryParseDataBlock", () => {
  it("returns null for non-directive lines", () => {
    expect(parse("just a paragraph")).toBeNull();
    expect(parse(":::artifact x")).toBeNull();
  });

  it("parses a table block", () => {
    const r = parse(
      [
        ":::data table",
        '{ "headers": ["Tool", "OK?"], "rows": [["x", true], ["y", null]] }',
        ":::",
      ].join("\n"),
    );
    expect(r).not.toBeNull();
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      expect(r.block.kind).toBe("table");
      if (r.block.kind === "table") {
        expect(r.block.payload.headers).toEqual(["Tool", "OK?"]);
        expect(r.block.payload.rows).toEqual([
          ["x", true],
          ["y", null],
        ]);
      }
      expect(r.consumed).toBe(3);
    }
  });

  it("parses a list block with badges", () => {
    const r = parse(
      [
        ":::data list",
        JSON.stringify({
          ordered: false,
          items: ["bare", { text: "labelled", badge: "WIP" }],
        }),
        ":::",
      ].join("\n"),
    );
    expect(r?.ok).toBe(true);
    if (r?.ok && r.block.kind === "list") {
      expect(r.block.payload.items).toEqual([
        "bare",
        { text: "labelled", badge: "WIP" },
      ]);
    }
  });

  it("parses a kv block as object", () => {
    const r = parse(
      [
        ":::data kv",
        JSON.stringify({ pairs: { env: "prod", version: 42, ok: true } }),
        ":::",
      ].join("\n"),
    );
    expect(r?.ok).toBe(true);
    if (r?.ok && r.block.kind === "kv") {
      const pairs = r.block.payload.pairs;
      expect(Array.isArray(pairs)).toBe(false);
      expect(pairs).toEqual({ env: "prod", version: 42, ok: true });
    }
  });

  it("flags invalid JSON without crashing", () => {
    const r = parse([":::data table", "{ not json,", ":::"].join("\n"));
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.reason).toMatch(/JSON/i);
    }
  });

  it("flags an unknown kind", () => {
    const r = parse([":::data wrongthing", "{}", ":::"].join("\n"));
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.reason).toMatch(/unknown/i);
    }
  });

  it("rejects table rows that aren't arrays", () => {
    const r = parse(
      [
        ":::data table",
        JSON.stringify({ headers: ["a"], rows: [1, 2, 3] }),
        ":::",
      ].join("\n"),
    );
    expect(r?.ok).toBe(false);
  });

  it("consumes the body even when the closer is missing", () => {
    const r = parse([":::data table", "{}"].join("\n"));
    expect(r).not.toBeNull();
    // 2 lines consumed (no closer at end).
    expect(r?.consumed).toBe(2);
  });
});
