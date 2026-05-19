export type AgentAvatarIdentity = {
  name?: string | null;
  profileKey?: string | null;
  avatar?: string | null;
};

const IMAGE_AVATAR_PREFIXES = ["http://", "https://", "//", "/", "data:image/", "blob:"];

export function isImageAvatar(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return IMAGE_AVATAR_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function textAvatarForAgent(agent: AgentAvatarIdentity): string {
  const avatar = agent.avatar?.trim();
  if (avatar && !isImageAvatar(avatar)) {
    return Array.from(avatar).slice(0, 4).join("");
  }
  const key = agent.profileKey?.trim();
  if (key) return key.slice(0, 2).toUpperCase();
  const name = agent.name?.trim();
  if (!name) return "AG";
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "AG"
  );
}
