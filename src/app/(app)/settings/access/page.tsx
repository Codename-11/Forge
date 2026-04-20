"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Key } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm, SidePanel } from "@/components/ui/modal";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
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

type Preset = "full" | "read" | "default" | "custom";

function setEq<T>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background/60">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <button
          type="button"
          className="focus-ring rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-subtle hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed text-foreground/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function AccessPage() {
  const { data: keys, refetch } = trpc.access.list.useQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<{
    name: string;
    prefix: string;
    rawKey: string;
    scopes: Scope[];
    context: "created" | "rotated";
  } | null>(null);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(FULL_ACCESS);
  const [preset, setPreset] = useState<Preset>("full");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
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
    // "custom" leaves scopes as-is
  }

  function toggleScope(s: Scope) {
    setScopes((curr) => {
      const next = curr.includes(s) ? curr.filter((x) => x !== s) : [...curr, s];
      // Auto-match preset if user's selection happens to equal one.
      if (setEq(next, FULL_ACCESS)) setPreset("full");
      else if (setEq(next, READ_ONLY)) setPreset("read");
      else if (setEq(next, DEFAULT_SCOPES)) setPreset("default");
      else setPreset("custom");
      return next;
    });
  }

  function openCreate() {
    setName("");
    setScopes(FULL_ACCESS);
    setPreset("full");
    setExpiresInDays("");
    setCreateOpen(true);
  }

  const create = trpc.access.create.useMutation({
    onSuccess: (k) => {
      setRevealKey({
        name: k.name,
        prefix: k.prefix,
        rawKey: k.rawKey,
        scopes: k.scopes as Scope[],
        context: "created",
      });
      setCreateOpen(false);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const revoke = trpc.access.revoke.useMutation({
    onSuccess: () => {
      toast.success("Key revoked.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.access.delete.useMutation({
    onSuccess: () => {
      toast.success("Key deleted.");
      refetch();
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
      });
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const activeKeys = keys ?? [];

  return (
    <>
      <Topbar
        title="Developer access"
        subtitle="API keys + MCP endpoint for external agents."
        actions={
          <Button variant="ember" size="sm" onClick={openCreate}>
            New API key
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <Intro baseUrl={baseUrl} />

          <Section
            title="API keys"
            hint="Raw keys are revealed once at creation or rotation. Store them in your agent's secret manager — Forge retains only a SHA-256 hash."
            actions={
              <span className="text-[11px] text-muted-foreground">
                {activeKeys.filter((k) => !k.revokedAt).length} active ·{" "}
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
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {k.prefix}…
                        </span>
                        {k.revokedAt && <Badge color="#be185d">revoked</Badge>}
                        {expired && <Badge color="#d97706">expired</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s}>{s}</Badge>
                        ))}
                      </div>
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        Created {relativeTime(k.createdAt)} ·{" "}
                        {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : "never used"}
                        {k.expiresAt && !k.revokedAt && (
                          <> · expires {relativeTime(k.expiresAt)}</>
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
                  hint="Create one to connect an external agent over MCP or HTTP."
                />
              )}
            </Card>
          </Section>
        </div>
      </div>

      <SidePanel
        open={createOpen}
        onOpenChange={setCreateOpen}
        size="wide"
        title="New API key"
        description="Scoped token for an external agent (MCP, webhooks, or bare HTTP)."
        primaryLabel={create.isPending ? "Creating…" : "Create key"}
        loading={create.isPending}
        onPrimary={() => {
          if (!name.trim()) {
            toast.error("Name is required.");
            return;
          }
          if (scopes.length === 0) {
            toast.error("Select at least one scope.");
            return;
          }
          const days = expiresInDays ? Number(expiresInDays) : undefined;
          create.mutate({ name: name.trim(), scopes, expiresInDays: days });
        }}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Desktop — Bailey"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Preset</label>
            <div className="flex gap-1 rounded-md bg-subtle p-0.5">
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
                    "focus-ring flex-1 rounded px-2 py-1 text-[11px] transition-colors " +
                    (preset === p.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {preset === "full" && "Every scope. Use for trusted single-user agents like Claude Desktop."}
              {preset === "default" && "Read + write issues and comments; no user/project writes."}
              {preset === "read" && "No writes anywhere — safe for dashboards or passive monitors."}
              {preset === "custom" && "Manually picked scopes."}
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
                      "focus-ring rounded-md border px-2 py-1 text-left font-mono text-[11px] " +
                      (on
                        ? "border-ember/50 bg-ember/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-border/80 hover:text-foreground")
                    }
                  >
                    {on ? "✓ " : "  "}
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Expires in (days, optional)</label>
            <Input
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="blank for no expiry"
            />
          </div>
        </div>
      </SidePanel>

      <Confirm
        open={!!rotateTarget}
        onOpenChange={(o) => !o && setRotateTarget(null)}
        title={rotateTarget ? `Rotate ${rotateTarget.name}?` : "Rotate key?"}
        description="The old key is revoked immediately — update your agent before closing the reveal."
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
        description="Removes the row entirely — use Revoke if you need to keep the audit trail."
        primaryLabel="Delete key"
        typeToConfirm={deleteTarget?.name}
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ id: deleteTarget.id });
          setDeleteTarget(null);
        }}
      />

      <Dialog open={!!revealKey} onClose={() => setRevealKey(null)} className="max-w-2xl">
        {revealKey && (
          <div className="space-y-4 p-5">
            <div>
              <div className="text-sm font-semibold">
                {revealKey.context === "rotated" ? "Key rotated" : "Key created"} — copy it now
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                This is the only time the raw key is displayed. Forge stores only a hash; if you
                lose it, rotate the key to issue a fresh one.
              </div>
            </div>
            <CodeBlock label={`${revealKey.name} · raw key`} code={revealKey.rawKey} />
            <IntegrationBlocks baseUrl={baseUrl} rawKey={revealKey.rawKey} />
            <div className="flex justify-end">
              <Button variant="ember" size="sm" onClick={() => setRevealKey(null)}>
                I saved it
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Intro({ baseUrl }: { baseUrl: string }) {
  return (
    <Section
      title="Connect an external agent"
      hint={
        <>
          Forge exposes a{" "}
          <a
            href={`${baseUrl}/api/mcp/describe`}
            target="_blank"
            rel="noreferrer"
            className="text-ember hover:underline"
          >
            Model Context Protocol
          </a>{" "}
          surface and a scoped REST API. Issue a key below, then paste the config into your agent
          runtime.
        </>
      }
    >
      <div className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card/40 p-3 text-[11px] text-muted-foreground sm:grid-cols-3">
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">MCP endpoint</div>
          <code className="text-[11px]">{baseUrl}/api/mcp/</code>
        </div>
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">Auth</div>
          Bearer token, <span className="font-mono">forge_sk_…</span>
        </div>
        <div className="rounded-md border border-border p-2">
          <div className="mb-1 font-semibold text-foreground">Describe tools</div>
          <code className="text-[11px]">GET /api/mcp/describe</code>
        </div>
      </div>
    </Section>
  );
}

function IntegrationBlocks({ baseUrl, rawKey }: { baseUrl: string; rawKey: string }) {
  const [tab, setTab] = useState<"claude-desktop" | "claude-code" | "hermes" | "curl" | "env">(
    "claude-desktop",
  );

  const rpcUrl = `${baseUrl}/api/mcp/rpc`;

  const claudeDesktop = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            forge: {
              command: "npx",
              args: ["-y", "mcp-remote", rpcUrl, "--header", `Authorization: Bearer ${rawKey}`],
            },
          },
        },
        null,
        2,
      ),
    [rpcUrl, rawKey],
  );

  const claudeCode = useMemo(
    () =>
      `claude mcp add --transport http forge ${rpcUrl} \\\n  --header "Authorization: Bearer ${rawKey}"`,
    [rpcUrl, rawKey],
  );

  const curl = useMemo(
    () =>
      `# MCP JSON-RPC (standard, works with any MCP client)\ncurl -sS ${rpcUrl} \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .\n\n# REST alias (simpler for curling one tool)\ncurl -sS ${baseUrl}/api/mcp/issues.list \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"limit": 10}' | jq .`,
    [baseUrl, rpcUrl, rawKey],
  );

  const env = useMemo(
    () =>
      `FORGE_URL=${baseUrl}\nFORGE_MCP_URL=${rpcUrl}\nFORGE_API_KEY=${rawKey}`,
    [baseUrl, rpcUrl, rawKey],
  );

  // Hermes native-MCP config (`~/.hermes/config.yaml` under `mcp_servers`).
  // The older `~/.openclaw/workspace/daemon/config/mcporter.json` entry is
  // legacy — OpenClaw is dormant; Hermes has a first-class MCP client now.
  const hermes = useMemo(
    () =>
      `mcp_servers:\n  forge:\n    url: "${rpcUrl}"\n    headers:\n      Authorization: "Bearer ${rawKey}"\n    timeout: 120\n    connect_timeout: 60\n`,
    [rpcUrl, rawKey],
  );

  const tabs = [
    { id: "claude-desktop" as const, label: "Claude Desktop" },
    { id: "claude-code" as const, label: "Claude Code" },
    { id: "hermes" as const, label: "Hermes" },
    { id: "curl" as const, label: "curl" },
    { id: "env" as const, label: ".env" },
  ];

  const code =
    tab === "claude-desktop"
      ? claudeDesktop
      : tab === "claude-code"
        ? claudeCode
        : tab === "hermes"
          ? hermes
          : tab === "curl"
            ? curl
            : env;

  const label =
    tab === "claude-desktop"
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : tab === "claude-code"
        ? "add Forge as an MCP server"
        : tab === "hermes"
          ? "~/.hermes/config.yaml — merge into mcp_servers (HTTP transport)"
          : tab === "curl"
            ? "HTTP — works from any runtime"
            : "environment variables";

  return (
    <div className="space-y-2">
      <div className="flex gap-1 rounded-md bg-subtle p-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "focus-ring flex-1 rounded px-2 py-1 text-[11px] transition-colors " +
              (tab === t.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock label={label} code={code} />
    </div>
  );
}
