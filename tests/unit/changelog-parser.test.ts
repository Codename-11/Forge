import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseChangelog } from "@/server/services/changelog-parser";
import { hasUnseenChangelog } from "@/lib/changelog";

describe("CHANGELOG.md", () => {
  it("parses the real repo file into structured, uniquely identified releases", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
    const entries = parseChangelog(raw);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entries[0]?.release).toMatch(/^v\d+\.\d+\.\d+/);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.reduce((count, entry) => count + entry.items.length, 0)).toBeGreaterThan(0);
  });

  it("distinguishes two releases shipped on the same date", () => {
    const entries = parseChangelog(`
## [2026-07-16] — v0.26.0 · Newer
### Fixed
- New fix

## [2026-07-16] — v0.25.0 · Older
### Added
- Old feature
`);
    expect(entries.map((entry) => entry.id)).toEqual(["v0.26.0", "v0.25.0"]);
    expect(entries[0]?.date).toBe(entries[1]?.date);
    expect(hasUnseenChangelog(entries[0]!, entries[1]!.id, new Date("2026-07-16T20:00:00Z"))).toBe(
      true,
    );
    expect(hasUnseenChangelog(entries[0]!, entries[0]!.id, null)).toBe(false);
  });
});
