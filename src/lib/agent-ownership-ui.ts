export type PersonalAgentCreationPolicy = "DISABLED" | "APPROVAL_REQUIRED" | "SELF_SERVICE";

export function agentOwnerLabel(profile: {
  ownerType: string;
  owner?: { name: string | null } | null;
  ownedByMe?: boolean;
}) {
  if (profile.ownerType === "SERVICE") return "Service-owned · Instance administrators";
  return `${profile.owner?.name ?? "Unavailable owner"}${profile.ownedByMe ? " (you)" : ""}`;
}

export function personalAgentCreationCopy(policy?: PersonalAgentCreationPolicy) {
  if (policy === "SELF_SERVICE")
    return {
      label: "Create my agent",
      description:
        "Create a personal identity owned by your account. Workspace access and credential permissions are still granted separately.",
      enabled: true,
    };
  if (policy === "APPROVAL_REQUIRED")
    return {
      label: "Request my agent",
      description:
        "You can request a personal identity. An instance administrator must approve it before workspace access can be added.",
      enabled: true,
    };
  return {
    label: policy === "DISABLED" ? "Personal creation disabled" : "Loading creation policy…",
    description:
      policy === "DISABLED"
        ? "Instance policy disables new personal agent identities. You can continue using existing permitted agents or a personal MCP token."
        : "Checking the instance’s personal agent creation policy.",
    enabled: false,
  };
}
