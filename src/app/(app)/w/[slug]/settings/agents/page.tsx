"use client";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Code2,
  KeyRound,
  PlugZap,
  Radio,
  ServerCog,
  Terminal,
  Webhook,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { useWorkspace } from "@/hooks/use-workspace";
import { TransportChip } from "@/components/agents/transport-chip";
import { FleetChecklist } from "@/components/agents/fleet-checklist";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CenterModal, Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentQuickActions } from "@/components/agent-quick-actions";
import {
  CodeBlock,
  McpIntegrationBlocks,
  type McpOnboardingProvider,
} from "@/components/mcp-integration-blocks";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Workspace-scoped agent registry.
 *
 * Agents are MCP-first actors that may be persistent webhook receivers
 * (Hermes/custom bridges) or single-session MCP clients (Claude/Codex today).
 * This admin surface registers the row, optionally issues a linked MCP key,
 * and keeps push webhooks optional instead of implied.
 */

const PROFILE_KEY_RE = /^[a-z0-9][a-z0-9-_]*$/;

const KEY_SCOPES = [
  "READ_ISSUES",
  "WRITE_ISSUES",
  "READ_PROJECTS",
  "READ_COMMENTS",
  "WRITE_COMMENTS",
  "READ_USERS",
  "READ_ANALYTICS",
  "SUBSCRIBE_EVENTS",
] as const;
const FULL_KEY_SCOPES = [...KEY_SCOPES, "INVOKE_SKILLS"] as const;
type Scope = (typeof FULL_KEY_SCOPES)[number];

type AgentProviderId = "HERMES" | "CLAUDE" | "CODEX" | "CUSTOM";
type RuntimeMode = "PERSISTENT" | "EPHEMERAL";
type ConnectionMode = "mcp" | "webhook";
type KeyPreset = "agent" | "read" | "full";

type EditingState = {
  id?: string;
  name: string;
  profileKey: string;
  description: string;
  avatar: string;
  provider: AgentProviderId;
  runtimeMode: RuntimeMode;
  connectionMode: ConnectionMode;
  webhookUrl: string;
  webhookSecret: string;
  /** Managed runtime this agent attaches to. "" = unattached. */
  runtimeId: string;
  capabilitiesRaw: string;
  maxConcurrent: number;
  /** Chat engine: DEFAULT = integration default, else explicit override. */
  runEngine: "DEFAULT" | "COMPLETIONS" | "RUNS";
  templateMarkdown: string;
  createApiKey: boolean;
  keyPreset: KeyPreset;
  keyName: string;
  keyExpiresInDays: string;
};

const PROVIDERS: Array<{
  id: AgentProviderId;
  label: string;
  eyebrow: string;
  description: string;
  defaultConnectionMode: ConnectionMode;
  defaultRuntimeMode: RuntimeMode;
  Icon: ComponentType<{ className?: string }>;
}> = [
  {
    id: "HERMES",
    label: "Hermes",
    eyebrow: "first-class",
    description: "Persistent profile with signed push dispatch and MCP callbacks.",
    defaultConnectionMode: "webhook",
    defaultRuntimeMode: "PERSISTENT",
    Icon: ServerCog,
  },
  {
    id: "CLAUDE",
    label: "Claude",
    eyebrow: "MCP client",
    description: "Claude Desktop or Claude Code sessions using a linked Forge MCP key.",
    defaultConnectionMode: "mcp",
    defaultRuntimeMode: "EPHEMERAL",
    Icon: Radio,
  },
  {
    id: "CODEX",
    label: "Codex",
    eyebrow: "MCP client",
    description: "Codex CLI or IDE extension session connected through streamable HTTP MCP.",
    defaultConnectionMode: "mcp",
    defaultRuntimeMode: "EPHEMERAL",
    Icon: Terminal,
  },
  {
    id: "CUSTOM",
    label: "Custom",
    eyebrow: "bring a bridge",
    description: "Any runtime that can call Forge MCP, optionally with a webhook adapter.",
    defaultConnectionMode: "mcp",
    defaultRuntimeMode: "EPHEMERAL",
    Icon: PlugZap,
  },
];

const PROVIDER_LABEL = new Map(PROVIDERS.map((p) => [p.id, p.label]));

const EMPTY_EDITING: EditingState = {
  name: "",
  profileKey: "",
  description: "",
  avatar: "",
  provider: "HERMES",
  runtimeMode: "PERSISTENT",
  connectionMode: "webhook",
  webhookUrl: "",
  webhookSecret: "",
  runtimeId: "",
  capabilitiesRaw: "",
  maxConcurrent: 1,
  runEngine: "DEFAULT",
  templateMarkdown: "",
  createApiKey: true,
  keyPreset: "agent",
  keyName: "",
  keyExpiresInDays: "",
};

const TEMPLATE_PLACEHOLDER = `### Context

### Acceptance criteria

### Constraints`;

const STEPS = ["Provider", "Profile", "Connection", "Workload", "Review"];

export default function AgentsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: agents, refetch, isLoading } = trpc.agent.list.useQuery({
    includeArchived: true,
  });
  const { data: runtimes } = trpc.runtime.list.useQuery({ includeArchived: false });

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [step, setStep] = useState(0);

  // Live preview of how this agent's chat would be served, for the Connection
  // + Review steps. Recomputed as provider / runtime / engine change.
  const { data: transportPreview } = trpc.agent.previewTransport.useQuery(
    {
      provider: editing?.provider ?? "HERMES",
      runtimeId: editing?.runtimeId || null,
      runEngine:
        editing?.runEngine && editing.runEngine !== "DEFAULT" ? editing.runEngine : null,
      webhookUrl:
        editing?.connectionMode === "webhook" ? editing.webhookUrl || undefined : undefined,
    },
    { enabled: Boolean(editing) && step >= 2, staleTime: 5_000 },
  );
  const [webhookTestResult, setWebhookTestResult] = useState<{
    ok: boolean;
    status: number;
    responseBody: string | null;
  } | null>(null);
  const [revealKey, setRevealKey] = useState<{
    name: string;
    rawKey: string;
    scopes: Scope[];
    provider: McpOnboardingProvider;
  } | null>(null);
  const [mcpTest, setMcpTest] = useState<{
    state: "idle" | "pending" | "ok" | "error";
    message: string;
  }>({ state: "idle", message: "" });
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    profileKey: string;
    assigned: number;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    name: string;
    archived: boolean;
  } | null>(null);

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL ?? "https://forge.axiom-labs.dev";

  const rows = useMemo(() => agents ?? [], [agents]);
  const isNew = !!editing && !editing.id;

  const create = trpc.agent.create.useMutation();
  const update = trpc.agent.update.useMutation();
  const issueKey = trpc.access.create.useMutation();
  const [verifyResult, setVerifyResult] = useState<{
    ready: boolean;
    transportLabel: string;
    hint: string;
    probe: { attempted: boolean; reachable: boolean | null; detail: string };
  } | null>(null);
  const verify = trpc.agent.verifyConnection.useMutation({
    onSuccess: (r) => {
      setVerifyResult(r);
      if (r.probe.attempted && r.probe.reachable === false) {
        toast.error(`Runtime unreachable: ${r.probe.detail}`);
      } else if (r.ready) {
        toast.success(`Chat ready · ${r.transportLabel}`);
      } else {
        toast.error("Not chat-ready — see details.");
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const testWebhook = trpc.agent.testWebhook.useMutation({
    onSuccess: (res) => {
      setWebhookTestResult(res);
      if (res.ok) toast.success("Webhook responded successfully.");
      else toast.error(`Webhook test failed${res.status ? ` (${res.status})` : ""}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.agent.archive.useMutation({
    onSuccess: () => {
      toast.success("Agent archived.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const unarchive = trpc.agent.unarchive.useMutation({
    onSuccess: () => {
      toast.success("Agent restored.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.agent.delete.useMutation({
    onSuccess: () => {
      toast.success("Agent deleted.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = create.isPending || update.isPending || issueKey.isPending;

  function invalidate() {
    void utils.agent.list.invalidate();
    void utils.access.list.invalidate();
    void refetch();
  }

  function openNew() {
    setEditing({ ...EMPTY_EDITING });
    setStep(0);
    setWebhookTestResult(null);
  }

  function parseCapabilities(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[,\n]/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0 && s.length <= 40),
      ),
    ).slice(0, 32);
  }

  function keyScopes(preset: KeyPreset): Scope[] {
    if (preset === "read") {
      return ["READ_ISSUES", "READ_PROJECTS", "READ_COMMENTS", "READ_USERS", "READ_ANALYTICS"];
    }
    if (preset === "full") return [...FULL_KEY_SCOPES];
    return [...KEY_SCOPES];
  }

  function toMcpProvider(provider: AgentProviderId): McpOnboardingProvider {
    if (provider === "HERMES") return "hermes";
    if (provider === "CLAUDE") return "claude";
    if (provider === "CODEX") return "codex";
    return "custom";
  }

  function validate(e: EditingState): string | null {
    if (!e.name.trim()) return "Name required.";
    if (!PROFILE_KEY_RE.test(e.profileKey))
      return "profileKey must be lowercase letters, digits, `-` or `_` (start with a letter or digit).";
    if (e.connectionMode === "webhook" && e.webhookUrl.trim()) {
      try {
        new URL(e.webhookUrl.trim());
      } catch {
        return "Webhook URL must be a valid http(s) URL.";
      }
    }
    if (e.connectionMode === "webhook" && !e.webhookUrl.trim()) {
      return "Webhook URL is required for push delivery. Choose MCP-only if this agent pulls work.";
    }
    if (
      (e.provider === "CLAUDE" || e.provider === "CODEX") &&
      e.runtimeMode === "PERSISTENT"
    ) {
      return "Persistent Claude and Codex agents are on the roadmap. Use single-session mode for now.";
    }
    if (!Number.isFinite(e.maxConcurrent) || e.maxConcurrent < 0)
      return "Max concurrent must be >= 0.";
    if (e.createApiKey && e.keyExpiresInDays) {
      const days = Number(e.keyExpiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return "Key expiry must be between 1 and 365 days.";
      }
    }
    return null;
  }

  function validateCurrentStep(): string | null {
    if (!editing) return null;
    if (step === 1) {
      if (!editing.name.trim()) return "Name required.";
      if (!PROFILE_KEY_RE.test(editing.profileKey))
        return "profileKey must be lowercase letters, digits, `-` or `_`.";
    }
    if (step === 2) {
      if (editing.connectionMode === "webhook" && !editing.webhookUrl.trim()) {
        return "Webhook URL is required for push delivery.";
      }
      if (editing.connectionMode === "webhook" && editing.webhookUrl.trim()) {
        try {
          new URL(editing.webhookUrl.trim());
        } catch {
          return "Webhook URL must be valid.";
        }
      }
    }
    if (step === 3 && (!Number.isFinite(editing.maxConcurrent) || editing.maxConcurrent < 0)) {
      return "Max concurrent must be >= 0.";
    }
    return null;
  }

  function nextStep() {
    const err = validateCurrentStep();
    if (err) {
      toast.error(err);
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  async function submit() {
    if (!editing) return;
    const err = validate(editing);
    if (err) {
      toast.error(err);
      return;
    }

    const capabilities = parseCapabilities(editing.capabilitiesRaw);
    const description = editing.description.trim() || undefined;
    const avatar = editing.avatar.trim() || undefined;
    const webhookUrl =
      editing.connectionMode === "webhook" ? editing.webhookUrl.trim() : "";
    const webhookSecret =
      editing.connectionMode === "webhook" ? editing.webhookSecret.trim() : "";
    const templateMarkdown =
      editing.templateMarkdown.trim().length > 0 ? editing.templateMarkdown : undefined;

    try {
      if (editing.id) {
        await update.mutateAsync({
          id: editing.id,
          name: editing.name.trim(),
          description: description ?? null,
          avatar: avatar ?? null,
          provider: editing.provider,
          runtimeMode: editing.runtimeMode,
          runEngine: editing.runEngine === "DEFAULT" ? null : editing.runEngine,
          webhookUrl: webhookUrl || null,
          webhookSecret: webhookSecret || null,
          runtimeId: editing.runtimeId || null,
          capabilities,
          maxConcurrent: Math.floor(editing.maxConcurrent),
          templateMarkdown: templateMarkdown ?? null,
        });
        toast.success("Agent updated.");
      } else {
        const agent = await create.mutateAsync({
          name: editing.name.trim(),
          profileKey: editing.profileKey.trim(),
          description,
          avatar,
          provider: editing.provider,
          runtimeMode: editing.runtimeMode,
          runEngine: editing.runEngine === "DEFAULT" ? null : editing.runEngine,
          webhookUrl,
          webhookSecret,
          runtimeId: editing.runtimeId || null,
          capabilities,
          maxConcurrent: Math.floor(editing.maxConcurrent),
          templateMarkdown,
        });
        if (editing.createApiKey) {
          const scopes = keyScopes(editing.keyPreset);
          const key = await issueKey.mutateAsync({
            name: editing.keyName.trim() || `${agent.profileKey}:mcp`,
            scopes,
            expiresInDays: editing.keyExpiresInDays
              ? Number(editing.keyExpiresInDays)
              : undefined,
            linkedAgentId: agent.id,
          });
          setRevealKey({
            name: key.name,
            rawKey: key.rawKey,
            scopes,
            provider: toMcpProvider(editing.provider),
          });
        }
        toast.success("Agent created.");
      }
      setEditing(null);
      setWebhookTestResult(null);
      setStep(0);
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Agent save failed.");
    }
  }

  function runWebhookTest() {
    if (!editing) return;
    if (editing.connectionMode !== "webhook") {
      toast.error("Choose push webhook delivery first.");
      return;
    }
    if (!editing.webhookUrl.trim()) {
      toast.error("Webhook URL is required.");
      return;
    }
    setWebhookTestResult(null);
    testWebhook.mutate({
      id: editing.id,
      webhookUrl: editing.webhookUrl.trim(),
      webhookSecret: editing.webhookSecret.trim(),
      provider: editing.provider,
      runtimeMode: editing.runtimeMode,
      profileKey: PROFILE_KEY_RE.test(editing.profileKey) ? editing.profileKey : undefined,
    });
  }

  async function runMcpTest() {
    if (!revealKey) return;
    setMcpTest({ state: "pending", message: "Testing Forge MCP..." });
    try {
      const canCallIssues = revealKey.scopes.includes("READ_ISSUES");
      const res = await fetch(`${baseUrl}/api/mcp/rpc`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${revealKey.rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          canCallIssues
            ? {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "issues.list", arguments: { limit: 1 } },
              }
            : { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        ),
      });
      const json = await res.json();
      if (!res.ok || json.error || json.result?.isError) {
        throw new Error(json.error?.message ?? "MCP returned an error.");
      }
      setMcpTest({
        state: "ok",
        message: canCallIssues
          ? "MCP authenticated and completed a scoped tool call."
          : "MCP endpoint responded. This key has no READ_ISSUES scope to run a write-safe tool call.",
      });
    } catch (err) {
      setMcpTest({
        state: "error",
        message: err instanceof Error ? err.message : "MCP test failed.",
      });
    }
  }

  return (
    <>
      <Topbar
        title="Agents"
        subtitle="MCP-first actors that hold keys and receive work."
        actions={
          <Button variant="ember" size="sm" onClick={openNew}>
            New agent
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <FleetChecklist slug={ws.slug} />
          <Card>
            {rows.map((a) => {
              const isArchived = !!a.archivedAt;
              const assignedCount = a._count?.assignedIssues ?? 0;
              const provider = (a.provider ?? "HERMES") as AgentProviderId;
              const runtimeMode = (a.runtimeMode ?? "PERSISTENT") as RuntimeMode;
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-start gap-3 px-4 py-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-sm">
                    {a.avatar ? (
                      <span aria-hidden>{a.avatar}</span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {a.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{a.name}</span>
                      <span
                        className="text-id text-muted-foreground"
                        title="Profile key - stable cross-system handle."
                      >
                        @{a.profileKey}
                      </span>
                      <Badge>{PROVIDER_LABEL.get(provider) ?? provider}</Badge>
                      <Badge>{runtimeMode === "PERSISTENT" ? "persistent" : "single-session"}</Badge>
                      <span className="inline-flex items-center gap-1.5 rounded-sm bg-subtle px-1.5 py-0.5 text-[0.6875rem] font-medium">
                        <AgentPresenceDot
                          status={a.status}
                          size="sm"
                          pulse
                          lastHeartbeatAt={a.lastHeartbeatAt}
                        />
                        {a.status}
                      </span>
                      {isArchived && <Badge>archived</Badge>}
                    </div>
                    {a.description && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {a.description}
                      </div>
                    )}
                    <div
                      className="mt-2 flex flex-wrap items-center gap-1"
                      title="Capabilities are tags used by capability and priority matching."
                    >
                      {a.capabilities.map((c) => (
                        <Badge key={c}>{c}</Badge>
                      ))}
                      {a.capabilities.length === 0 && (
                        <span className="text-[0.6875rem] text-muted-foreground/70">
                          No capabilities declared.
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
                      <span>
                        {assignedCount} assigned issue{assignedCount === 1 ? "" : "s"}
                      </span>
                      <span>.</span>
                      <span>
                        {a.webhookUrl ? "push webhook configured" : "MCP-only"}
                      </span>
                      <span>.</span>
                      <span>
                        {a.lastHeartbeatAt
                          ? `heartbeat ${relativeTime(a.lastHeartbeatAt)}`
                          : "no heartbeat yet"}
                      </span>
                      {a.maxConcurrent !== 1 && (
                        <>
                          <span>.</span>
                          <span className="font-mono">max {a.maxConcurrent}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <AgentQuickActions
                      agentId={a.id}
                      profileKey={a.profileKey}
                      name={a.name}
                      status={a.status}
                    />
                    <Link href={`/w/${ws.slug}/agents/${a.profileKey}`}>
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing({
                          id: a.id,
                          name: a.name,
                          profileKey: a.profileKey,
                          description: a.description ?? "",
                          avatar: a.avatar ?? "",
                          provider,
                          runtimeMode,
                          connectionMode: a.webhookUrl ? "webhook" : "mcp",
                          webhookUrl: a.webhookUrl ?? "",
                          webhookSecret: a.webhookSecret ?? "",
                          runtimeId: a.runtime?.id ?? "",
                          capabilitiesRaw: a.capabilities.join(", "),
                          maxConcurrent: a.maxConcurrent,
                          runEngine: (a.runEngine ?? "DEFAULT") as EditingState["runEngine"],
                          templateMarkdown: a.templateMarkdown ?? "",
                          createApiKey: false,
                          keyPreset: "agent",
                          keyName: "",
                          keyExpiresInDays: "",
                        });
                        setWebhookTestResult(null);
                        setStep(0);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setArchiveTarget({
                          id: a.id,
                          name: a.name,
                          archived: isArchived,
                        })
                      }
                    >
                      {isArchived ? "Restore" : "Archive"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDeleteTarget({
                          id: a.id,
                          name: a.name,
                          profileKey: a.profileKey,
                          assigned: assignedCount,
                        })
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
            {!isLoading && rows.length === 0 && (
              <EmptyState
                icon={Bot}
                title="No agents yet"
                hint="Register an agent profile, then connect it with MCP, webhooks, or both."
                action={
                  <Button variant="ember" size="sm" onClick={openNew}>
                    Create your first agent
                  </Button>
                }
              />
            )}
          </Card>
        </div>
      </div>

      <CenterModal
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        size="xl"
        title={editing?.id ? "Edit agent" : "Agent onboarding"}
        description={
          editing?.id
            ? "Update provider metadata, connection mode, and dispatch behavior."
            : "Choose a runtime, register the Forge agent row, and optionally issue its linked MCP key."
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="text-[0.6875rem] text-muted-foreground">
              {editing?.provider === "HERMES"
                ? "Hermes supports persistent webhook dispatch plus MCP callbacks."
                : "Claude and Codex use single-session MCP today; persistent runners are tracked as roadmap."}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(null)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0 || pending}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Back
              </Button>
              {step < STEPS.length - 1 ? (
                <Button type="button" variant="ember" size="sm" onClick={nextStep}>
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ember"
                  size="sm"
                  onClick={submit}
                  disabled={pending}
                >
                  {editing?.id ? "Save agent" : "Create agent"}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {editing && (
          <div className="grid gap-5 lg:grid-cols-[190px_1fr]">
            <Stepper steps={STEPS} current={step} onSelect={setStep} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (step < STEPS.length - 1) nextStep();
                else void submit();
              }}
              className="min-w-0"
            >
              {step === 0 && (
                <div className="space-y-4">
                  <div className="grid gap-2 md:grid-cols-2">
                    {PROVIDERS.map((p) => {
                      const selected = editing.provider === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() =>
                            setEditing({
                              ...editing,
                              provider: p.id,
                              runtimeMode: p.defaultRuntimeMode,
                              connectionMode: p.defaultConnectionMode,
                            })
                          }
                          className={
                            "focus-ring min-h-32 rounded-lg border p-3 text-left transition-colors " +
                            (selected
                              ? "border-ember/50 bg-ember/10"
                              : "border-border bg-background/50 hover:bg-subtle/60")
                          }
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <p.Icon className="h-4 w-4 text-ember" />
                              <span className="text-sm font-medium">{p.label}</span>
                            </div>
                            <span className="rounded-sm border border-border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                              {p.eyebrow}
                            </span>
                          </div>
                          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                            {p.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid gap-2 md:grid-cols-2">
                    <RuntimeOption
                      selected={editing.runtimeMode === "EPHEMERAL"}
                      icon={Code2}
                      title="Single session"
                      hint="Best for Claude, Codex, and ad hoc custom clients. Presence comes from MCP heartbeat or active tool calls."
                      onClick={() => setEditing({ ...editing, runtimeMode: "EPHEMERAL" })}
                    />
                    <RuntimeOption
                      selected={editing.runtimeMode === "PERSISTENT"}
                      icon={ServerCog}
                      title="Persistent runtime"
                      hint={
                        editing.provider === "CLAUDE" || editing.provider === "CODEX"
                          ? "Roadmap for Claude and Codex. Use single-session until a daemon bridge exists."
                          : "Best for Hermes or a custom always-on bridge that can receive webhooks."
                      }
                      disabled={editing.provider === "CLAUDE" || editing.provider === "CODEX"}
                      onClick={() => setEditing({ ...editing, runtimeMode: "PERSISTENT" })}
                    />
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Name" required>
                    <Input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      maxLength={120}
                      placeholder="Victor"
                      autoFocus
                    />
                  </Field>
                  <Field
                    label="Profile key"
                    hint={
                      editing.id
                        ? "Cannot be changed after creation."
                        : "Lowercase letters, digits, `-` or `_`."
                    }
                    required
                  >
                    <Input
                      value={editing.profileKey}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          profileKey: e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]/g, ""),
                        })
                      }
                      maxLength={40}
                      placeholder="victor"
                      className="font-mono"
                      disabled={!!editing.id}
                    />
                  </Field>
                  <Field label="Avatar" hint="Short text or image URL shown in pickers.">
                    <Input
                      value={editing.avatar}
                      onChange={(e) => setEditing({ ...editing, avatar: e.target.value })}
                      maxLength={200}
                      placeholder="VX"
                    />
                  </Field>
                  <Field label="Description">
                    <textarea
                      value={editing.description}
                      onChange={(e) =>
                        setEditing({ ...editing, description: e.target.value })
                      }
                      maxLength={2000}
                      rows={5}
                      placeholder="Lead architect; triages incoming platform work."
                      className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                    />
                  </Field>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <Field
                    label="Managed runtime"
                    hint="Attach this agent to a managed runtime (e.g. a Hermes gateway) that hosts it. Profiles on the same daemon share one runtime. Leave unattached for a thin MCP/webhook connection. Manage runtimes under Settings → Runtimes."
                  >
                    <select
                      className="focus-ring h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm"
                      value={editing.runtimeId}
                      onChange={(e) => setEditing({ ...editing, runtimeId: e.target.value })}
                    >
                      <option value="">— None (unattached) —</option>
                      {(runtimes ?? [])
                        .filter(
                          (r) =>
                            r.providersAvailable.length === 0 ||
                            r.providersAvailable.includes(editing.provider) ||
                            r.id === editing.runtimeId,
                        )
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                  </Field>

                  {/* Resolved chat transport preview — shows the consequence of
                      the provider + runtime + engine choice before saving. */}
                  {transportPreview && (
                    <div
                      className={
                        "flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs " +
                        (transportPreview.ready
                          ? "border-border bg-background/50 text-muted-foreground"
                          : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300")
                      }
                    >
                      <span className="font-medium text-foreground">Chat served via</span>
                      <TransportChip
                        mode={transportPreview.mode}
                        label={transportPreview.transportLabel}
                        showNone
                      />
                      {!transportPreview.ready && (
                        <span className="w-full">
                          {transportPreview.hint}{" "}
                          <Link
                            href={`/w/${ws.slug}/settings/workspace`}
                            className="underline decoration-dotted hover:text-foreground"
                          >
                            Configure models
                          </Link>
                        </span>
                      )}
                    </div>
                  )}

                  <div className="grid gap-2 md:grid-cols-2">
                    <RuntimeOption
                      selected={editing.connectionMode === "mcp"}
                      icon={KeyRound}
                      title="MCP-only"
                      hint="The agent pulls work and updates Forge through a linked API key. No push delivery is required."
                      onClick={() => setEditing({ ...editing, connectionMode: "mcp" })}
                    />
                    <RuntimeOption
                      selected={editing.connectionMode === "webhook"}
                      icon={Webhook}
                      title="Push webhook + MCP"
                      hint="Forge posts assignment and mention events to the runtime. The agent still calls back over MCP."
                      onClick={() => setEditing({ ...editing, connectionMode: "webhook" })}
                    />
                  </div>

                  {editing.connectionMode === "webhook" ? (
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field
                        label="Webhook URL"
                        hint="Forge sends signed test and dispatch payloads here."
                        required
                      >
                        <Input
                          type="url"
                          value={editing.webhookUrl}
                          onChange={(e) =>
                            setEditing({ ...editing, webhookUrl: e.target.value })
                          }
                          maxLength={500}
                          placeholder="https://hermes.example.com/agents/forge"
                        />
                      </Field>
                      <Field
                        label="Webhook secret"
                        hint="Optional HMAC secret. If omitted, dispatch uses Forge's synthetic fallback."
                      >
                        <Input
                          value={editing.webhookSecret}
                          onChange={(e) =>
                            setEditing({ ...editing, webhookSecret: e.target.value })
                          }
                          maxLength={500}
                          placeholder="whsec_..."
                        />
                      </Field>
                      <div className="md:col-span-2 rounded-lg border border-border bg-background/50 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">Connection test</div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Sends a signed `AGENT_CONNECTION_TEST` payload. Some custom
                              adapters may need to allow that event kind.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={runWebhookTest}
                            disabled={testWebhook.isPending}
                          >
                            Test webhook
                          </Button>
                        </div>
                        {webhookTestResult && (
                          <div className="mt-3 text-xs text-muted-foreground">
                            {webhookTestResult.ok ? "Success" : "Failed"} - status{" "}
                            {webhookTestResult.status || "network"}
                            {webhookTestResult.responseBody && (
                              <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-subtle p-2 text-[0.6875rem]">
                                {webhookTestResult.responseBody}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-background/50 p-3 text-xs leading-relaxed text-muted-foreground">
                      MCP-only agents do not need a reachable webhook. Create a linked key
                      in the next step, add it to the provider, and have the agent call{" "}
                      <code className="font-mono">agents.heartbeat</code> when it starts.
                    </div>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Field
                    label="Capabilities"
                    hint="Comma-separated tags used by capability and priority matching."
                  >
                    <Input
                      value={editing.capabilitiesRaw}
                      onChange={(e) =>
                        setEditing({ ...editing, capabilitiesRaw: e.target.value })
                      }
                      placeholder="triage, architecture, code-review"
                    />
                  </Field>
                  <Field
                    label="Max concurrent"
                    hint="Upper bound on simultaneously assigned active issues. 0 means unlimited."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={editing.maxConcurrent}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          maxConcurrent: Number.parseInt(e.target.value || "0", 10),
                        })
                      }
                      className="w-28"
                    />
                  </Field>
                  <Field
                    label="Chat engine"
                    hint="How interactive chat replies are produced. Completions = Forge owns the loop (stateless, fast tokens). Hermes runs = the agent runs as itself with memory + its own tools (streams + structured events). Dispatch/assigned work always uses runs when supported."
                  >
                    <select
                      value={editing.runEngine}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          runEngine: e.target.value as EditingState["runEngine"],
                        })
                      }
                      className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                    >
                      <option value="DEFAULT">Integration default</option>
                      <option value="COMPLETIONS">Completions (Forge loop)</option>
                      <option value="RUNS">Hermes runs (agent-native)</option>
                    </select>
                  </Field>
                  <Field
                    label="Issue template"
                    hint="Markdown auto-applied to empty issue descriptions on assignment."
                  >
                    <textarea
                      value={editing.templateMarkdown}
                      onChange={(e) =>
                        setEditing({ ...editing, templateMarkdown: e.target.value })
                      }
                      rows={8}
                      placeholder={TEMPLATE_PLACEHOLDER}
                      className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
                    />
                  </Field>
                  <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
                    <label className="flex items-start gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={editing.createApiKey}
                        disabled={!isNew}
                        onChange={(e) =>
                          setEditing({ ...editing, createApiKey: e.target.checked })
                        }
                      />
                      <span>
                        Create linked MCP key
                        {!isNew && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            managed in Developer access
                          </span>
                        )}
                      </span>
                    </label>
                    {editing.createApiKey && isNew && (
                      <>
                        <Field label="Key name">
                          <Input
                            value={editing.keyName}
                            onChange={(e) =>
                              setEditing({ ...editing, keyName: e.target.value })
                            }
                            placeholder={`${editing.profileKey || "agent"}:mcp`}
                          />
                        </Field>
                        <div className="grid grid-cols-3 gap-1 rounded-md bg-subtle p-0.5">
                          {([
                            ["agent", "Agent"],
                            ["read", "Read"],
                            ["full", "Full"],
                          ] as const).map(([id, label]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setEditing({ ...editing, keyPreset: id })}
                              className={
                                "focus-ring rounded px-2 py-1 text-[0.6875rem] transition-colors " +
                                (editing.keyPreset === id
                                  ? "bg-background text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground")
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <Field label="Expires in days">
                          <Input
                            value={editing.keyExpiresInDays}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                keyExpiresInDays: e.target.value.replace(/[^0-9]/g, ""),
                              })
                            }
                            placeholder="blank for no expiry"
                          />
                        </Field>
                      </>
                    )}
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="grid gap-3 md:grid-cols-2">
                  <ReviewItem label="Provider" value={PROVIDER_LABEL.get(editing.provider) ?? editing.provider} />
                  <ReviewItem
                    label="Runtime"
                    value={editing.runtimeMode === "PERSISTENT" ? "Persistent" : "Single session"}
                  />
                  <ReviewItem label="Profile key" value={`@${editing.profileKey || "unset"}`} />
                  <ReviewItem
                    label="Connection"
                    value={editing.connectionMode === "webhook" ? "Webhook + MCP" : "MCP-only"}
                  />
                  <div className="rounded-lg border border-border bg-background/50 p-2.5">
                    <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                      Chat transport
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-foreground">
                      {transportPreview ? (
                        <>
                          <TransportChip
                            mode={transportPreview.mode}
                            label={transportPreview.transportLabel}
                            showNone
                          />
                          {!transportPreview.ready && (
                            <span className="text-[0.6875rem] text-amber-700 dark:text-amber-300">
                              {transportPreview.hint}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">resolving…</span>
                      )}
                    </div>
                  </div>
                  <ReviewItem
                    label="Capabilities"
                    value={parseCapabilities(editing.capabilitiesRaw).join(", ") || "none"}
                  />
                  <ReviewItem
                    label="MCP key"
                    value={
                      editing.createApiKey && isNew
                        ? `${editing.keyPreset} preset, linked to agent`
                        : "not created here"
                    }
                  />
                  {!isNew && editing.id && (
                    <div className="md:col-span-2 rounded-lg border border-border bg-background/50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">Verify connection</div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Resolves chat readiness and, for a managed runs runtime,
                            probes the endpoint (handshake only — no turn).
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={verify.isPending}
                          onClick={() => editing.id && verify.mutate({ id: editing.id })}
                        >
                          {verify.isPending ? "Verifying…" : "Verify connection"}
                        </Button>
                      </div>
                      {verifyResult && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={
                              verifyResult.ready
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-700 dark:text-amber-300"
                            }
                          >
                            {verifyResult.ready ? "Chat-ready" : "Not ready"} · {verifyResult.transportLabel}
                          </span>
                          {verifyResult.probe.attempted && (
                            <span className="text-muted-foreground">
                              · probe:{" "}
                              {verifyResult.probe.reachable
                                ? "reachable"
                                : "unreachable"}{" "}
                              ({verifyResult.probe.detail})
                            </span>
                          )}
                          {!verifyResult.ready && verifyResult.hint && (
                            <span className="w-full text-muted-foreground">{verifyResult.hint}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="md:col-span-2 rounded-lg border border-border bg-background/50 p-3 text-xs text-muted-foreground">
                    {editing.connectionMode === "webhook"
                      ? "The webhook test is optional; production dispatch health will appear on the agent detail page after real deliveries."
                      : "MCP-only agents can still be assigned work. They need to heartbeat or poll assigned issues from their session."}
                  </div>
                </div>
              )}

              <button type="submit" className="sr-only" aria-hidden>
                submit
              </button>
            </form>
          </div>
        )}
      </CenterModal>

      <CenterModal
        open={!!revealKey}
        onOpenChange={(open) => {
          if (!open) {
            setRevealKey(null);
            setMcpTest({ state: "idle", message: "" });
          }
        }}
        size="lg"
        title="MCP key created"
        description="This raw key is shown once. The blocks below are ready for the selected provider and can be switched if needed."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div
              className={
                "text-[0.6875rem] " +
                (mcpTest.state === "ok"
                  ? "text-ember"
                  : mcpTest.state === "error"
                    ? "text-danger"
                    : "text-muted-foreground")
              }
            >
              {mcpTest.message || "Optional: test the key against Forge MCP before closing."}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={runMcpTest}
                disabled={mcpTest.state === "pending"}
              >
                Test MCP
              </Button>
              <Button
                type="button"
                variant="ember"
                size="sm"
                onClick={() => {
                  setRevealKey(null);
                  setMcpTest({ state: "idle", message: "" });
                }}
              >
                Done
              </Button>
            </div>
          </div>
        }
      >
        {revealKey && (
          <div className="space-y-4">
            <CodeBlock label={`${revealKey.name} raw key`} code={revealKey.rawKey} />
            <McpIntegrationBlocks
              baseUrl={baseUrl}
              rawKey={revealKey.rawKey}
              preferredProvider={revealKey.provider}
            />
          </div>
        )}
      </CenterModal>

      <Confirm
        open={!!archiveTarget}
        onOpenChange={(v) => !v && setArchiveTarget(null)}
        title={
          archiveTarget?.archived
            ? `Restore ${archiveTarget.name}?`
            : `Archive ${archiveTarget?.name}?`
        }
        description={
          archiveTarget?.archived
            ? "The agent returns to the active list and can receive new work."
            : "The agent is hidden from pickers and marked offline. Assignments remain; restore later to resume."
        }
        primaryLabel={archiveTarget?.archived ? "Restore" : "Archive"}
        loading={archive.isPending || unarchive.isPending}
        onConfirm={async () => {
          if (!archiveTarget) return;
          if (archiveTarget.archived) {
            await unarchive.mutateAsync({ id: archiveTarget.id });
          } else {
            await archive.mutateAsync({ id: archiveTarget.id });
          }
          setArchiveTarget(null);
        }}
      />

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete agent "${deleteTarget?.name}"?`}
        description={
          deleteTarget && deleteTarget.assigned > 0
            ? `This agent is assigned to ${deleteTarget.assigned} issue${
                deleteTarget.assigned === 1 ? "" : "s"
              }. Those issues will lose their agent assignment. This cannot be undone - consider archiving instead.`
            : "Removes the agent profile, its keys, and any webhook registration. Cannot be undone."
        }
        primaryLabel="Delete"
        typeToConfirm={
          deleteTarget && deleteTarget.assigned > 0 ? deleteTarget.profileKey : undefined
        }
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync({ id: deleteTarget.id });
          setDeleteTarget(null);
        }}
      />
    </>
  );
}

function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: string[];
  current: number;
  onSelect: (step: number) => void;
}) {
  return (
    <ol className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s} className="shrink-0 lg:shrink">
            <button
              type="button"
              onClick={() => onSelect(i)}
              className={
                "focus-ring flex w-36 items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors lg:w-full " +
                (active
                  ? "bg-subtle text-foreground"
                  : "text-muted-foreground hover:bg-subtle/70 hover:text-foreground")
              }
            >
              {done ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-ember" />
              ) : (
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border text-[0.625rem]">
                  {i + 1}
                </span>
              )}
              <span className="truncate">{s}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function RuntimeOption({
  selected,
  disabled,
  icon: Icon,
  title,
  hint,
  onClick,
}: {
  selected: boolean;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        "focus-ring min-h-28 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 " +
        (selected
          ? "border-ember/50 bg-ember/10"
          : "border-border bg-background/50 hover:bg-subtle/60")
      }
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-ember" />
        {title}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </button>
  );
}

function ReviewItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        {required && <span className="text-ember">*</span>}
      </label>
      {children}
      {hint && <p className="text-[0.6875rem] text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
