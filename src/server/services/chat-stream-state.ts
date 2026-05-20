import "server-only";

/**
 * In-memory map of tool-call ids awaiting operator approval. Resolved by
 * either the streaming route (when the operator's POST to
 * /api/chat/tool/approve lands) or the route itself on abort.
 *
 * Single-Node-instance deployment assumption — for multi-instance we'd
 * need a Redis-backed handshake. Keys are tool call ids issued by the
 * provider; values are resolvers for the awaiting executor.
 */
export const pendingApprovals = new Map<
  string,
  (decision: { approved: boolean }) => void
>();
