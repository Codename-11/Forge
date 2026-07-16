export type ActivityActorSource = {
  actor?: { name: string | null } | null;
  actorAgent?: { name: string | null; profileKey?: string | null } | null;
  kind?: string | null;
  payload?: unknown;
};

export type ActivityActorKind = "human" | "agent" | "worker" | "automation" | "connector";

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export function activityActorKind(source: ActivityActorSource): ActivityActorKind {
  if (source.actorAgent) return "agent";
  if (source.actor?.name) return "human";
  const payload = payloadRecord(source.payload);
  const provenance = [
    payload.connectionKind,
    payload.transport,
    payload.provider,
    payload.source,
    payload.sourceType,
    payload.action,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/connector|webhook|github|mcp|streamable-http/.test(provenance) || payload.deliveryId) {
    return "connector";
  }
  if (
    source.kind?.startsWith("AGENT_") ||
    source.kind === "ISSUE_STALLED" ||
    source.kind === "ISSUE_SLA_BREACH" ||
    /worker|watchdog|sweep|dispatch|reconcile|work-session/.test(provenance)
  ) {
    return "worker";
  }
  return "automation";
}

export function activityActorName(source: ActivityActorSource): string {
  const agentName =
    source.actorAgent?.name ??
    (source.actorAgent?.profileKey ? `@${source.actorAgent.profileKey}` : null);
  const humanName = source.actor?.name ?? null;

  if (agentName) return agentName;
  if (humanName) return humanName;

  const payload = payloadRecord(source.payload);
  const kind = activityActorKind(source);
  if (kind === "connector") {
    const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
    if (provider) {
      const providerLabel: Record<string, string> = {
        GITHUB: "GitHub",
        MCP: "MCP",
        SLACK: "Slack",
        JIRA: "Jira",
      };
      return `${providerLabel[provider.toUpperCase()] ?? titleCaseProvider(provider)} connector`;
    }
    if (
      payload.connectionKind === "MCP_CLIENT" ||
      (typeof payload.transport === "string" && payload.transport.toLowerCase().includes("mcp"))
    ) {
      return "MCP connector";
    }
    return "External connector";
  }
  if (kind === "worker") return "Forge worker";
  return "Forge automation";
}

function titleCaseProvider(provider: string): string {
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1).toLowerCase()}`;
}

export function activityActorOwnerTitle(source: ActivityActorSource): string | undefined {
  if (!source.actorAgent || !source.actor?.name) return undefined;
  return `API key owner: ${source.actor.name}`;
}
