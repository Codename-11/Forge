"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, User as UserIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { HoverPreviewPortal } from "@/components/ui/hover-preview-portal";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Hover-preview popover for `@profileKey` and `@handle` mention chips.
 *
 * Agent + user share the `@token` namespace by design (see
 * `comment.ts::extractMentions`). The chip in markdown carries only
 * the lowercase token — we don't know up front whether it's an agent
 * or a user. So the card tries `agent.summary({ profileKey })` first;
 * on NOT_FOUND it falls back to `user.summary({ handle })`. If both
 * miss, it renders a soft "Not in this workspace" pill.
 *
 * Callers rendering an agent chip *outside* markdown (agent picker,
 * agent strip, etc.) can short-circuit the agent resolve by passing
 * `agentId` directly — skips the user fallback.
 *
 * The wrapped chip's click semantics are unchanged; hover is additive.
 */
export function AgentHoverPreview({
  /** Lowercase `@token` from a mention chip. Tries agent → user. */
  token,
  /** Explicit agent id when the caller knows the chip is an agent. */
  agentId,
  /** Explicit user id when the caller knows the chip is a user. */
  userId,
  className,
  children,
}: {
  token?: string;
  agentId?: string;
  userId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <HoverPreviewPortal
      className={className}
      render={() => (
        <MentionHoverCard
          token={token}
          agentId={agentId}
          userId={userId}
        />
      )}
    >
      {children}
    </HoverPreviewPortal>
  );
}

function MentionHoverCard({
  token,
  agentId,
  userId,
}: {
  token?: string;
  agentId?: string;
  userId?: string;
}) {
  // Strategy: when an explicit id is supplied, fetch only that one. When
  // only a token is supplied, hit agent first; if NOT_FOUND, fall back
  // to user. Both queries are disabled until their slot is needed so we
  // don't pay for the user fallback on every agent mention.
  // Skip the agent query when the caller is explicitly resolving a
  // user (userId-only). Otherwise hit agent first; the user fallback
  // only fires after a NOT_FOUND.
  const agentInput = agentId
    ? { id: agentId }
    : token
      ? { profileKey: token }
      : null;
  const agentQuery = trpc.agent.summary.useQuery(agentInput ?? { profileKey: "x" }, {
    enabled: Boolean(agentInput) && !userId,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // User fallback: explicit userId, OR an agent lookup definitively
  // missed (404) and we still have a token to try.
  const agentMissed = Boolean(agentQuery.error) && !agentId;
  const userInput = userId
    ? { id: userId }
    : token
      ? { handle: token }
      : null;
  const userQuery = trpc.user.summary.useQuery(userInput ?? { handle: "x" }, {
    enabled:
      Boolean(userId) ||
      (agentMissed && Boolean(token) && Boolean(userInput)),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (agentQuery.isLoading || (agentMissed && userQuery.isLoading)) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 text-meta text-muted-foreground">
        <Spinner size="sm" />
        <span className="font-mono">@{token ?? "…"}</span>
      </div>
    );
  }

  if (agentQuery.data) {
    return <AgentCard data={agentQuery.data} />;
  }

  if (userQuery.data) {
    return <UserCard data={userQuery.data} />;
  }

  // Neither agent nor user resolved within the workspace.
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-meta text-muted-foreground">
        @{token ?? "?"}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground/80">
        Not in this workspace
      </div>
    </div>
  );
}

type AgentSummary = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
  description: string | null;
  status: "ONLINE" | "BUSY" | "OFFLINE";
  provider: "HERMES" | "CLAUDE" | "CODEX" | "CUSTOM";
  capabilities: string[];
  lastHeartbeatAt: Date | null;
  maxConcurrent: number;
};

function AgentCard({ data }: { data: AgentSummary }) {
  const ws = useMaybeWorkspace();
  const detailHref = ws ? `/w/${ws.slug}/agents/${data.profileKey}` : null;
  const visibleCaps = data.capabilities.slice(0, 3);
  const extraCaps = data.capabilities.length - visibleCaps.length;

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: avatar + name + status pill */}
      <div className="flex items-center gap-2">
        <AgentAvatar
          agent={{
            name: data.name,
            profileKey: data.profileKey,
            avatar: data.avatar,
          }}
          size="sm"
          shape="circle"
        />
        <div className="min-w-0 flex-1">
          {detailHref ? (
            <Link
              href={detailHref}
              className="block truncate text-[0.8125rem] font-medium text-foreground hover:underline"
            >
              {data.name}
            </Link>
          ) : (
            <div className="truncate text-[0.8125rem] font-medium text-foreground">
              {data.name}
            </div>
          )}
          <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">
            @{data.profileKey}
          </div>
        </div>
        <StatusPill status={data.status} />
      </div>

      {/* Row 2: capabilities */}
      {visibleCaps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {visibleCaps.map((cap) => (
            <span
              key={cap}
              className="inline-flex items-center rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-ember"
            >
              {cap}
            </span>
          ))}
          {extraCaps > 0 && (
            <span
              className="inline-flex items-center rounded-md bg-subtle/60 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
              title={data.capabilities.slice(3).join(" · ")}
            >
              +{extraCaps}
            </span>
          )}
        </div>
      )}

      {/* Row 3: provider · heartbeat */}
      <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-meta text-muted-foreground">
        <Bot className="h-3 w-3 shrink-0" />
        <span className="font-mono text-[0.625rem] uppercase tracking-wider">
          {data.provider}
        </span>
        {data.lastHeartbeatAt && (
          <span className="ml-auto inline-flex items-center gap-1">
            <AgentPresenceDot
              status={data.status}
              size="sm"
              lastHeartbeatAt={data.lastHeartbeatAt}
            />
            <span>{relativeTime(data.lastHeartbeatAt)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

type UserSummary = {
  id: string;
  name: string | null;
  handle: string | null;
  image: string | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST" | null;
  recentActivity: number;
};

function UserCard({ data }: { data: UserSummary }) {
  return (
    <div className="px-3 py-2.5">
      {/* Row 1: avatar + name + role */}
      <div className="flex items-center gap-2">
        <Avatar name={data.name} image={data.image} size={24} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem] font-medium text-foreground">
            {data.name ?? data.handle ?? "User"}
          </div>
          {data.handle && (
            <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              @{data.handle}
            </div>
          )}
        </div>
        {data.role && <RolePill role={data.role} />}
      </div>

      {/* Row 2: activity */}
      <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-meta text-muted-foreground">
        <UserIcon className="h-3 w-3 shrink-0" />
        <span>
          {data.recentActivity > 0
            ? `${data.recentActivity} event${data.recentActivity === 1 ? "" : "s"} · last 7d`
            : "No recent activity"}
        </span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "ONLINE" | "BUSY" | "OFFLINE" }) {
  const tone =
    status === "ONLINE"
      ? "border-success/40 bg-success/10 text-success"
      : status === "BUSY"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-border bg-subtle/60 text-muted-foreground";
  const label =
    status === "ONLINE" ? "Online" : status === "BUSY" ? "Busy" : "Offline";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
        tone,
      )}
    >
      <AgentPresenceDot status={status} size="sm" />
      {label}
    </span>
  );
}

function RolePill({ role }: { role: "OWNER" | "ADMIN" | "MEMBER" | "GUEST" }) {
  const tone =
    role === "OWNER"
      ? "border-ember/40 bg-ember/10 text-ember"
      : role === "ADMIN"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-border bg-subtle/60 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
        tone,
      )}
    >
      {role}
    </span>
  );
}
