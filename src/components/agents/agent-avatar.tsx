import { cn } from "@/lib/utils";
import {
  isImageAvatar,
  textAvatarForAgent,
  type AgentAvatarIdentity,
} from "@/components/agents/agent-avatar-utils";

const sizeClass = {
  xs: "h-5 w-5 text-[0.5625rem]",
  sm: "h-6 w-6 text-[0.625rem]",
  md: "h-8 w-8 text-[0.6875rem]",
} as const;

export function AgentAvatar({
  agent,
  size = "md",
  shape = "rounded",
  active = false,
  className,
  title,
}: {
  agent: AgentAvatarIdentity;
  size?: keyof typeof sizeClass;
  shape?: "circle" | "rounded";
  active?: boolean;
  className?: string;
  /** `null` suppresses the avatar's own tooltip when a parent owns detail. */
  title?: string | null;
}) {
  const avatar = agent.avatar?.trim() || null;
  const imageAvatar = isImageAvatar(avatar) ? avatar : null;
  const rounded = shape === "circle" ? "rounded-full" : "rounded-lg";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border font-mono uppercase",
        sizeClass[size],
        rounded,
        active
          ? "border-ember/40 bg-ember/15 text-ember"
          : "border-border bg-subtle/50 text-muted-foreground",
        className,
      )}
      title={
        title === null
          ? undefined
          : title ?? `${agent.name ?? "Agent"}${agent.profileKey ? ` @${agent.profileKey}` : ""}`
      }
    >
      {imageAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageAvatar} alt="" className={cn("h-full w-full object-cover", rounded)} />
      ) : (
        <span aria-hidden>{textAvatarForAgent(agent)}</span>
      )}
    </span>
  );
}

export { isImageAvatar, textAvatarForAgent, type AgentAvatarIdentity };
