"use client";
import { useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Key,
  PlugZap,
  ServerCog,
  Terminal,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CenterModal, Confirm } from "@/components/ui/modal";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import {
  CodeBlock,
  McpIntegrationBlocks,
  type McpOnboardingProvider,
} from "@/components/mcp-integration-blocks";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

const ALL_SCOPES = [
  "READ_ISSUES",
  "WRITE_ISSUES",
  "READ_PROJECTS",
  "WRITE_PROJECTS",
  "READ_COMMENTS",
  "WRITE_COMMENTS",
  "READ_USERS",
  "READ_ANALYTICS",
  "SUBSCRIBE_EVENTS",
  "INVOKE_SKILLS",
] as const;

type Scope = (typeof ALL_SCOPES)[number];
type Preset = "full" | "read" | "default" | "custom";

const READ_ONLY: Scope[] = [
  "READ_ISSUES",
  "READ_PROJECTS",
  "READ_COMMENTS",
  "READ_USERS",
  "READ_ANALYTICS",
];

const FULL_ACCESS: Scope[] = [...ALL_SCOPES];

const DEFAULT_SCOPES: Scope[] = [
  "READ_ISSUES",
  "WRITE_ISSUES",
  "READ_PROJECTS",
  "READ_COMMENTS",
  "WRITE_COMMENTS",
  "READ_ANALYTICS",
];

const STEPS = ["Provider", "Scopes", "Context", "Review"];

const PROVIDERS: Array<{
  id: McpOnboardingProvider;
  label: string;
  eyebrow: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
}> = [
  {
    id: "hermes",
    label: "Hermes",
    eyebrow: "first-class",
    description: "Persistent Forge agents with MCP callbacks and optional push dispatch.",
    Icon: ServerCog,
  },
  {
    id: "claude",
    label: "Claude",
    eyebrow: "desktop/code",
    description: "Claude Desktop or Claude Code connected to Forge over MCP.",
    Icon: Bot,
  },
  {
    id: "codex",
    label: "Codex",
    eyebrow: "CLI/IDE",
    description: "Codex CLI or IDE extension using streamable HTTP MCP config.",
    Icon: Terminal,
  },
  {
    id: "custom",
    label: "Custom",
    eyebrow: "generic MCP",
    description: "Any client that can send JSON-RPC or REST calls with a bearer key.",
    Icon: PlugZap,
  },
];

const PROVIDER_LABEL = new Map(PROVIDERS.map((p) => [p.id, p.label]));

function setEq<T>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

export default function AccessPage() {
  const { data: keys, refetch } = trpc.access.list.useQuery();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<McpOnboardingProvider>("hermes");
  const [revealKey, setRevealKey] = useState<{
    name: string;
    prefix: string;
    rawKey: string;
    scopes: Scope[];
    context: "created" | "rotated";
    provider: McpOnboardingProvider;
  } | null>(null);
  const [mcpTest, setMcpTest] = useState<{
    state: "idle" | "pending" | "ok" | "error";
    message: string;
  }>({ state: "idle", message: "" });

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(FULL_ACCESS);
  const [preset, setPreset] = useState<Preset>("full");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [linkedAgentId, setLinkedAgentId] = useState<string>("");
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL ?? "https://forge.axiom-labs.dev";

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === "full") setScopes(FULL_ACCESS);
    else if (p === "read") setScopes(READ_ONLY);
    else if (p === "default") setScopes(DEFAULT_SCOPES);
  }

  function toggleScope(s: Scope) {
    setScopes((curr) => {
      const next = curr.includes(s) ? curr.filter((x) => x !== s) : [...curr, s];
      if (setEq(next, FULL_ACCESS)) setPreset("full");
      else if (setEq(next, READ_ONLY)) setPreset("read");
      else if (setEq(next, DEFAULT_SCOPES)) setPreset("default");
      else setPreset("custom");
      return next;
    });
  }

  function openCreate() {
    setProvider("hermes");
    setName("");
    setScopes(FULL_ACCESS);
    setPreset("full");
    setExpiresInDays("");
    setLinkedAgentId("");
    setStep(0);
    setCreateOpen(true);
  }

  function validate(): string | null {
    if (!name.trim()) return "Name is required.";
    if (scopes.length === 0) return "Select at least one scope.";
    if (expiresInDays) {
      const days = Number(expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return "Expiry must be between 1 and 365 days.";
      }
    }
    return null;
  }

  function nextStep() {
    if (step === 1 && scopes.length === 0) {
      toast.error("Select at least one scope.");
      return;
    }
    if (step === 2 && !name.trim()) {
      toast.error("Name is required.");
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  const create = trpc.access.create.useMutation({
    onSuccess: (k) => {
      setRevealKey({
        name: k.name,
        prefix: k.prefix,
        rawKey: k.rawKey,
        scopes: k.scopes as Scope[],
        context: "created",
        provider,
      });
      setCreateOpen(false);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const revoke = trpc.access.revoke.useMutation({
    onSuccess: () => {
      toast.success("Key revoked.");
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.access.delete.useMutation({
    onSuccess: () => {
      toast.success("Key deleted.");
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const rotate = trpc.access.rotate.useMutation({
    onSuccess: (k) => {
      setRevealKey({
        name: k.name,
        prefix: k.prefix,
        rawKey: k.rawKey,
        scopes: k.scopes as Scope[],
        context: "rotated",
        provider: "custom",
      });
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const activeKeys = keys ?? [];

  async function submitCreate() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    create.mutate({
      name: name.trim(),
      scopes,
      expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
      linkedAgentId: linkedAgentId || undefined,
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
        title="Developer access"
        subtitle="API keys + MCP endpoint for external agents."
        actions={
          <Button variant="ember" size="sm" onClick={openCreate}>
            New MCP key
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Intro baseUrl={baseUrl} />

          <Section
            title="API keys"
            hint="Raw keys are revealed once at creation or rotation. Store them in your agent's secret manager; Forge retains only a SHA-256 hash."
            actions={
              <span className="text-[0.6875rem] text-muted-foreground">
                {activeKeys.filter((k) => !k.revokedAt).length} active .{" "}
                {activeKeys.filter((k) => k.revokedAt).length} revoked
              </span>
            }
          >
            <Card>
              {activeKeys.map((k) => {
                const expired =
                  !!k.expiresAt && !k.revokedAt && new Date(k.expiresAt) < new Date();
                return (
                  <li key={k.id} className="flex items-start gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{k.name}</span>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {k.prefix}...
                        </span>
                        {k.linkedAgent && (
                          <Badge>
                            {k.linkedAgent.name} . @{k.linkedAgent.profileKey}
                          </Badge>
                        )}
                        {k.revokedAt && <Badge>revoked</Badge>}
                        {expired && <Badge>expired</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s}>{s}</Badge>
                        ))}
                      </div>
                      <div className="mt-2 text-[0.6875rem] text-muted-foreground">
                        Created {relativeTime(k.createdAt)} .{" "}
                        {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : "never used"}
                        {k.expiresAt && !k.revokedAt && (
                          <> . expires {relativeTime(k.expiresAt)}</>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      {!k.revokedAt && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rotate.isPending}
                            onClick={() => setRotateTarget({ id: k.id, name: k.name })}
                          >
                            Rotate
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokeTarget({ id: k.id, name: k.name })}
                          >
                            Revoke
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget({ id: k.id, name: k.name })}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
              {activeKeys.length === 0 && (
                <EmptyState
                  icon={Key}
                  title="No API keys yet"
                  hint="Create one to connect Hermes, Claude, Codex, or another external agent over MCP."
                />
              )}
            </Card>
          </Section>
        </div>
      </div>

      <CenterModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        size="xl"
        title="MCP key onboarding"
        description="Select the agent runtime, choose scopes, and copy a provider-specific config after the key is created."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="text-[0.6875rem] text-muted-foreground">
              {PROVIDER_LABEL.get(provider)} config will be shown after creation.
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreateOpen(false)}
                disabled={create.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0 || create.isPending}
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
                  onClick={submitCreate}
                  disabled={create.isPending}
                >
                  Create key
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[190px_1fr]">
          <Stepper steps={STEPS} current={step} onSelect={setStep} />
          <div className="min-w-0">
            {step === 0 && (
              <div className="grid gap-2 md:grid-cols-2">
                {PROVIDERS.map((p) => {
                  const selected = provider === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProvider(p.id);
                        if (!name.trim()) setName(`${p.label} Forge MCP`);
                      }}
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
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Preset</label>
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-subtle p-0.5 md:grid-cols-4">
                    {([
                      { id: "full", label: "Full access" },
                      { id: "default", label: "Standard" },
                      { id: "read", label: "Read-only" },
                      { id: "custom", label: "Custom" },
                    ] as { id: Preset; label: string }[]).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p.id)}
                        className={
                          "focus-ring rounded px-2 py-1 text-[0.6875rem] transition-colors " +
                          (preset === p.id
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground")
                        }
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    {preset === "full" && "Every scope. Use only for trusted local or single-user agents."}
                    {preset === "default" && "Read + write issues and comments; no user or project writes."}
                    {preset === "read" && "Read-only access for passive monitors or dashboards."}
                    {preset === "custom" && "Manually selected scopes."}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Scopes ({scopes.length})</label>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    {ALL_SCOPES.map((s) => {
                      const on = scopes.includes(s);
                      return (
                        <button
                          type="button"
                          key={s}
                          onClick={() => toggleScope(s)}
                          className={
                            "focus-ring rounded-md border px-2 py-1 text-left font-mono text-[0.6875rem] " +
                            (on
                              ? "border-ember/50 bg-ember/10 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:border-border/80 hover:text-foreground")
                          }
                        >
                          {on ? "+ " : "  "}
                          {s}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={`${PROVIDER_LABEL.get(provider)} Forge MCP`}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Expires in days</label>
                  <Input
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="blank for no expiry"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <label className="text-xs text-muted-foreground">Link to agent</label>
                  <select
                    className="focus-ring w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    value={linkedAgentId}
                    onChange={(e) => setLinkedAgentId(e.target.value)}
                  >
                    <option value="">No linked agent</option>
                    {(agents ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} . @{a.profileKey}
                      </option>
                    ))}
                  </select>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Linked keys let MCP tools such as{" "}
                    <code className="font-mono">issues.assigned</code> infer the agent
                    without a <code className="font-mono">profileKey</code> argument.
                  </p>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-3 md:grid-cols-2">
                <ReviewItem label="Provider" value={PROVIDER_LABEL.get(provider)} />
                <ReviewItem label="Name" value={name || "unset"} />
                <ReviewItem label="Scopes" value={`${scopes.length} selected`} />
                <ReviewItem
                  label="Agent link"
                  value={
                    linkedAgentId
                      ? agents?.find((a) => a.id === linkedAgentId)?.profileKey ?? "selected"
                      : "none"
                  }
                />
                <div className="md:col-span-2 rounded-lg border border-border bg-background/50 p-3 text-xs leading-relaxed text-muted-foreground">
                  After creation, Forge will show the raw key once with Hermes, Claude,
                  Codex, HTTP, and environment config blocks. You can run a same-origin
                  MCP test before closing the reveal modal.
                </div>
              </div>
            )}
          </div>
        </div>
      </CenterModal>

      <Confirm
        open={!!rotateTarget}
        onOpenChange={(o) => !o && setRotateTarget(null)}
        title={rotateTarget ? `Rotate ${rotateTarget.name}?` : "Rotate key?"}
        description="The old key is revoked immediately. Update your agent before closing the reveal."
        primaryLabel="Rotate"
        loading={rotate.isPending}
        onConfirm={() => {
          if (rotateTarget) rotate.mutate({ id: rotateTarget.id });
          setRotateTarget(null);
        }}
      />

      <Confirm
        open={!!revokeTarget}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        variant="destructive"
        title={revokeTarget ? `Revoke ${revokeTarget.name}?` : "Revoke key?"}
        description="Disables the key immediately. The row is retained for audit."
        primaryLabel="Revoke"
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate({ id: revokeTarget.id });
          setRevokeTarget(null);
        }}
      />

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        variant="destructive"
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete key?"}
        description="Removes the row entirely. Use Revoke if you need to keep the audit trail."
        primaryLabel="Delete key"
        typeToConfirm={deleteTarget?.name}
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ id: deleteTarget.id });
          setDeleteTarget(null);
        }}
      />

      <CenterModal
        open={!!revealKey}
        onOpenChange={(open) => {
          if (!open) {
            setRevealKey(null);
            setMcpTest({ state: "idle", message: "" });
          }
        }}
        size="lg"
        title={revealKey?.context === "rotated" ? "Key rotated" : "Key created"}
        description="Copy the raw key now. Forge stores only a hash, so this value cannot be shown again."
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
    </>
  );
}

function Intro({ baseUrl }: { baseUrl: string }) {
  return (
    <Section
      title="Connect an external agent"
      hint="Forge exposes a Model Context Protocol surface and scoped REST aliases. Issue a key below, then paste the provider-specific config into the runtime."
    >
      <div className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card/40 p-3 text-[0.6875rem] text-muted-foreground sm:grid-cols-3">
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">MCP endpoint</div>
          <code className="text-[0.6875rem]">{baseUrl}/api/mcp/rpc</code>
        </div>
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">Providers</div>
          Hermes, Claude, Codex, custom
        </div>
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">Auth</div>
          Bearer token, <span className="font-mono">forge_sk_...</span>
        </div>
      </div>
    </Section>
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

function ReviewItem({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}
