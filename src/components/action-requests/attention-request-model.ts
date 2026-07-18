export type AttentionActionTone = "PRIMARY" | "NEUTRAL" | "DANGER";

export type AttentionAction = {
  id: string;
  label: string;
  description: string;
  tone: AttentionActionTone;
  requiresConfirmation: boolean;
  enabled: boolean;
  disabledReason: string | null;
};

export type AttentionRequestPresentation = {
  category: string;
  protocol: string;
  summary: string | null;
  replyTarget: string | null;
  actions: AttentionAction[];
  details: Array<{ label: string; value: string }>;
  technicalDetails: Array<{ label: string; value: string }>;
};

export const DELIVERY_CONFLICT_DECISIONS = [
  "JOIN_CONTRIBUTOR",
  "JOIN_REVIEWER",
  "HANDOFF_PRIMARY",
  "CANCEL_DISPATCH",
] as const;

export type DeliveryConflictDecision = (typeof DELIVERY_CONFLICT_DECISIONS)[number];

const GENERIC_ATTENTION_ACTIONS = [
  "ACCEPT",
  "DECLINE",
  "DISMISS",
  "RESPOND",
  "OPEN_ISSUE",
] as const;

export function isDeliveryConflictDecision(value: string): value is DeliveryConflictDecision {
  return DELIVERY_CONFLICT_DECISIONS.some((decision) => decision === value);
}

/**
 * The server owns labels and availability, but the browser still keeps a
 * narrow execution allowlist. Unknown descriptors remain visible through the
 * issue fallback instead of becoming arbitrary client-dispatched commands.
 */
export function safeAttentionActions(
  presentation: AttentionRequestPresentation | null | undefined,
): AttentionAction[] {
  if (!presentation) return [];
  if (presentation.protocol === "DELIVERY_CONNECTION_CONFLICT") {
    return presentation.actions.filter(
      (action) =>
        isDeliveryConflictDecision(action.id) ||
        action.id === "OPEN_ISSUE" ||
        action.id === "DISMISS",
    );
  }
  return presentation.actions.filter((action) =>
    GENERIC_ATTENTION_ACTIONS.some((allowed) => allowed === action.id),
  );
}
