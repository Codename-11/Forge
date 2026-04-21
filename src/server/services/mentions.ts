import "server-only";

/**
 * Extract `@profileKey` tokens from a comment body.
 *
 * The regex matches the same shape we allow for `Agent.profileKey`
 * (lowercase alnum, `-` / `_`), returns them in order, de-duplicated.
 * We treat these as candidate agent handles — the caller is expected
 * to resolve them against the workspace's `Agent` table before acting.
 *
 *   extractMentions("ping @victor @mizu also @victor") // → ["victor","mizu"]
 */
export function extractMentions(body: string): string[] {
  if (!body) return [];
  const re = /@([a-z0-9][a-z0-9-_]*)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(re)) {
    const token = m[1];
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}
