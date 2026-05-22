import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard: every `@keyframes` declared in globals.css must be namespaced
 * `forge-` / `ui-` / `dag-` (matching the `.forge-*` / `.ui-*` / `.dag-*`
 * class conventions). This keeps new animations from regressing to bare
 * global names like the original `shimmer` / `fade-in`.
 *
 * The two pre-existing bare names are grandfathered; no new ones allowed.
 */
const GRANDFATHERED = new Set(["shimmer", "fade-in", "dag-dash-flow"]);
const ALLOWED_PREFIXES = ["forge-", "ui-", "dag-"];

describe("globals.css keyframe naming", () => {
  const css = readFileSync(
    join(__dirname, "..", "..", "src", "app", "globals.css"),
    "utf8",
  );
  const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map(
    (m) => m[1],
  );

  it("declares at least the known keyframes", () => {
    expect(names).toContain("forge-grid-drift");
    expect(names.length).toBeGreaterThan(5);
  });

  it("uses a forge-/ui-/dag- prefix for every non-grandfathered keyframe", () => {
    const offenders = names.filter(
      (n) =>
        !GRANDFATHERED.has(n) && !ALLOWED_PREFIXES.some((p) => n.startsWith(p)),
    );
    expect(offenders, `unprefixed @keyframes: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });
});
