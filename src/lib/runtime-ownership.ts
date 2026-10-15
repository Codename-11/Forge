/** Display ownership independently from registration workspace and availability. */
export function runtimeOwnershipLabel(runtime: {
  ownerType: "PERSONAL" | "SERVICE" | "UNASSIGNED";
  owner?: { name?: string | null; email?: string | null } | null;
}): string {
  if (runtime.ownerType === "SERVICE") return "Service-owned · instance managed";
  if (runtime.ownerType === "UNASSIGNED") return "Unassigned · needs an ownership decision";
  return `Personal · ${runtime.owner?.name ?? runtime.owner?.email ?? "Owner unavailable"}`;
}

export function canConfirmRuntimeLifecycle(input: {
  name: string;
  confirmation: string;
  blockers: readonly string[];
  fetching: boolean;
  pending: boolean;
  ownerRequired?: boolean;
  ownerId?: string | null;
}): boolean {
  return (
    !!input.name &&
    input.confirmation === input.name &&
    input.blockers.length === 0 &&
    !input.fetching &&
    !input.pending &&
    (!input.ownerRequired || !!input.ownerId)
  );
}
