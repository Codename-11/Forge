export type ActivityActorSource = {
  actor?: { name: string | null } | null;
  actorAgent?: { name: string | null; profileKey?: string | null } | null;
};

export function activityActorName(source: ActivityActorSource): string {
  const agentName =
    source.actorAgent?.name ??
    (source.actorAgent?.profileKey ? `@${source.actorAgent.profileKey}` : null);
  const humanName = source.actor?.name ?? null;

  if (agentName) return agentName;
  return humanName ?? "system";
}

export function activityActorOwnerTitle(source: ActivityActorSource): string | undefined {
  if (!source.actorAgent || !source.actor?.name) return undefined;
  return `API key owner: ${source.actor.name}`;
}
