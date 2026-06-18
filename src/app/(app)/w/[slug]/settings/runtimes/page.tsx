"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Cloud,
  Globe,
  HardDrive,
  Layers,
  Server,
  Sparkles,
  Users as UsersIcon,
} from "lucide-react";
import type { RuntimeKind } from "@prisma/client";
import {
  RUNTIME_TOOL_CAPABILITIES,
  declaredRuntimeToolCapabilities,
  runtimeDeclaresLocalWorkspaceTools,
  runtimeModeToolCapabilities,
  runtimeWorkspaceRoot,
  type RuntimeEngagementMode,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { RuntimeToolSurfaceBadges } from "@/components/runtime-tool-surface";
import {
  RuntimeSelfTestBadge,
  RuntimeSelfTestLine,
} from "@/components/settings/runtime-self-test";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Runtimes index — workspace-scoped registry of compute environments
 * that host agents. A Runtime is the multi-host primitive Forge gained
 * alongside `Agent` in 0018_runtime_and_token_usage:
 *   - LOCAL_DAEMON — `forge daemon` running on a user's machine.
 *   - REMOTE_HTTP  — Hermes-style webhook receiver.
 *   - CLOUD        — reserved for a future Forge-hosted tier.
 *
 * Backend lives in `src/server/routers/runtime.ts`. Detail page is at
 * `./[id]/page.tsx`.
 */

const KIND_LABEL: Record<RuntimeKind, string> = {
  LOCAL_DAEMON: "local daemon",
  REMOTE_HTTP: "remote webhook",
  CLOUD: "cloud",
};

const KIND_ICON: Record<RuntimeKind, typeof Server> = {
  LOCAL_DAEMON: HardDrive,
  REMOTE_HTTP: Globe,
  CLOUD: Cloud,
};

/** Display label for an adapter key (mirrors src/server/runtimes/adapters.ts). */
const ADAPTER_LABEL: Record<string, string> = {
  hermes: "Hermes · managed",
  "local-daemon": "Local daemon · managed",
  "custom-http": "Custom · webhook",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  "codex-app-server": "Codex app server · managed",
};

/** Which connection tier a transport belongs to (see providers-and-transports.md). */
function tierForTransport(transport: string): { n: 1 | 2 | 3; label: string } {
  switch (transport) {
    case "runs-api":
    case "app-server":
      return { n: 1, label: "First-class" };
    case "acp":
    case "mcp":
    case "local-daemon":
      return { n: 2, label: "Session" };
    default:
      return { n: 3, label: "Basic" };
  }
}

/** Human label for how an adapter serves chat. */
const CHATMODE_LABEL: Record<string, string> = {
  runs: "chats as itself",
  acp: "chats as itself",
  completions: "streaming model",
  none: "pull/act only",
};

type AdapterCapabilities = {
  streaming: boolean;
  approvals: boolean;
  toolGrants?: boolean;
  presence: string;
};

function AdapterCapabilityBadges({
  capabilities,
}: {
  capabilities?: AdapterCapabilities;
}) {
  if (!capabilities) return null;
  return (
    <>
      <span
        className={cn(
          "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
          capabilities.streaming
            ? "border-success/30 bg-success/10 text-success"
            : "border-border bg-subtle/40 text-muted-foreground",
        )}
        title="Whether this adapter streams run output back to Forge"
      >
        {capabilities.streaming ? "streaming" : "no stream"}
      </span>
      <span
        className={cn(
          "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
          capabilities.approvals
            ? "border-ember/30 bg-ember/10 text-ember"
            : "border-border bg-subtle/40 text-muted-foreground",
        )}
        title="Whether this adapter can surface runtime approvals"
      >
        {capabilities.approvals ? "approvals" : "no approvals"}
      </span>
      <span
        className={cn(
          "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
          capabilities.toolGrants
            ? "border-success/30 bg-success/10 text-success"
            : "border-border bg-subtle/40 text-muted-foreground",
        )}
        title="Whether this adapter can enforce one-time runtime tool grants"
      >
        {capabilities.toolGrants ? "tool grants" : "no grants"}
      </span>
      <span
        className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
        title="Presence model"
      >
        {capabilities.presence.replace(/-/g, " ")}
      </span>
    </>
  );
}

function ChatModeBadge({ chatMode }: { chatMode: string }) {
  const servesChat = chatMode !== "none";
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
        servesChat
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
          : "border-border bg-subtle/40 text-muted-foreground",
      )}
      title={
        servesChat
          ? "This runtime serves interactive chat — the agent answers as itself."
          : "Pull/act connection: reads context and acts, but doesn't serve a chat turn."
      }
    >
      {CHATMODE_LABEL[chatMode] ?? chatMode}
    </span>
  );
}

export default function RuntimesPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: runtimes, isLoading } = trpc.runtime.list.useQuery({
    includeArchived,
  });

  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    name: string;
    endpoint: string;
    hasSecret: boolean;
    adapterKey: string | null;
    config: unknown;
  } | null>(null);
  const [selfTestTargetId, setSelfTestTargetId] = useState<string | null>(null);

  const { data: adapters } = trpc.runtime.adapters.useQuery();
  const { data: plannedAdapters } = trpc.runtime.plannedAdapters.useQuery();
  const adapterByKey = new Map((adapters ?? []).map((a) => [a.key, a]));

  function invalidate() {
    void utils.runtime.list.invalidate();
  }

  const update = trpc.runtime.update.useMutation({
    onSuccess: () => {
      toast.success("Runtime saved.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const create = trpc.runtime.create.useMutation({
    onSuccess: () => {
      toast.success("Runtime created.");
      invalidate();
      setCreateOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.runtime.archive.useMutation({
    onSuccess: () => {
      toast.success("Runtime archived.");
      invalidate();
      setArchiveTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const unarchive = trpc.runtime.unarchive.useMutation({
    onSuccess: () => {
      toast.success("Runtime restored.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setEnabled = trpc.runtime.setEnabled.useMutation({
    onSuccess: (rt) => {
      toast.success(rt.disabledAt ? "Runtime disabled." : "Runtime enabled.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const runSelfTest = trpc.runtime.runSelfTest.useMutation({
    onSuccess: (res) => {
      const ok = res.result.status === "PASSED";
      const unsupported = res.result.status === "UNSUPPORTED";
      const notify = ok ? toast.success : unsupported ? toast.info : toast.error;
      notify(res.result.detail);
      setSelfTestTargetId(null);
      invalidate();
    },
    onError: (e) => {
      setSelfTestTargetId(null);
      toast.error(e.message);
    },
  });

  const rows = runtimes ?? [];

  return (
    <>
      <Topbar
        title="Runtimes"
        subtitle="Compute environments that host agents."
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setIncludeArchived((v) => !v)}
              title={
                includeArchived
                  ? "Hide archived runtimes"
                  : "Show archived runtimes alongside active"
              }
            >
              {includeArchived ? "Hide archived" : "Show archived"}
            </Button>
            <Button size="sm" variant="ember" onClick={() => setCreateOpen(true)}>
              Add runtime
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <TierExplainer />
          <Card as="div" className="divide-y-0 p-0">
            <ul className="divide-y divide-border">
              {rows.map((rt) => {
                const KindIcon = KIND_ICON[rt.kind];
                const isArchived = Boolean(rt.archivedAt);
                const isDisabled = Boolean(rt.disabledAt);
                const adapter = rt.adapterKey ? adapterByKey.get(rt.adapterKey) : undefined;
                return (
                  <li
                    key={rt.id}
                    data-testid={`runtime-row-${rt.id}`}
                    className={cn(
                      "flex flex-wrap items-start gap-3 px-4 py-3",
                      (isArchived || isDisabled) && "opacity-60",
                    )}
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
                      <KindIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/w/${ws.slug}/settings/runtimes/${rt.id}`}
                          className="truncate text-sm font-medium text-foreground hover:text-ember"
                        >
                          {rt.name}
                        </Link>
                        {rt.adapterKey && ADAPTER_LABEL[rt.adapterKey] ? (
                          <span
                            className="rounded-md border border-ember/30 bg-ember/5 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-foreground/80"
                            title="Runtime adapter — what manages this runtime"
                          >
                            {ADAPTER_LABEL[rt.adapterKey]}
                          </span>
                        ) : (
                          <KindBadge kind={rt.kind} />
                        )}
                        {isArchived && (
                          <span
                            className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                            title="Archived — hidden from active list, heartbeats rejected"
                          >
                            archived
                          </span>
                        )}
                        {isDisabled && !isArchived && (
                          <span
                            data-testid="runtime-disabled-badge"
                            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-amber-700 dark:text-amber-400"
                            title="Disabled — stays configured but won't dial; dispatch skips it and chat reports it disabled"
                          >
                            disabled
                          </span>
                        )}
                        <RuntimeHealthBadge health={rt.health} />
                        <RuntimeSelfTestBadge selfTest={rt.selfTest} />
                        {rt.providersAvailable.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1">
                            {rt.providersAvailable.map((p) => (
                              <span
                                key={p}
                                className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
                        <span>{rt.health.lastSignal}</span>
                        <span>·</span>
                        <span>{rt.health.reason}</span>
                        <span>·</span>
                        <span>{rt.health.sweepExpectation}</span>
                        <span>·</span>
                        <RuntimeSelfTestLine selfTest={rt.selfTest} />
                        <span>·</span>
                        <span className="inline-flex items-center gap-1.5">
                          <UsersIcon className="h-3 w-3" />
                          {rt._count.agents} agent
                          {rt._count.agents === 1 ? "" : "s"}
                        </span>
                        {rt.owner && (
                          <>
                            <span>·</span>
                            <span className="inline-flex items-center gap-1.5">
                              <Avatar
                                name={rt.owner.name}
                                image={rt.owner.image}
                                size={16}
                              />
                              <span className="truncate">
                                {rt.owner.name ?? "unknown"}
                              </span>
                            </span>
                          </>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <RuntimeToolSurfaceBadges
                          adapterKey={rt.adapterKey}
                          config={rt.config}
                          configStatus={rt.configStatus}
                        />
                        <RuntimeInfoBadge summary={rt.runtimeInfoSummary} />
                        <AdapterCapabilityBadges capabilities={adapter?.capabilities} />
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Link
                        href={`/w/${ws.slug}/settings/runtimes/${rt.id}`}
                      >
                        <Button size="sm" variant="ghost">
                          View
                        </Button>
                      </Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSelfTestTargetId(rt.id);
                          runSelfTest.mutate({ id: rt.id });
                        }}
                        disabled={runSelfTest.isPending || isArchived}
                        title={rt.selfTest.expectation}
                      >
                        {runSelfTest.isPending && selfTestTargetId === rt.id
                          ? "Testing…"
                          : "Self-test"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditTarget({
                            id: rt.id,
                            name: rt.name,
                            endpoint: rt.endpoint ?? "",
                            hasSecret: rt.hasSecret,
                            adapterKey: rt.adapterKey,
                            config: rt.config,
                          })
                        }
                      >
                        Edit
                      </Button>
                      {!isArchived && (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="runtime-toggle-enabled"
                          onClick={() =>
                            setEnabled.mutate({ id: rt.id, enabled: isDisabled })
                          }
                          disabled={setEnabled.isPending}
                          title={
                            isDisabled
                              ? "Resume — let this runtime dial again"
                              : "Pause — stop this runtime dialing without deleting it"
                          }
                        >
                          {isDisabled ? "Enable" : "Disable"}
                        </Button>
                      )}
                      {isArchived ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => unarchive.mutate({ id: rt.id })}
                          disabled={unarchive.isPending}
                        >
                          Unarchive
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setArchiveTarget({ id: rt.id, name: rt.name })
                          }
                        >
                          Archive
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
              {!isLoading && rows.length === 0 && (
                <EmptyState
                  icon={Server}
                  title="No runtimes yet"
                  hint={
                    <span>
                      Connect a daemon with{" "}
                      <code className="rounded bg-subtle px-1 font-mono text-[0.6875rem]">
                        forge daemon start
                      </code>
                      . Hermes-style remote runtimes appear here once an
                      agent has a webhook configured.
                    </span>
                  }
                />
              )}
            </ul>
          </Card>

          {(plannedAdapters?.length ?? 0) > 0 && (
            <PlannedAdapters adapters={plannedAdapters ?? []} />
          )}
        </div>
      </div>

      <CreateRuntimeModal
        open={createOpen}
        adapters={adapters ?? []}
        onCancel={() => setCreateOpen(false)}
        onSubmit={async (vals) => {
          await create.mutateAsync(vals);
        }}
        pending={create.isPending}
      />

      <EditRuntimeModal
        target={editTarget}
        onCancel={() => setEditTarget(null)}
        onSubmit={async (vals) => {
          if (!editTarget) return;
          await update.mutateAsync({ id: editTarget.id, ...vals });
          setEditTarget(null);
        }}
        pending={update.isPending}
      />

      <Confirm
        open={!!archiveTarget}
        onOpenChange={(v) => !v && setArchiveTarget(null)}
        title={`Archive ${archiveTarget?.name ?? "runtime"}?`}
        description='The runtime is hidden from the active list. Agents pointing at it stay assigned, but new heartbeats are rejected. Toggle "Show archived" above and use Unarchive to restore.'
        primaryLabel="Archive"
        loading={archive.isPending}
        onConfirm={async () => {
          if (!archiveTarget) return;
          await archive.mutateAsync({ id: archiveTarget.id });
        }}
      />
    </>
  );
}

/**
 * Compact explainer of the three connection tiers. Keeps the mental model
 * in front of the operator right where they manage runtimes, and links to
 * the full doc.
 */
function TierExplainer() {
  const tiers: Array<{ n: number; title: string; body: string; tone: string }> = [
    {
      n: 1,
      title: "First-class",
      body: "Managed runtimes (Hermes, Codex app server). Always-on, full member: chat, dispatch, orchestration. Runs as itself.",
      tone: "border-emerald-500/30 bg-emerald-500/5",
    },
    {
      n: 2,
      title: "Session",
      body: "CLIs over ACP / MCP (Claude Code, Codex CLI, OpenCode). Full power while active, but ephemeral — best for in-session work.",
      tone: "border-ember/30 bg-ember/5",
    },
    {
      n: 3,
      title: "Basic",
      body: "Webhook / HTTP. Fire-and-react push/pull for any runtime that speaks HTTP. No interactive chat turn.",
      tone: "border-border bg-subtle/30",
    },
  ];
  return (
    <Card as="div" className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
          <Layers className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Connection tiers</h3>
          <p className="text-meta text-muted-foreground">
            How richly an agent connects — independent of its chat{" "}
            <a
              href="/docs/agents/engines.html"
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              engine
            </a>
            .{" "}
            <a
              href="/docs/agents/providers-and-transports.html"
              target="_blank"
              rel="noreferrer"
              className="text-ember hover:underline"
            >
              Full breakdown →
            </a>
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {tiers.map((t) => (
          <div key={t.n} className={cn("rounded-lg border p-2.5", t.tone)}>
            <div className="flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background/60 text-[0.5625rem] font-semibold text-foreground/80">
                {t.n}
              </span>
              <span className="text-[0.75rem] font-medium text-foreground">{t.title}</span>
            </div>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">{t.body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

type PlannedAdapterOption = {
  key: string;
  title: string;
  transport: string;
  chatMode: string;
  managed: boolean;
  note: string;
};

/** Roadmap section — declared adapters whose connector hasn't shipped yet. */
function PlannedAdapters({ adapters }: { adapters: PlannedAdapterOption[] }) {
  return (
    <Card as="div" className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Planned runtimes</h3>
          <p className="text-meta text-muted-foreground">
            Declared in the adapter registry; not creatable until their connector ships.
          </p>
        </div>
      </div>
      <ul className="space-y-2">
        {adapters.map((a) => {
          const tier = tierForTransport(a.transport);
          return (
            <li
              key={a.key}
              className="rounded-lg border border-dashed border-border bg-background/30 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{a.title}</span>
                <span
                  className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                  title="Connection tier"
                >
                  tier {tier.n} · {tier.label.toLowerCase()}
                </span>
                <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {a.transport}
                </span>
                <ChatModeBadge chatMode={a.chatMode} />
                <span className="rounded-full border border-ember/30 bg-ember/10 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-ember">
                  planned
                </span>
              </div>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">{a.note}</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function KindBadge({ kind }: { kind: RuntimeKind }) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
        kind === "LOCAL_DAEMON"
          ? "border-ember/30 bg-ember/5 text-foreground/80"
          : kind === "REMOTE_HTTP"
            ? "border-border bg-subtle/40 text-muted-foreground"
            : "border-border bg-subtle/40 text-muted-foreground",
      )}
      title={KIND_LABEL[kind]}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function RuntimeHealthBadge({
  health,
}: {
  health: { label: string; tone: "success" | "warning" | "danger" | "muted"; reason: string };
}) {
  const toneClass =
    health.tone === "success"
      ? "border-success/30 bg-success/10 text-success"
      : health.tone === "danger"
        ? "border-danger/30 bg-danger/10 text-danger"
        : health.tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border bg-subtle/40 text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
        toneClass,
      )}
      title={health.reason}
    >
      {health.label}
    </span>
  );
}

type RuntimeInfoSummary = {
  status: "missing" | "reported";
  label: string;
  detail: string;
  lastReportedAt: Date | string | null;
  fields: Array<{ key: string; label: string; value: string }>;
};

function RuntimeInfoBadge({ summary }: { summary: RuntimeInfoSummary }) {
  if (summary.status !== "reported") return null;
  return (
    <span
      className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
      title={`${summary.detail} ${
        summary.lastReportedAt ? `Reported ${relativeTime(summary.lastReportedAt)} ago.` : ""
      }`}
    >
      {summary.label}
    </span>
  );
}

type AdapterOption = {
  key: string;
  title: string;
  tagline: string;
  transport: string;
  chatMode: string;
  multiAgent: boolean;
  providers: string[];
  capabilities: AdapterCapabilities;
};

const fieldLabel = "mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground";

const RUNTIME_ENGAGEMENT_MODES = ["EXECUTE", "REVIEW", "RESEARCH", "DISCUSS"] as const;

const MODE_COPY: Record<RuntimeEngagementMode, { label: string; hint: string }> = {
  EXECUTE: {
    label: "Execute",
    hint: "Implementation work. Usually full repo tools.",
  },
  REVIEW: {
    label: "Review",
    hint: "Inspection without issue mutation.",
  },
  RESEARCH: {
    label: "Research",
    hint: "Read and investigate.",
  },
  DISCUSS: {
    label: "Discuss",
    hint: "Conversation only by default.",
  },
};

type ModeToolProfiles = Record<RuntimeEngagementMode, RuntimeToolCapability[]>;

function emptyModeToolProfiles(): ModeToolProfiles {
  return {
    EXECUTE: [],
    REVIEW: [],
    RESEARCH: [],
    DISCUSS: [],
  };
}

type RuntimeToolPolicy = {
  localWorkspaceTools: boolean;
  toolCapabilities: RuntimeToolCapability[];
  workspaceRoot: string;
  modeToolPolicyEnforced: boolean;
  modeToolProfiles: ModeToolProfiles;
};

const DEFAULT_RUNTIME_TOOL_POLICY: RuntimeToolPolicy = {
  localWorkspaceTools: false,
  toolCapabilities: [],
  workspaceRoot: "",
  modeToolPolicyEnforced: false,
  modeToolProfiles: emptyModeToolProfiles(),
};

type HermesRuntimePolicy = RuntimeToolPolicy & {
  profile: string;
  mode: string;
  model: string;
  yoloMode: boolean;
};

const DEFAULT_HERMES_RUNTIME_POLICY: HermesRuntimePolicy = {
  ...DEFAULT_RUNTIME_TOOL_POLICY,
  profile: "",
  mode: "",
  model: "",
  yoloMode: false,
};

function runtimeToolPolicyFromConfig(config: unknown): RuntimeToolPolicy {
  const modeToolProfiles = emptyModeToolProfiles();
  for (const mode of RUNTIME_ENGAGEMENT_MODES) {
    modeToolProfiles[mode] = runtimeModeToolCapabilities(config, mode);
  }
  return {
    localWorkspaceTools: runtimeDeclaresLocalWorkspaceTools(config),
    toolCapabilities: declaredRuntimeToolCapabilities(config),
    workspaceRoot: runtimeWorkspaceRoot(config) ?? "",
    modeToolPolicyEnforced:
      !!(
        config &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        (config as Record<string, unknown>).modeToolPolicyEnforced === true
      ),
    modeToolProfiles,
  };
}

function runtimeToolPolicyToConfig(p: RuntimeToolPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {
    localWorkspaceTools: p.localWorkspaceTools,
    modeToolPolicyEnforced: p.modeToolPolicyEnforced,
  };
  const tools = RUNTIME_TOOL_CAPABILITIES.filter((tool) =>
    p.toolCapabilities.includes(tool),
  );
  out.toolCapabilities = tools;
  out.modeToolProfiles = Object.fromEntries(
    RUNTIME_ENGAGEMENT_MODES.map((mode) => [
      mode,
      RUNTIME_TOOL_CAPABILITIES.filter((tool) =>
        p.modeToolProfiles[mode]?.includes(tool),
      ),
    ]),
  );
  if (p.workspaceRoot.trim()) out.workspaceRoot = p.workspaceRoot.trim();
  return out;
}

function hermesRuntimePolicyFromConfig(config: unknown): HermesRuntimePolicy {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return {
    ...runtimeToolPolicyFromConfig(config),
    profile: typeof c.profile === "string" ? c.profile : "",
    mode: typeof c.mode === "string" ? c.mode : "",
    model: typeof c.model === "string" ? c.model : "",
    yoloMode: c.yoloMode === true,
  };
}

function hermesRuntimePolicyToConfig(p: HermesRuntimePolicy): Record<string, unknown> {
  const out = runtimeToolPolicyToConfig(p);
  if (p.profile.trim()) out.profile = p.profile.trim();
  if (p.mode.trim()) out.mode = p.mode.trim();
  if (p.model.trim()) out.model = p.model.trim();
  out.yoloMode = p.yoloMode;
  return out;
}

function HermesRuntimeFields({
  value,
  onChange,
}: {
  value: HermesRuntimePolicy;
  onChange: (v: HermesRuntimePolicy) => void;
}) {
  return (
    <div className="space-y-3">
      <div
        data-testid="hermes-runtime-fields"
        className="space-y-3 rounded-lg border border-border bg-subtle/20 p-3"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[0.75rem] font-medium text-foreground">Hermes run defaults</span>
          <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
            runtime config
          </span>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.yoloMode}
            onChange={(e) => onChange({ ...value, yoloMode: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="block font-medium text-foreground">YOLO auto-approve</span>
            <span className="block text-meta text-muted-foreground">
              Forge auto-resolves Hermes approval requests for runs from this runtime.
            </span>
          </span>
        </label>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block">
            <span className={fieldLabel}>Profile</span>
            <Input
              value={value.profile}
              onChange={(e) => onChange({ ...value, profile: e.target.value })}
              placeholder="victor"
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Mode</span>
            <Input
              value={value.mode}
              onChange={(e) => onChange({ ...value, mode: e.target.value })}
              placeholder="default"
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>Model</span>
            <Input
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
              placeholder="provider/model"
              className="font-mono"
            />
          </label>
        </div>
      </div>
      <RuntimeToolPolicyFields value={value} onChange={(next) => onChange({ ...value, ...next })} />
    </div>
  );
}

function RuntimeToolPolicyFields({
  value,
  onChange,
}: {
  value: RuntimeToolPolicy;
  onChange: (v: RuntimeToolPolicy) => void;
}) {
  const declaredTools = new Set(value.toolCapabilities);

  function toggleTool(tool: RuntimeToolCapability, checked: boolean) {
    const next = new Set(value.toolCapabilities);
    if (checked) next.add(tool);
    else next.delete(tool);
    const nextCapabilities = RUNTIME_TOOL_CAPABILITIES.filter((key) => next.has(key));
    const nextProfiles = emptyModeToolProfiles();
    for (const mode of RUNTIME_ENGAGEMENT_MODES) {
      const currentModeTools = new Set(value.modeToolProfiles[mode] ?? []);
      if (checked && mode === "EXECUTE") currentModeTools.add(tool);
      nextProfiles[mode] = RUNTIME_TOOL_CAPABILITIES.filter(
        (key) => next.has(key) && currentModeTools.has(key),
      );
    }
    onChange({
      ...value,
      localWorkspaceTools: checked ? value.localWorkspaceTools : false,
      toolCapabilities: nextCapabilities,
      modeToolProfiles: nextProfiles,
    });
  }

  function toggleModeTool(
    mode: RuntimeEngagementMode,
    tool: RuntimeToolCapability,
    checked: boolean,
  ) {
    if (!declaredTools.has(tool)) return;
    const next = new Set(value.modeToolProfiles[mode] ?? []);
    if (checked) next.add(tool);
    else next.delete(tool);
    onChange({
      ...value,
      modeToolProfiles: {
        ...value.modeToolProfiles,
        [mode]: RUNTIME_TOOL_CAPABILITIES.filter((key) => next.has(key)),
      },
    });
  }

  return (
    <div
      data-testid="runtime-tool-surface-fields"
      className="space-y-3 rounded-lg border border-border bg-subtle/20 p-3"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[0.75rem] font-medium text-foreground">Hermes tool surface</span>
        <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          runtime config
        </span>
      </div>
      <label className="flex items-start gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.localWorkspaceTools}
            onChange={(e) =>
              onChange({
                ...value,
                localWorkspaceTools: e.target.checked,
                toolCapabilities: e.target.checked
                  ? [...RUNTIME_TOOL_CAPABILITIES]
                  : [],
                modeToolProfiles: e.target.checked
                  ? {
                      ...value.modeToolProfiles,
                      EXECUTE: [...RUNTIME_TOOL_CAPABILITIES],
                    }
                  : emptyModeToolProfiles(),
              })
            }
          />
        <span className="min-w-0">
          <span className="block font-medium text-foreground">Local workspace tools enabled</span>
          <span className="block text-meta text-muted-foreground">
            Use only when the Hermes host can run commands in the repo.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.modeToolPolicyEnforced}
          onChange={(e) =>
            onChange({
              ...value,
              modeToolPolicyEnforced: e.target.checked,
            })
          }
        />
        <span className="min-w-0">
          <span className="block font-medium text-foreground">Host-enforced mode tools</span>
          <span className="block text-meta text-muted-foreground">
            Hermes enforces Forge&apos;s per-run tool allowlist for non-Execute modes.
          </span>
        </span>
      </label>
      <div>
        <span className={fieldLabel}>Declared tools</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {RUNTIME_TOOL_CAPABILITIES.map((tool) => (
            <label
              key={tool}
              className="flex items-center gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={value.toolCapabilities.includes(tool)}
                onChange={(e) => toggleTool(tool, e.target.checked)}
              />
              <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-foreground/80">
                {tool}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <span className={fieldLabel}>Allowed by mode</span>
        <div className="space-y-2">
          {RUNTIME_ENGAGEMENT_MODES.map((mode) => {
            const copy = MODE_COPY[mode];
            return (
              <div
                key={mode}
                className="grid gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{copy.label}</div>
                  <div className="text-meta text-muted-foreground">{copy.hint}</div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {RUNTIME_TOOL_CAPABILITIES.map((tool) => {
                    const disabled = !declaredTools.has(tool);
                    return (
                      <label
                        key={tool}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.6875rem]",
                          disabled
                            ? "border-border bg-subtle/20 text-muted-foreground/50"
                            : "border-border bg-card/40 text-foreground/80",
                        )}
                        title={
                          disabled
                            ? `Declare ${tool} before allowing it in ${copy.label}`
                            : `${copy.label} may use ${tool}`
                        }
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={value.modeToolProfiles[mode]?.includes(tool) ?? false}
                          onChange={(e) => toggleModeTool(mode, tool, e.target.checked)}
                        />
                        <span className="font-mono uppercase tracking-wider">{tool}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <span className="mt-1.5 block text-[0.625rem] text-muted-foreground/70">
          Hermes receives this per-run allowlist. Non-Execute modes keep Forge issue
          mutations blocked; this only changes host tools.
        </span>
      </div>
      <label className="block">
        <span className={fieldLabel}>
          Workspace root{" "}
          <span className="normal-case text-muted-foreground/70">(optional)</span>
        </span>
        <Input
          value={value.workspaceRoot}
          onChange={(e) => onChange({ ...value, workspaceRoot: e.target.value })}
          placeholder="/home/bailey/forge"
          className="font-mono"
        />
      </label>
    </div>
  );
}

function CreateRuntimeModal({
  open,
  adapters,
  onCancel,
  onSubmit,
  pending,
}: {
  open: boolean;
  adapters: AdapterOption[];
  onCancel: () => void;
  onSubmit: (vals: {
    adapterKey: string;
    name: string;
    endpoint?: string;
    secret?: string;
    config?: Record<string, unknown>;
  }) => Promise<void>;
  pending: boolean;
}) {
  const [adapterKey, setAdapterKey] = useState("");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [codex, setCodex] = useState<CodexPolicy>(DEFAULT_CODEX_POLICY);
  const [hermes, setHermes] = useState<HermesRuntimePolicy>(
    DEFAULT_HERMES_RUNTIME_POLICY,
  );

  useEffect(() => {
    if (open) {
      const first = adapters[0]?.key ?? "";
      setAdapterKey(first);
      setName("");
      setEndpoint("");
      setSecret("");
      setCodex(DEFAULT_CODEX_POLICY);
      setHermes(DEFAULT_HERMES_RUNTIME_POLICY);
    }
  }, [open, adapters]);

  const adapter = adapters.find((a) => a.key === adapterKey);
  const isCodex = adapterKey === "codex-app-server";
  const isHermes = adapterKey === "hermes";

  return (
    <QuickForm
      open={open}
      onOpenChange={(v) => !v && onCancel()}
      title="Add managed runtime"
      description="A managed runtime owns its endpoint + secret and can host agents (e.g. a Hermes gateway). Attach agents to it from the Agents page."
      primaryLabel="Create"
      loading={pending}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!adapterKey) return { error: "Pick an adapter." };
        if (!name.trim()) return { error: "Name cannot be empty." };
        try {
          await onSubmit({
            adapterKey,
            name: name.trim(),
            endpoint: endpoint.trim() || undefined,
            secret: secret.trim() || undefined,
            config: isCodex
              ? codexPolicyToConfig(codex)
              : isHermes
                ? hermesRuntimePolicyToConfig(hermes)
                : undefined,
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Create failed." };
        }
      }}
    >
      <div className="space-y-3">
        <label className="block">
          <span className={fieldLabel}>Adapter</span>
          <select
            className="focus-ring h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
            value={adapterKey}
            onChange={(e) => setAdapterKey(e.target.value)}
          >
            {adapters.map((a) => (
              <option key={a.key} value={a.key}>
                {a.title}
              </option>
            ))}
          </select>
          {adapter && (
            <>
              <span className="mt-1 block text-xs text-muted-foreground">{adapter.tagline}</span>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {(() => {
                  const tier = tierForTransport(adapter.transport);
                  return (
                    <span
                      className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                      title="Connection tier"
                    >
                      tier {tier.n} · {tier.label.toLowerCase()}
                    </span>
                  );
                })()}
                <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {adapter.transport}
                </span>
                <ChatModeBadge chatMode={adapter.chatMode} />
                {adapter.multiAgent && (
                  <span
                    className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                    title="One runtime can host multiple agent profiles"
                  >
                    multi-agent
                  </span>
                )}
                <AdapterCapabilityBadges capabilities={adapter.capabilities} />
              </div>
            </>
          )}
        </label>
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder={adapter?.title ?? "Runtime name"}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>
            Endpoint{" "}
            <span className="normal-case text-muted-foreground/70">
              {adapter?.transport === "app-server"
                ? "(Codex app-server WebSocket, e.g. ws://127.0.0.1:4500)"
                : "(gateway base URL, e.g. http://127.0.0.1:8642/v1)"}
            </span>
          </span>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={adapter?.transport === "app-server" ? "wss://…" : "https://…"}
            className="font-mono"
          />
          <span className="mt-1 block text-[0.625rem] text-muted-foreground/70">
            Public hosts must use a secure transport (wss:// or https://); plaintext is
            allowed only for loopback / private-LAN addresses.
          </span>
        </label>
        <label className="block">
          <span className={fieldLabel}>Secret (optional)</span>
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="HMAC / gateway token"
            className="font-mono"
          />
        </label>
        {isCodex && <CodexDockerBridgeHint />}
        {isCodex && <CodexPolicyFields value={codex} onChange={setCodex} />}
        {isHermes && <HermesRuntimeFields value={hermes} onChange={setHermes} />}
      </div>
    </QuickForm>
  );
}

function CodexDockerBridgeHint() {
  return (
    <div className="rounded-md border border-ember/30 bg-ember/5 px-3 py-2 text-meta text-muted-foreground">
      <div className="font-medium text-foreground">Recommended: Docker bridge</div>
      <div className="mt-1">
        Run the Codex stdio-to-WebSocket bridge in Docker, mount{" "}
        <span className="font-mono">~/.codex/auth.json</span> read-only, mount a scoped{" "}
        <span className="font-mono">/work</span> workspace, and point this endpoint at{" "}
        <span className="font-mono">ws://&lt;private-host&gt;:4505</span>. The runtime secret gates
        Forge-to-bridge traffic; Codex auth stays in the bridge/container.
      </div>
      <a
        href="/docs/agents/codex-app-server-docker.html"
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-flex text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      >
        Open Docker bridge guide
      </a>
    </div>
  );
}

function EditRuntimeModal({
  target,
  onCancel,
  onSubmit,
  pending,
}: {
  target: {
    id: string;
    name: string;
    endpoint: string;
    hasSecret: boolean;
    adapterKey: string | null;
    config: unknown;
  } | null;
  onCancel: () => void;
  onSubmit: (vals: {
    name: string;
    endpoint: string;
    secret?: string;
    config?: Record<string, unknown>;
  }) => Promise<void>;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [codex, setCodex] = useState<CodexPolicy>(DEFAULT_CODEX_POLICY);
  const [hermes, setHermes] = useState<HermesRuntimePolicy>(
    DEFAULT_HERMES_RUNTIME_POLICY,
  );
  const isCodex = target?.adapterKey === "codex-app-server";
  const isHermes = target?.adapterKey === "hermes";

  useEffect(() => {
    if (target) {
      setName(target.name);
      setEndpoint(target.endpoint);
      setSecret("");
      setCodex(codexPolicyFromConfig(target.config));
      setHermes(hermesRuntimePolicyFromConfig(target.config));
    }
  }, [target]);

  return (
    <QuickForm
      open={!!target}
      onOpenChange={(v) => !v && onCancel()}
      title="Edit runtime"
      description="Update the connection details. Agents attached to this runtime keep their attachment."
      primaryLabel="Save"
      loading={pending}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return { error: "Name cannot be empty." };
        try {
          // Empty secret = leave the stored one unchanged.
          await onSubmit({
            name: name.trim(),
            endpoint: endpoint.trim(),
            secret: secret.trim() || undefined,
            config: isCodex
              ? codexPolicyToConfig(codex)
              : isHermes
                ? hermesRuntimePolicyToConfig(hermes)
                : undefined,
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Save failed." };
        }
      }}
    >
      <div className="space-y-3">
        <label className="block">
          <span className={fieldLabel}>Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Runtime name"
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>Endpoint</span>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…"
            className="font-mono"
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>
            Secret{" "}
            <span className="normal-case text-muted-foreground/70">
              ({target?.hasSecret ? "configured — blank keeps it" : "none set"})
            </span>
          </span>
          <Input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={target?.hasSecret ? "••••••••" : "HMAC / gateway token"}
            className="font-mono"
          />
        </label>
        {isCodex && <CodexPolicyFields value={codex} onChange={setCodex} />}
        {isHermes && <HermesRuntimeFields value={hermes} onChange={setHermes} />}
      </div>
    </QuickForm>
  );
}

/** Operator-facing Codex sandbox / approval policy (mirrors the connector). */
type CodexPolicy = {
  sandboxMode: "danger-full-access" | "workspace-write" | "read-only";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  model: string;
  yoloMode: boolean;
  workspaceRoot: string;
};

const DEFAULT_CODEX_POLICY: CodexPolicy = {
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  model: "",
  yoloMode: false,
  workspaceRoot: "",
};

const SANDBOX_MODE_OPTIONS: Array<{ value: CodexPolicy["sandboxMode"]; label: string }> = [
  { value: "danger-full-access", label: "Full access (no sandbox)" },
  { value: "workspace-write", label: "Workspace-write (scoped to root)" },
  { value: "read-only", label: "Read-only" },
];

const APPROVAL_POLICY_OPTIONS: Array<{ value: CodexPolicy["approvalPolicy"]; label: string }> = [
  { value: "never", label: "Never ask (auto-run)" },
  { value: "on-request", label: "On request (escalations prompt)" },
  { value: "on-failure", label: "On failure (prompt if sandbox blocks)" },
  { value: "untrusted", label: "Untrusted (prompt for anything risky)" },
];

function codexPolicyFromConfig(config: unknown): CodexPolicy {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return {
    sandboxMode:
      (SANDBOX_MODE_OPTIONS.find((o) => o.value === c.sandboxMode)?.value as
        | CodexPolicy["sandboxMode"]
        | undefined) ?? DEFAULT_CODEX_POLICY.sandboxMode,
    approvalPolicy:
      (APPROVAL_POLICY_OPTIONS.find((o) => o.value === c.approvalPolicy)?.value as
        | CodexPolicy["approvalPolicy"]
        | undefined) ?? DEFAULT_CODEX_POLICY.approvalPolicy,
    model: typeof c.model === "string" ? c.model : "",
    yoloMode: c.yoloMode === true,
    workspaceRoot: typeof c.workspaceRoot === "string" ? c.workspaceRoot : "",
  };
}

function codexPolicyToConfig(p: CodexPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sandboxMode: p.sandboxMode,
    approvalPolicy: p.approvalPolicy,
    yoloMode: p.yoloMode,
  };
  if (p.model.trim()) out.model = p.model.trim();
  if (p.workspaceRoot.trim()) {
    out.workspaceRoot = p.workspaceRoot.trim();
    out.localWorkspaceTools = true;
    out.toolCapabilities = [...RUNTIME_TOOL_CAPABILITIES];
  }
  return out;
}

/**
 * Codex app-server sandbox + approval controls. The connector sends these as
 * per-turn `sandboxPolicy` / `approvalPolicy` / `cwd` overrides — so flipping
 * them here re-scopes the agent without restarting the bridge. The container
 * the bridge runs in is the outer jail regardless of these values.
 */
function CodexPolicyFields({
  value,
  onChange,
}: {
  value: CodexPolicy;
  onChange: (v: CodexPolicy) => void;
}) {
  const selectClass =
    "focus-ring h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm";
  return (
    <div
      data-testid="codex-sandbox-fields"
      className="space-y-3 rounded-lg border border-border bg-subtle/20 p-3"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[0.75rem] font-medium text-foreground">Codex sandbox</span>
        <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          per-turn
        </span>
      </div>
      <label className="flex items-start gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.yoloMode}
          onChange={(e) =>
            onChange({
              ...value,
              yoloMode: e.target.checked,
              ...(e.target.checked
                ? { sandboxMode: "danger-full-access" as const, approvalPolicy: "never" as const }
                : {}),
            })
          }
        />
        <span className="min-w-0">
          <span className="block font-medium text-foreground">YOLO mode</span>
          <span className="block text-meta text-muted-foreground">
            Every turn (chat, dispatch, research) runs with full access and skips
            approval prompts. Forces danger-full-access + approval “never”.
          </span>
        </span>
      </label>
      <label className="block">
        <span className={fieldLabel}>Model</span>
        <Input
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          placeholder="gpt-5.5-codex"
          className="font-mono"
        />
      </label>
      <label className="block">
        <span className={fieldLabel}>Sandbox mode</span>
        <select
          data-testid="codex-sandbox-mode"
          className={selectClass}
          value={value.sandboxMode}
          onChange={(e) =>
            onChange({ ...value, sandboxMode: e.target.value as CodexPolicy["sandboxMode"] })
          }
        >
          {SANDBOX_MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={fieldLabel}>Approval policy</span>
        <select
          className={selectClass}
          value={value.approvalPolicy}
          onChange={(e) =>
            onChange({ ...value, approvalPolicy: e.target.value as CodexPolicy["approvalPolicy"] })
          }
        >
          {APPROVAL_POLICY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[0.625rem] text-muted-foreground/70">
          Anything but “never” surfaces command/file approvals as cards in chat for you to
          accept or deny.
        </span>
      </label>
      <label className="block">
        <span className={fieldLabel}>
          Workspace root{" "}
          <span className="normal-case text-muted-foreground/70">(writable dir, e.g. /work)</span>
        </span>
        <Input
          value={value.workspaceRoot}
          onChange={(e) => onChange({ ...value, workspaceRoot: e.target.value })}
          placeholder="/work"
          className="font-mono"
        />
        <span className="mt-1 block text-[0.625rem] text-muted-foreground/70">
          Working directory for each turn. Setting this also declares terminal,
          filesystem, and git access for runtime preflight.
        </span>
      </label>
    </div>
  );
}
