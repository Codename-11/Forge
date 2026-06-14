import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Smoke test for the CHANGELOG.md parser shipped with the
 * `system.changelog` tRPC proc. We exercise the parser against the
 * real repo file so a malformed entry surfaces early; the proc
 * itself is tested by integration tests.
 *
 * The parser is intentionally not exported from the module (it lives
 * inside `system.ts` next to the cache), so we re-implement the
 * parse here in a tiny form-pinned shim. If you change the parser
 * shape, mirror the change here — the goal is to lock in the
 * Keep-a-Changelog format we expect, not test the exact same code
 * twice.
 */

interface Item {
  type: "added" | "changed" | "fixed" | "removed";
  text: string;
}

function parse(raw: string): Array<{
  version: string;
  items: Item[];
}> {
  const lines = raw.split(/\r?\n/);
  type Entry = { version: string; items: Item[] };
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let curSubtype: Item["type"] | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      const bracketMatch = heading.match(/^\[([^\]]+)\](?:\s+[—-]\s+(.+))?$/);
      const plainMatch = bracketMatch ? null : heading.match(/^(.+?)(?:\s+[—-]\s+(.+))?$/);
      const version = (bracketMatch?.[1] ?? plainMatch?.[1])?.trim();
      if (!version) continue;
      cur = { version, items: [] };
      entries.push(cur);
      curSubtype = null;
      continue;
    }
    if (!cur) continue;
    const sub = line.match(/^###\s+(Added|Changed|Fixed|Removed)\b/i);
    if (sub) {
      curSubtype = sub[1].toLowerCase() as Item["type"];
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/);
    if (bullet && curSubtype) {
      cur.items.push({
        type: curSubtype,
        text: bullet[1].replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"),
      });
    }
  }
  // Mirror system.ts: the "Unreleased" section is not a shipped release, so it
  // never heads the structured entries (its body still shows in the raw page).
  return entries.filter((e) => e.version.toLowerCase() !== "unreleased");
}

describe("CHANGELOG.md", () => {
  it("parses real repo file into at least one entry with structured items", async () => {
    const file = path.join(process.cwd(), "CHANGELOG.md");
    const raw = await fs.readFile(file, "utf8");
    const entries = parse(raw);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const totalItems = entries.reduce((n, e) => n + e.items.length, 0);
    expect(totalItems).toBeGreaterThan(0);
    // Every parsed item has a known type bucket.
    for (const e of entries) {
      for (const item of e.items) {
        expect(["added", "changed", "fixed", "removed"]).toContain(item.type);
      }
    }
  });
});
