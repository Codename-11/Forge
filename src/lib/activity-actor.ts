export type ActivityActorSource = {
  actor?: { name: string | null } | null;
  actorAgent?: { name: string | null; profileKey?: string | null } | null;
};

export function activityActorName(source: ActivityActorSource): string {
  const agentName =
    source.actorAgent?.name ??
    (source.actorAgent?.profileKey ? `@${source.actorAgent.profileKey}` : null);
  const humanName = source.actor?.name ?? null;

  if (agentName && humanName) return `${agentName} via ${humanName}`;
  if (agentName) return agentName;
  return humanName ?? "system";
}
