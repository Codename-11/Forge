export type AgentSetupMode = "external" | "managed";
export type AgentListView = "mine" | "available" | "all";

type SetupWorkspace = { id: string; slug: string; role?: string };
type SetupProfile = {
  id: string;
  ownedByMe: boolean;
  instanceShared: boolean;
  ownerType?: string;
  availability: { state: string };
  bindings: Array<{ id: string; workspace: { id: string } }>;
};

export function matchesAgentView(profile: SetupProfile, view: AgentListView, isAdmin: boolean) {
  if (view === "all") return isAdmin;
  if (view === "mine") return profile.ownedByMe;
  return (
    (profile.ownedByMe || profile.instanceShared || (isAdmin && profile.ownerType === "SERVICE")) &&
    profile.availability.state === "AVAILABLE"
  );
}

/** Navigation only. Destination mutations still enforce membership and permissions. */
export function agentSetupDestination({
  mode,
  workspace,
  profile,
}: {
  mode: AgentSetupMode;
  workspace?: SetupWorkspace;
  profile?: SetupProfile;
}): string | null {
  if (!workspace || !["OWNER", "ADMIN", "MEMBER"].includes(workspace.role ?? "")) return null;
  const canManage = workspace.role === "OWNER" || workspace.role === "ADMIN";
  if (mode === "managed" && !canManage) return null;
  if (profile && profile.availability.state !== "AVAILABLE") return null;
  const slug = encodeURIComponent(workspace.slug);
  if (mode === "external" && !profile) return `/w/${slug}/settings/access?create=personal`;
  if (!profile) return null;
  const binding = profile.bindings.find((item) => item.workspace.id === workspace.id);
  if (mode === "external" && binding && canManage) {
    return `/w/${slug}/settings/access?create=agent&agentId=${encodeURIComponent(binding.id)}`;
  }
  return `/agents/${encodeURIComponent(profile.id)}?workspace=${encodeURIComponent(workspace.id)}&setup=${mode}`;
}
