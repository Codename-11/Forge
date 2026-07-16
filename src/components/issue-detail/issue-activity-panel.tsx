"use client";
import { Activity as ActivityIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import {
  activityActorKind,
  activityActorName,
  activityActorOwnerTitle,
} from "@/lib/activity-actor";
import { issueUpdateCopy } from "@/lib/activity-update-summary";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Activity tab body — the audit-backed event stream for a single issue.
 * Queries `issue.activity` (workspace-scoped, not admin-gated) and renders
 * each event as a compact row. Falls back to a friendly empty state when
 * the subject has no audit rows yet (new issues, tiny workspaces).
 *
 * The underlying ActivityEvent rows are best-effort — not every mutation
 * writes one, so "no activity" is common and doesn't mean an error.
 */

function readDispatch(
  payload: unknown,
): { mode?: string; reason?: string; chosen?: { profileKey?: string; name?: string } } | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as Record<string, unknown>).dispatch;
  if (!d || typeof d !== "object") return null;
  return d as { mode?: string; reason?: string; chosen?: { profileKey?: string; name?: string } };
}

const KIND_LABEL: Record<string, { label: string; phase?: string }> = {
  ISSUE_CREATED: { label: "Created issue" },
  ISSUE_UPDATED: { label: "Updated" },
  ISSUE_DELETED: { label: "Deleted" },
  ISSUE_STATUS_CHANGED: { label: "Status changed" },
  ISSUE_ASSIGNED: { label: "Assignees changed" },
  ISSUE_PRIORITY_CHANGED: { label: "Priority changed" },
  ISSUE_STALLED: { label: "Stalled — agent hadn't moved it", phase: "stall" },
  ISSUE_SLA_BREACH: { label: "SLA breach — past target", phase: "alert" },
  AGENT_NOACK: { label: "Wake missed", phase: "no ack" },
  COMMENT_CREATED: { label: "Commented" },
  COMMENT_UPDATED: { label: "Edited comment" },
  AGENT_ASSIGNED: { label: "Wake requested", phase: "wake" },
  AGENT_RUN_STARTED: { label: "Run opened", phase: "run" },
  AGENT_RUN_COMPLETED: { label: "Run completed", phase: "done" },
  AGENT_RUN_STALLED: { label: "Run stalled", phase: "stall" },
  AGENT_RUN_CLEARED: { label: "Run failure cleared", phase: "done" },
  AGENT_RUN_BLOCKED: { label: "Run blocked", phase: "blocked" },
  AGENT_RUN_CONTROL_REQUESTED: { label: "Run control requested", phase: "control" },
  AGENT_RUN_KICKED: { label: "Wake retried", phase: "retry" },
  SKILL_INVOKED: { label: "Skill ran" },
  PLUGIN_ERROR: { label: "Plugin error", phase: "error" },
};

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPayloadRecord(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAgentRequests(payload: unknown): Array<{ profileKey: string; mode: string }> {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as Record<string, unknown>).agentRequests;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const profileKey = rec.profileKey;
    const mode = rec.mode;
    if (typeof profileKey !== "string" || typeof mode !== "string") return [];
    return [{ profileKey, mode }];
  });
}

function readNestedString(payload: unknown, objectKey: string, valueKey: string): string | null {
  const obj = readPayloadRecord(payload, objectKey);
  const value = obj?.[valueKey];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function agentSuffix(payload: unknown, fallback?: string | null): string {
  const handle =
    fallback ??
    readPayloadString(payload, "agentProfileKey") ??
    readNestedString(payload, "dispatchReason", "picked");
  return handle ? ` for @${handle}` : "";
}

function payloadDetail(payload: unknown): string | null {
  return (
    readPayloadString(payload, "summary") ??
    readPayloadString(payload, "currentStep") ??
    readPayloadString(payload, "preview") ??
    readPayloadString(payload, "reason")
  );
}

function dispatchDetail(payload: unknown): string | null {
  const dispatch = readDispatch(payload);
  const mode =
    dispatch?.mode ??
    readPayloadString(payload, "mode") ??
    readNestedString(payload, "dispatchReason", "mode");
  const engagementMode = readPayloadString(payload, "engagementMode");
  const runtime = readPayloadRecord(payload, "runtime");
  const runtimeName = typeof runtime?.name === "string" ? runtime.name : null;
  const runtimeTools = typeof runtime?.tools === "string" ? runtime.tools : null;
  const reason =
    dispatch?.reason ??
    readPayloadString(payload, "reason") ??
    readNestedString(payload, "dispatchReason", "reasonText");
  const parts = [
    mode ? `dispatch ${mode}` : null,
    engagementMode ? `mode ${engagementMode}` : null,
    runtimeName ? `runtime ${runtimeName}` : null,
    runtimeTools,
    reason,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function controlLabel(payload: unknown): string {
  const control = readPayloadString(payload, "control");
  if (control === "cancel") return "Stop requested";
  if (control === "pause") return "Pause requested";
  if (control === "redirect") return "Redirect requested";
  return "Run control requested";
}

function activityCopy(
  kind: string,
  payload: unknown,
  actorAgentProfileKey?: string | null,
): { label: string; detail?: string | null; phase?: string } {
  if (kind === "ISSUE_UPDATED") {
    return issueUpdateCopy(payload) ?? KIND_LABEL.ISSUE_UPDATED!;
  }
  if (kind === "AGENT_ASSIGNED") {
    const dispatch = readDispatch(payload);
    const handle =
      dispatch?.chosen?.profileKey ??
      readNestedString(payload, "dispatchReason", "picked") ??
      readPayloadString(payload, "agentProfileKey");
    const modeUpdated =
      payload &&
      typeof payload === "object" &&
      (payload as Record<string, unknown>).modeUpdated === true;
    const target = handle ? `@${handle}` : "agent";
    return {
      label: modeUpdated ? `Mode changed for ${target}` : `Assigned ${target}`,
      detail: dispatchDetail(payload),
      phase: modeUpdated ? "mode" : "assign",
    };
  }
  if (kind === "AGENT_RUN_STARTED") {
    return {
      label: `Run opened${agentSuffix(payload, actorAgentProfileKey)}`,
      detail: "Waiting for wake delivery and acknowledgement",
      phase: "run",
    };
  }
  if (kind === "AGENT_RUN_KICKED") {
    const idleMs = readPayloadNumber(payload, "idleMs");
    return {
      label: `Wake retried${agentSuffix(payload, actorAgentProfileKey)}`,
      detail: idleMs != null ? `last signal ${formatDuration(idleMs)} ago` : payloadDetail(payload),
      phase: "retry",
    };
  }
  if (kind === "AGENT_NOACK") {
    const seconds = readPayloadNumber(payload, "requiredAckSeconds");
    const handle = readPayloadString(payload, "agentProfileKey");
    return {
      label: "Wake missed",
      detail: `${handle ? `@${handle} did not ack` : "Agent did not ack"}${
        seconds != null ? ` within ${Math.round(seconds)}s` : ""
      }`,
      phase: "no ack",
    };
  }
  if (kind === "COMMENT_CREATED" && readPayloadString(payload, "kind") === "STATUS") {
    return {
      label: "Status output posted",
      detail: payloadDetail(payload),
      phase: "output",
    };
  }
  if (kind === "COMMENT_CREATED") {
    const requests = readAgentRequests(payload);
    if (requests.length > 0) {
      const first = requests[0];
      const suffix = requests.length > 1 ? ` +${requests.length - 1}` : "";
      const mode = `${first.mode.charAt(0)}${first.mode.slice(1).toLowerCase()}`;
      return {
        label: `Requested @${first.profileKey}${suffix}`,
        detail: `${mode} agent request${payloadDetail(payload) ? ` · ${payloadDetail(payload)}` : ""}`,
        phase: "request",
      };
    }
  }
  if (kind === "COMMENT_CREATED" && actorAgentProfileKey) {
    return {
      label: `Agent replied from @${actorAgentProfileKey}`,
      detail: payloadDetail(payload),
      phase: "output",
    };
  }
  if (kind === "AGENT_RUN_COMPLETED") {
    const finalStatus = readPayloadString(payload, "finalStatus");
    const label =
      finalStatus === "ABANDONED"
        ? "Run stopped"
        : finalStatus === "STALLED"
          ? "Run stalled"
          : "Run completed";
    return {
      label: `${label}${agentSuffix(payload, actorAgentProfileKey)}`,
      detail: payloadDetail(payload),
      phase: finalStatus === "ABANDONED" ? "stopped" : "done",
    };
  }
  if (kind === "AGENT_RUN_CLEARED") {
    return {
      label: `Run failure cleared${agentSuffix(payload, actorAgentProfileKey)}`,
      detail: payloadDetail(payload),
      phase: "done",
    };
  }
  if (kind === "AGENT_RUN_CONTROL_REQUESTED") {
    return {
      label: controlLabel(payload),
      detail: payloadDetail(payload),
      phase: "control",
    };
  }
  const fallback = KIND_LABEL[kind] ?? { label: kind.replace(/_/g, " ").toLowerCase() };
  return {
    label: fallback.label,
    detail:
      kind.startsWith("AGENT_RUN_") || kind === "AGENT_RUN_BLOCKED" ? payloadDetail(payload) : null,
    phase: fallback.phase,
  };
}

export function IssueActivityPanel({ issueId }: { issueId: string }) {
  const { data, isLoading } = trpc.issue.activity.useQuery(
    { issueId, limit: 50 },
    // Activity changes in bursts as the issue is edited; no need to refetch
    // aggressively — realtime will invalidate on events anyway.
    { staleTime: 30_000 },
  );

  if (isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card/40">
        <header className="flex h-9 items-center gap-2 border-b border-border px-3">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Activity
          </h2>
        </header>
        <p className="py-6 text-center text-xs text-muted-foreground">Loading activity…</p>
      </section>
    );
  }

  const rows = data ?? [];

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Activity
        </h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{rows.length}</span>
      </header>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No activity yet. Status changes, assignments, and comments will show up here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((e) => {
            const agent = e.actorAgent;
            const actorLabel = activityActorName(e);
            const actorKind = activityActorKind(e);
            const actorOwnerTitle = activityActorOwnerTitle(e);
            const copy = activityCopy(e.kind, e.payload, agent?.profileKey ?? null);
            return (
              <li key={e.id} className="flex items-start gap-2 px-3 py-2">
                {agent ? (
                  <AgentAvatar
                    agent={{
                      name: agent.name,
                      profileKey: agent.profileKey,
                      avatar: agent.avatar,
                    }}
                    size="xs"
                  />
                ) : (
                  <Avatar name={actorLabel} image={e.actor?.image ?? null} size={18} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 text-[0.6875rem]">
                    <span className="truncate font-medium" title={actorOwnerTitle}>
                      {actorLabel}
                    </span>
                    {actorKind !== "human" && (
                      <Badge
                        color="#6366f1"
                        className="font-mono text-[0.6875rem] uppercase tracking-wider"
                      >
                        {actorKind}
                      </Badge>
                    )}
                    {copy.phase && (
                      <span className="rounded-sm border border-border bg-subtle px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
                        {copy.phase}
                      </span>
                    )}
                    <span className="truncate text-muted-foreground">{copy.label}</span>
                  </div>
                  {copy.detail && (
                    <div className="text-meta mt-0.5 line-clamp-2 text-foreground/70">
                      {copy.detail}
                    </div>
                  )}
                  <div className="text-meta mt-0.5 text-muted-foreground">
                    {relativeTime(e.createdAt)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
