"use client";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  PlugZap,
  ServerCog,
  Terminal,
  User,
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
import { useMaybeWorkspace } from "@/hooks/use-workspace";
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

function isMcpProvider(value: string | null): value is McpOnboardingProvider {
  return PROVIDERS.some((p) => p.id === value);
}

function setEq<T>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

/** Format an expiry as "expires in Xh" / "expires in Xd" / "expired". */
function formatExpiry(expiresAt: Date | string | null | undefined): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `expires in ${days}d`;
}

type RevealKeyState = {
  name: string;
  prefix: string;
  rawKey: string;
  scopes: Scope[];
  context: "created" | "rotated";
  provider: McpOnboardingProvider;
  linkedAgentId?: string | null;
  createdAt?: Date | string | null;
  expiresAt?: Date | string | null;
};

export default function AccessPage() {
  const workspace = useMaybeWorkspace();
  const clientsHref = workspace ? `/w/${workspace.slug}/settings/clients` : "/settings/clients";
  const searchParams = useSearchParams();
  const handledDeepLinkRef = useRef<string | null>(null);
  const { data: keys, refetch } = trpc.access.list.useQuery();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });

  // ── Agent key create flow (existing wizard) ──────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<McpOnboardingProvider>("hermes");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(FULL_ACCESS);
  const [preset, setPreset] = useState<Preset>("full");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [linkedAgentId, setLinkedAgentId] = useState<string>("");

  // ── Personal token create flow ────────────────────────────────────────────
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalName, setPersonalName] = useState("");
  const [personalScopes, setPersonalScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [personalPreset, setPersonalPreset] = useState<Preset>("default");
  const [personalExpiresInDays, setPersonalExpiresInDays] = useState<string>("");

  // ── Session key create flow ───────────────────────────────────────────────
  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [sessionScopes, setSessionScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [sessionPreset, setSessionPreset] = useState<Preset>("default");
  const [sessionTtlHours, setSessionTtlHours] = useState<string>("24");

  // ── Shared reveal / confirm states ────────────────────────────────────────
  const [revealKey, setRevealKey] = useState<RevealKeyState | null>(null);
  const [savedAck, setSavedAck] = useState(false);
  const [mcpTest, setMcpTest] = useState<{
    state: "idle" | "pending" | "ok" | "error";
    message: string;
  }>({ state: "idle", message: "" });

  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL ?? "https://forge.axiom-labs.dev";

  // ── Scope helpers ─────────────────────────────────────────────────────────
  function applyPreset(p: Preset, setter: (s: Scope[]) => void, presetSetter: (p: Preset) => void) {
    presetSetter(p);
    if (p === "full") setter(FULL_ACCESS);
    else if (p === "read") setter(READ_ONLY);
    else if (p === "default") setter(DEFAULT_SCOPES);
  }

  function toggleScope(s: Scope, curr: Scope[], setter: (scopes: Scope[]) => void, presetSetter: (p: Preset) => void) {
    const next = curr.includes(s) ? curr.filter((x) => x !== s) : [...curr, s];
    if (setEq(next, FULL_ACCESS)) presetSetter("full");
    else if (setEq(next, READ_ONLY)) presetSetter("read");
    else if (setEq(next, DEFAULT_SCOPES)) presetSetter("default");
    else presetSetter("custom");
    setter(next);
  }

  // ── Agent key flow ────────────────────────────────────────────────────────
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

  function validateAgent(): string | null {
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
        linkedAgentId: k.linkedAgentId,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
      });
      setCreateOpen(false);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  async function submitCreate() {
    const err = validateAgent();
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

  // ── Personal token flow ───────────────────────────────────────────────────
  function openPersonal() {
    setPersonalName("");
    setPersonalScopes(DEFAULT_SCOPES);
    setPersonalPreset("default");
    setPersonalExpiresInDays("");
    setPersonalOpen(true);
  }

  const createPersonal = trpc.access.createPersonal.useMutation({
    onSuccess: (k) => {
      setRevealKey({
        name: k.name,
        prefix: k.prefix,
        rawKey: k.rawKey,
        scopes: k.scopes as Scope[],
        context: "created",
        provider: "custom",
        linkedAgentId: k.linkedAgentId,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
      });
      setPersonalOpen(false);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function submitPersonal() {
    if (!personalName.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (personalScopes.length === 0) {
      toast.error("Select at least one scope.");
      return;
    }
    if (personalExpiresInDays) {
      const days = Number(personalExpiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        toast.error("Expiry must be between 1 and 365 days.");
        return;
      }
    }
    createPersonal.mutate({
      name: personalName.trim(),
      scopes: personalScopes,
      expiresInDays: personalExpiresInDays ? Number(personalExpiresInDays) : undefined,
    });
  }

  // ── Session key flow ──────────────────────────────────────────────────────
  function openSession() {
    setSessionName("");
    setSessionScopes(DEFAULT_SCOPES);
    setSessionPreset("default");
    setSessionTtlHours("24");
    setSessionOpen(true);
  }

  useEffect(() => {
    const target = searchParams.get("create");
    const providerParam = searchParams.get("provider");
    const signature = `${target ?? ""}:${providerParam ?? ""}`;
    if (!target || handledDeepLinkRef.current === signature) return;
    handledDeepLinkRef.current = signature;

    if (target === "session") {
      setSessionName("");
      setSessionScopes(DEFAULT_SCOPES);
      setSessionPreset("default");
      setSessionTtlHours("24");
      setSessionOpen(true);
      return;
    }

    if (target === "personal") {
      setPersonalName("");
      setPersonalScopes(DEFAULT_SCOPES);
      setPersonalPreset("default");
      setPersonalExpiresInDays("");
      setPersonalOpen(true);
      return;
    }

    if (target === "agent") {
      const nextProvider = isMcpProvider(providerParam) ? providerParam : "hermes";
      setProvider(nextProvider);
      setName(`${PROVIDER_LABEL.get(nextProvider) ?? "Agent"} Forge MCP`);
      setScopes(FULL_ACCESS);
      setPreset("full");
      setExpiresInDays("");
      setLinkedAgentId("");
      setStep(0);
      setCreateOpen(true);
    }
  }, [searchParams]);

  const createSession = trpc.access.createSession.useMutation({
    onSuccess: (k) => {
      setRevealKey({
        name: k.name,
        prefix: k.prefix,
        rawKey: k.rawKey,
        scopes: k.scopes as Scope[],
        context: "created",
        provider: "custom",
        linkedAgentId: k.linkedAgentId,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
      });
      setSessionOpen(false);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function submitSession() {
    if (!sessionName.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (sessionScopes.length === 0) {
      toast.error("Select at least one scope.");
      return;
    }
    const ttl = Number(sessionTtlHours);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 168) {
      toast.error("TTL must be between 1 and 168 hours.");
      return;
    }
    createSession.mutate({
      name: sessionName.trim(),
      scopes: sessionScopes,
      ttlHours: ttl,
    });
  }

  // ── Shared mutations ──────────────────────────────────────────────────────
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
        linkedAgentId: k.linkedAgentId,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
      });
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Derived data ──────────────────────────────────────────────────────────
  const allKeys = keys ?? [];
  const agentKeys = allKeys.filter((k) => k.kind === "AGENT");
  const personalKeys = allKeys.filter((k) => k.kind === "PERSONAL");
  const sessionKeys = allKeys.filter((k) => k.kind === "SESSION");

  // ── MCP test ──────────────────────────────────────────────────────────────
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
        subtitle={workspace ? `${workspace.name} · workspace API keys and MCP access` : "API keys + MCP endpoint for the current workspace."}
        actions={
          <Button variant="ember" size="sm" onClick={openCreate}>
            Register agent
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Intro baseUrl={baseUrl} clientsHref={clientsHref} />

          {/* ── Registered Agents ── */}
          <Section
            title="Registered Agents"
            hint="Agent keys are tied to a persistent registered agent. Full scopes, linked via the agent registry. Use the wizard to generate a provider-specific MCP config."
            actions={
              <div className="flex items-center gap-3">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {agentKeys.filter((k) => !k.revokedAt).length} active
                </span>
                <Button variant="outline" size="sm" onClick={openCreate}>
                  Register agent
                </Button>
              </div>
            }
          >
            <Card>
              {agentKeys.map((k) => {
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
                    <KeyActions
                      k={k}
                      rotatePending={rotate.isPending}
                      revokePending={revoke.isPending}
                      onRotate={() => setRotateTarget({ id: k.id, name: k.name })}
                      onRevoke={() => setRevokeTarget({ id: k.id, name: k.name })}
                      onDelete={() => setDeleteTarget({ id: k.id, name: k.name })}
                      showRotate
                    />
                  </li>
                );
              })}
              {agentKeys.length === 0 && (
                <EmptyState
                  icon={Bot}
                  title="No registered agents"
                  hint="Register an agent key to connect Hermes, Claude, Codex, or another persistent agent over MCP."
                />
              )}
            </Card>
          </Section>

          {/* ── Personal Access Tokens ── */}
          <Section
            title="Personal Access Tokens"
            hint="Personal access tokens give you read-only or scoped MCP access without registering a full agent. Use them for local Claude Code sessions, scripts, or one-off integrations."
            actions={
              <div className="flex items-center gap-3">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {personalKeys.filter((k) => !k.revokedAt).length} active
                </span>
                <Button variant="outline" size="sm" onClick={openPersonal}>
                  Create personal token
                </Button>
              </div>
            }
          >
            <Card>
              {personalKeys.map((k) => {
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
                        {k.revokedAt && <Badge>revoked</Badge>}
                        {expired && <Badge>expired</Badge>}
                        {k.projectIds.length > 0 && (
                          <Badge>{k.projectIds.length} project{k.projectIds.length !== 1 ? "s" : ""}</Badge>
                        )}
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
                    <KeyActions
                      k={k}
                      rotatePending={rotate.isPending}
                      revokePending={revoke.isPending}
                      onRotate={() => setRotateTarget({ id: k.id, name: k.name })}
                      onRevoke={() => setRevokeTarget({ id: k.id, name: k.name })}
                      onDelete={() => setDeleteTarget({ id: k.id, name: k.name })}
                      showRotate
                    />
                  </li>
                );
              })}
              {personalKeys.length === 0 && (
                <EmptyState
                  icon={User}
                  title="No personal tokens"
                  hint="Personal access tokens give you read-only or scoped MCP access without registering a full agent."
                />
              )}
            </Card>
          </Section>

          {/* ── Session Keys ── */}
          <Section
            title="Session Keys"
            hint="Session keys auto-expire — perfect for ephemeral sessions or one-off tasks. They're revoked automatically when they expire."
            actions={
              <div className="flex items-center gap-3">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {sessionKeys.filter((k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date())).length} active
                </span>
                <Button variant="outline" size="sm" onClick={openSession}>
                  Generate session key
                </Button>
              </div>
            }
          >
            <Card>
              {sessionKeys.map((k) => {
                const isExpired =
                  !!k.expiresAt && new Date(k.expiresAt) < new Date();
                const expiryLabel = formatExpiry(k.expiresAt);
                return (
                  <li key={k.id} className="flex items-start gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{k.name}</span>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                          {k.prefix}...
                        </span>
                        {k.revokedAt && <Badge>revoked</Badge>}
                        {isExpired && !k.revokedAt && (
                          <Badge>expired</Badge>
                        )}
                        {!isExpired && !k.revokedAt && expiryLabel && (
                          <Badge>
                            <Clock className="mr-1 h-2.5 w-2.5" />
                            {expiryLabel}
                          </Badge>
                        )}
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
                          <> . {isExpired ? "expired" : "expires"} {relativeTime(k.expiresAt)}</>
                        )}
                      </div>
                    </div>
                    {/* Session keys: no rotate (TTL-bounded by design) */}
                    <KeyActions
                      k={k}
                      rotatePending={rotate.isPending}
                      revokePending={revoke.isPending}
                      onRotate={() => setRotateTarget({ id: k.id, name: k.name })}
                      onRevoke={() => setRevokeTarget({ id: k.id, name: k.name })}
                      onDelete={() => setDeleteTarget({ id: k.id, name: k.name })}
                      showRotate={false}
                    />
                  </li>
                );
              })}
              {sessionKeys.length === 0 && (
                <EmptyState
                  icon={Clock}
                  title="No session keys"
                  hint="Session keys auto-expire — perfect for ephemeral sessions or one-off tasks."
                />
              )}
            </Card>
          </Section>
        </div>
      </div>

      {/* ── Agent key wizard (existing) ── */}
      <CenterModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        size="xl"
        title="Register agent key"
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
              <ScopeSelector
                scopes={scopes}
                preset={preset}
                onApplyPreset={(p) => applyPreset(p, setScopes, setPreset)}
                onToggleScope={(s) => toggleScope(s, scopes, setScopes, setPreset)}
              />
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

      {/* ── Personal token modal ── */}
      <CenterModal
        open={personalOpen}
        onOpenChange={setPersonalOpen}
        size="lg"
        title="Create personal access token"
        description="Personal tokens give you scoped MCP access without registering a full agent. Raw key shown once."
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPersonalOpen(false)}
              disabled={createPersonal.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ember"
              size="sm"
              onClick={submitPersonal}
              disabled={createPersonal.isPending}
            >
              Create token
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={personalName}
                onChange={(e) => setPersonalName(e.target.value)}
                placeholder="My Claude Code token"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Expires in days (optional)</label>
              <Input
                value={personalExpiresInDays}
                onChange={(e) => setPersonalExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="blank for no expiry"
              />
            </div>
          </div>
          <ScopeSelector
            scopes={personalScopes}
            preset={personalPreset}
            onApplyPreset={(p) => applyPreset(p, setPersonalScopes, setPersonalPreset)}
            onToggleScope={(s) => toggleScope(s, personalScopes, setPersonalScopes, setPersonalPreset)}
          />
        </div>
      </CenterModal>

      {/* ── Session key modal ── */}
      <CenterModal
        open={sessionOpen}
        onOpenChange={setSessionOpen}
        size="lg"
        title="Generate session key"
        description="Session keys auto-expire. Use them for ephemeral tasks — they cannot be rotated."
        footer={
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSessionOpen(false)}
              disabled={createSession.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ember"
              size="sm"
              onClick={submitSession}
              disabled={createSession.isPending}
            >
              Generate key
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Ephemeral session"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">TTL (hours, 1–168)</label>
              <Input
                value={sessionTtlHours}
                onChange={(e) => setSessionTtlHours(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="24"
              />
              <p className="text-[0.6875rem] text-muted-foreground">
                Key becomes invalid after this window. Default 24h.
              </p>
            </div>
          </div>
          <ScopeSelector
            scopes={sessionScopes}
            preset={sessionPreset}
            onApplyPreset={(p) => applyPreset(p, setSessionScopes, setSessionPreset)}
            onToggleScope={(s) => toggleScope(s, sessionScopes, setSessionScopes, setSessionPreset)}
          />
        </div>
      </CenterModal>

      {/* ── Confirm dialogs ── */}
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

      {/* ── Reveal modal ── */}
      <CenterModal
        open={!!revealKey}
        onOpenChange={(open) => {
          if (!open) {
            setRevealKey(null);
            setMcpTest({ state: "idle", message: "" });
            setSavedAck(false);
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
                disabled={!savedAck}
                onClick={() => {
                  setRevealKey(null);
                  setMcpTest({ state: "idle", message: "" });
                  setSavedAck(false);
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

            {/* Recap of what was just issued, so the operator can confirm
                scope/binding before they store the secret. */}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-background/50 p-3 text-xs">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium text-foreground">{revealKey.name}</dd>

              <dt className="text-muted-foreground">Bound to</dt>
              <dd>
                {revealKey.linkedAgentId ? (
                  <span className="font-mono text-foreground">
                    @
                    {agents?.find((a) => a.id === revealKey.linkedAgentId)
                      ?.profileKey ?? "agent"}
                  </span>
                ) : (
                  <span className="text-muted-foreground">No linked agent</span>
                )}
              </dd>

              <dt className="text-muted-foreground">Scopes</dt>
              <dd className="flex flex-wrap gap-1">
                {revealKey.scopes.length > 0 ? (
                  revealKey.scopes.map((s) => <Badge key={s}>{s}</Badge>)
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
              </dd>

              <dt className="text-muted-foreground">Expires</dt>
              <dd className="text-foreground">
                {revealKey.expiresAt
                  ? new Date(revealKey.expiresAt).toLocaleString()
                  : "Never"}
              </dd>

              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-foreground">
                {revealKey.createdAt
                  ? new Date(revealKey.createdAt).toLocaleString()
                  : "just now"}
              </dd>
            </dl>

            <McpIntegrationBlocks
              baseUrl={baseUrl}
              rawKey={revealKey.rawKey}
              preferredProvider={revealKey.provider}
            />

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              I&apos;ve saved the key somewhere secure.
            </label>
          </div>
        )}
      </CenterModal>
    </>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────

function KeyActions({
  k,
  rotatePending,
  revokePending,
  onRotate,
  onRevoke,
  onDelete,
  showRotate,
}: {
  k: { revokedAt: Date | null | string | undefined };
  rotatePending: boolean;
  revokePending: boolean;
  onRotate: () => void;
  onRevoke: () => void;
  onDelete: () => void;
  showRotate: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {!k.revokedAt && (
        <>
          {showRotate && (
            <Button
              variant="outline"
              size="sm"
              disabled={rotatePending}
              onClick={onRotate}
            >
              Rotate
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={revokePending}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

function ScopeSelector({
  scopes,
  preset,
  onApplyPreset,
  onToggleScope,
}: {
  scopes: Scope[];
  preset: Preset;
  onApplyPreset: (p: Preset) => void;
  onToggleScope: (s: Scope) => void;
}) {
  return (
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
              onClick={() => onApplyPreset(p.id)}
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
                onClick={() => onToggleScope(s)}
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
  );
}

function Intro({ baseUrl, clientsHref }: { baseUrl: string; clientsHref: string }) {
  return (
    <Section
      title="Connect an external agent"
      hint="Forge exposes a Model Context Protocol surface and scoped REST aliases. Issue a key below, then paste the provider-specific config into the client."
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
      <div className="mt-2 rounded-md border border-ember/30 bg-ember/5 px-3 py-2 text-meta text-muted-foreground">
        Use this page to issue or rotate secrets. Use{" "}
        <Link
          href={clientsHref}
          className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
        >
          Agent Clients
        </Link>{" "}
        to see active client rows, status, and revocation actions.
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
