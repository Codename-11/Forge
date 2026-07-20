import { z } from "zod";

/**
 * Permissive agent-id schema. Agent rows are NOT guaranteed to carry a
 * Prisma `cuid()` — Hermes-seeded agents (e.g. Victor, Mizu) keep their
 * original hex handles. `z.string().cuid()` rejects those, which silently
 * broke crew membership, goal planner assignment, and step assignment for
 * exactly the agents people actually run. Use this anywhere an agent id
 * arrives over the wire instead of `.cuid()`.
 */
export const agentIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/);

/**
 * AgentConnection ids are stable opaque identifiers, not a transport-level
 * CUID contract. The original connection backfill used deterministic `ac_*`
 * ids, while newly registered endpoints use Prisma CUIDs. Accept both during
 * rolling upgrades and validate ownership through tenant-scoped lookups.
 */
export const agentConnectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);
