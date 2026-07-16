import type { WorkSessionSource } from "@prisma/client";

type DeliveryPerson = {
  name: string | null;
  email?: string | null;
  profileKey?: string | null;
};

export type DeliveryIdentityInput = {
  source: WorkSessionSource;
  ownerUser?: DeliveryPerson | null;
  ownerAgent?: DeliveryPerson | null;
  ownerConnection?: { agent?: DeliveryPerson | null } | null;
};

export type DeliveryIdentity = {
  agentLabel: string | null;
  operatorLabel: string | null;
  primaryLabel: string;
  summary: string | null;
};

export function resolveDeliveryIdentity(session: DeliveryIdentityInput): DeliveryIdentity {
  const registeredAgent = session.ownerAgent ?? session.ownerConnection?.agent ?? null;
  const registeredAgentLabel =
    registeredAgent?.name && registeredAgent.profileKey
      ? `${registeredAgent.name} · @${registeredAgent.profileKey}`
      : null;
  const unregisteredAgentLabel =
    session.source === "CODEX_DESKTOP"
      ? "Unregistered Codex Desktop client"
      : session.source === "MCP"
        ? "Unregistered MCP client"
        : session.source === "FORGE_AGENT"
          ? "Unregistered Forge agent"
          : session.source === "ISSUE_DISPATCH"
            ? "Unregistered dispatched agent"
            : session.source === "SCHEDULED"
              ? "Unregistered scheduled agent"
              : session.source === "NATIVE_SESSION"
                ? "Unregistered native session agent"
                : null;
  const agentLabel = registeredAgentLabel ?? unregisteredAgentLabel;
  const operatorLabel = session.ownerUser?.name ?? session.ownerUser?.email ?? null;

  if (agentLabel) {
    const agentState = registeredAgentLabel ? "Agent" : "Agent identity unverified";
    return {
      agentLabel,
      operatorLabel,
      primaryLabel: agentLabel,
      summary: operatorLabel ? `${agentState} · Operator ${operatorLabel}` : agentState,
    };
  }

  return {
    agentLabel: null,
    operatorLabel,
    primaryLabel: operatorLabel ?? "Unassigned",
    summary: operatorLabel ? "Operator" : null,
  };
}
