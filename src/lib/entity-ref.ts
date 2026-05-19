import { z } from "zod";

/**
 * Forge entity reference — the typed pointer shape every cross-surface
 * primitive uses (canvas cards, context-set items, action-request
 * sources, artifact promotions, execution-step links, chat context
 * snapshots). All canonical content lives on its own table; refs
 * carry only `{ type, id }` plus optional display hints.
 *
 * Extending this enum: add the literal here AND a hydration branch
 * in `src/server/services/entity-hydration.ts`. The two files are
 * paired on purpose so an unknown ref kind fails fast in dev.
 */
export const forgeEntityTypeSchema = z.enum([
  "issue",
  "project",
  "initiative",
  "cycle",
  "chat-thread",
  "chat-message",
  "agent",
  "agent-run",
  "artifact",
  "context-set",
  "execution-plan",
  "execution-step",
  "action-request",
  "attachment",
  "note",
  "comment",
]);

export type ForgeEntityType = z.infer<typeof forgeEntityTypeSchema>;

export const forgeEntityRefSchema = z.object({
  type: forgeEntityTypeSchema,
  id: z.string().min(1),
  /**
   * Optional workspace hint. The hydrator always re-asserts workspace
   * scope before returning data; the field exists for clients that
   * want to filter refs without a round-trip.
   */
  workspaceId: z.string().min(1).optional(),
  /**
   * Cosmetic display hint. The hydrator uses the canonical entity's
   * label/title/name when available and falls back to this when the
   * source row is gone (dead-ref fallback).
   */
  label: z.string().optional(),
});

export type ForgeEntityRef = z.infer<typeof forgeEntityRefSchema>;

/**
 * Array of refs — used by canvas nodes, context-set items, action
 * request sources, etc.
 */
export const forgeEntityRefArraySchema = z.array(forgeEntityRefSchema);

/**
 * Token form for inline markdown: `forge:<type>:<id>`. We allow
 * a-z dashes in the type and the usual cuid charset in the id.
 * Matches `forge:issue:cl...`, `forge:artifact:cl...`, etc.
 *
 * Kept narrow on purpose: `[a-z0-9-]{2,32}` covers every entity
 * type name in `forgeEntityTypeSchema` and reserves room for
 * future additions without re-matching unrelated text.
 */
export const FORGE_ENTITY_TOKEN_RE = /forge:([a-z][a-z0-9-]{1,31}):([a-z0-9]{20,})/gi;

/**
 * Parse a single token string like `forge:issue:abc123` into an
 * unvalidated ref. Returns null on malformed input. Validation
 * against `forgeEntityTypeSchema` is up to the caller.
 */
export function parseEntityToken(token: string): { type: string; id: string } | null {
  const m = token.match(/^forge:([a-z][a-z0-9-]{1,31}):([a-z0-9]{20,})$/i);
  if (!m) return null;
  return { type: m[1]!.toLowerCase(), id: m[2]! };
}

/**
 * Render a ref to the canonical token form. Useful when building
 * agent prompts or markdown bodies that should round-trip through
 * the renderer.
 */
export function entityRefToToken(ref: Pick<ForgeEntityRef, "type" | "id">): string {
  return `forge:${ref.type}:${ref.id}`;
}

/**
 * Make a `(type, id)` key for use in Maps/Sets that need to
 * dedupe refs across surfaces.
 */
export function entityRefKey(ref: Pick<ForgeEntityRef, "type" | "id">): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Stable list of all entity types — handy when building admin UIs
 * that show "what can I attach here?" pickers.
 */
export const FORGE_ENTITY_TYPES: readonly ForgeEntityType[] = forgeEntityTypeSchema.options;
