"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { Topbar } from "@/components/topbar";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import {
  Server,
  Terminal,
  MonitorPlay,
  Code2,
  Webhook,
  Mail,
  KeyRound,
  Copy,
  RefreshCw,
  Activity,
  CircleDot,
  CircleSlash,
} from "lucide-react";

const ICONS = { Server, Terminal, MonitorPlay, Code2, Webhook } as const;

export default function IntegrationsPage() {
  const ws = useWorkspace();
  const { data: adapters, isLoading } = trpc.integration.list.useQuery();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        title="Integrations"
        subtitle="Runtime adapters — connect agents and tools to Forge."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {isLoading && (
            <div className="rounded-md border border-border bg-card/40 p-4 text-meta text-muted-foreground">
              Loading integrations…
            </div>
          )}
          {(adapters ?? []).map((a) => {
            const Icon = ICONS[a.iconKey as keyof typeof ICONS] ?? Webhook;
            return (
              <Card key={`${a.kind}-${a.presence}`} as="div">
                <div className="flex items-start gap-3 p-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-subtle/40 text-foreground/80">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{a.title}</h3>
                      <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                        {a.defaultRuntimeMode === "PERSISTENT" ? "persistent" : "session"}
                      </span>
                      {a.agents.length > 0 && (
                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700">
                          installed · {a.agents.length}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[0.8125rem] text-muted-foreground">{a.tagline}</p>
                    {a.agents.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {a.agents.map((ag) => (
                          <Link
                            key={ag.id}
                            href={`/w/${ws.slug}/agents/${ag.profileKey}`}
                            className="rounded-md border border-border bg-card/40 px-2 py-0.5 font-mono text-[0.625rem] text-foreground/80 hover:border-ember/40"
                          >
                            @{ag.profileKey}
                          </Link>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <Link
                        href={`/w/${ws.slug}/settings/access?kind=${a.defaultKeyKind}`}
                        className="rounded-md border border-border bg-card/40 px-2.5 py-1 text-[0.75rem] text-foreground hover:border-ember/40"
                      >
                        {a.agents.length > 0 ? "Manage keys" : "Generate key"}
                      </Link>
                      <Link
                        href={`/w/${ws.slug}/settings/integrations/deliveries`}
                        className="text-[0.75rem] text-muted-foreground hover:text-foreground"
                      >
                        Deliveries →
                      </Link>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          <RuntimeHealthSection />
          <EmailIngestSection />
        </div>
      </div>
    </div>
  );
}

/**
 * Live runtime presence. One row per `Runtime` registered in this
 * workspace. The badge maps heartbeat-age to live / idle / offline:
 *   - live   : last heartbeat within 90s
 *   - idle   : within 5 min
 *   - offline: older than 5 min, or null heartbeatAt
 * The thresholds align with the Hermes presence cron (1 min) and the
 * forge daemon (60s) — a single missed tick should not flip to offline.
 */
function RuntimeHealthSection() {
  const ws = useWorkspace();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";

  const { data: runtimes, isLoading } = trpc.runtime.list.useQuery(
    { includeArchived: false },
    {
      enabled: isAdmin,
      // Auto-refresh every 30s so the page reflects current presence.
      refetchInterval: 30_000,
    },
  );

  if (!isAdmin) return null;

  const rows = runtimes ?? [];

  return (
    <Card as="div">
      <div className="flex items-start gap-3 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-subtle/40 text-foreground/80">
          <Activity className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Runtime presence
            </h3>
            <p className="mt-1 text-[0.8125rem] text-muted-foreground">
              Live status of each registered runtime — Hermes daemons,
              local `forge daemon` instances, and any future cloud
              workers. Heartbeats are bumped every 60s; rows older than
              5 minutes flip to offline.
            </p>
          </div>
          {isLoading && (
            <div className="rounded-md border border-border bg-background/40 p-3 text-meta text-muted-foreground">
              Loading…
            </div>
          )}
          {!isLoading && rows.length === 0 && (
            <div className="rounded-md border border-border bg-background/40 p-3 text-meta text-muted-foreground">
              No runtimes registered yet. Run{" "}
              <code className="font-mono">forge daemon start</code> on a
              host, or set up a Hermes adapter that calls{" "}
              <code className="font-mono">runtimes.register</code>.
            </div>
          )}
          {rows.length > 0 && (
            <div className="space-y-1.5">
              {rows.map((r) => (
                <RuntimeRow key={r.id} runtime={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

interface RuntimeListRow {
  id: string;
  name: string;
  kind: string;
  heartbeatAt: Date | string | null;
  providersAvailable: string[];
  _count?: { agents: number };
}

function RuntimeRow({ runtime }: { runtime: RuntimeListRow }) {
  const presence = derivePresence(runtime.heartbeatAt);
  const providers = runtime.providersAvailable ?? [];
  const agentCount = runtime._count?.agents ?? 0;

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
      <PresenceBadge presence={presence} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium text-foreground">
            {runtime.name}
          </span>
          <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
            {runtime.kind.toLowerCase().replace("_", " ")}
          </span>
        </div>
        <div className="mt-0.5 text-meta text-muted-foreground">
          {agentCount} agent{agentCount === 1 ? "" : "s"} · providers:{" "}
          {providers.length ? providers.join(", ").toLowerCase() : "—"} ·
          last heartbeat: {relativeTime(runtime.heartbeatAt)}
        </div>
      </div>
    </div>
  );
}

type Presence = "live" | "idle" | "offline";

function derivePresence(heartbeatAt: Date | string | null): Presence {
  if (!heartbeatAt) return "offline";
  const ageMs = Date.now() - new Date(heartbeatAt).getTime();
  if (Number.isNaN(ageMs)) return "offline";
  if (ageMs < 90_000) return "live";
  if (ageMs < 300_000) return "idle";
  return "offline";
}

function PresenceBadge({ presence }: { presence: Presence }) {
  if (presence === "live") {
    return (
      <span
        className="flex h-7 w-7 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
        title="Live — heartbeat within 90s"
      >
        <CircleDot className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (presence === "idle") {
    return (
      <span
        className="flex h-7 w-7 items-center justify-center rounded-md border border-warning/30 bg-warning/10 text-warning"
        title="Idle — heartbeat 90s–5m ago"
      >
        <CircleDot className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-subtle/40 text-muted-foreground"
      title="Offline — heartbeat 5m+ ago or never"
    >
      <CircleSlash className="h-3.5 w-3.5" />
    </span>
  );
}

function relativeTime(iso: Date | string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "?";
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Email-to-issue (beta) — exposes a webhook endpoint at
 * `/api/ingest/email`. Toggle + HMAC secret rotation. Provider
 * wiring (Postmark / SendGrid inbound) lives in the operator's
 * deployment, not in Forge itself; this UI captures the contract
 * and lets admins manage the secret. Off by default.
 */
function EmailIngestSection() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";

  const { data: status } = trpc.workspace.emailIngestStatus.useQuery(undefined, {
    enabled: isAdmin,
  });
  const { data: current } = trpc.workspace.current.useQuery(undefined, {
    enabled: isAdmin,
  });

  const [pendingSecret, setPendingSecret] = useState<string | null>(null);

  const updateWorkspace = trpc.workspace.update.useMutation({
    onSuccess: () => {
      utils.workspace.current.invalidate();
      utils.workspace.emailIngestStatus.invalidate();
      toast.success("Email ingest updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  const rotateSecret = trpc.workspace.rotateEmailIngestSecret.useMutation({
    onSuccess: ({ secret }) => {
      setPendingSecret(secret);
      utils.workspace.emailIngestStatus.invalidate();
      toast.success("Secret regenerated — copy it now.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;

  const enabled = current?.emailIngestEnabled ?? false;
  const secretSet = status?.secretSet ?? false;
  const inboxAddress = `inbox+${(status?.workspaceKey ?? ws.key).toLowerCase()}@forge.axiom-labs.dev`;
  const examplePayload = JSON.stringify(
    {
      workspaceKey: status?.workspaceKey ?? ws.key,
      from: "alice@example.com",
      subject: "Bug: dashboard crashes on load",
      body: "Steps to reproduce…",
      attachments: [],
    },
    null,
    2,
  );

  function copy(text: string, label = "Copied") {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(label))
      .catch(() => toast.error("Clipboard write failed."));
  }

  return (
    <Card as="div">
      <div className="flex items-start gap-3 p-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-subtle/40 text-foreground/80">
          <Mail className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Email-to-issue
            </h3>
            <span
              className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
              title="The endpoint is wired and accepts signed payloads, but no upstream provider integration ships yet."
            >
              beta
            </span>
            {enabled && (
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700">
                enabled
              </span>
            )}
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            POST signed JSON to <code className="font-mono">/api/ingest/email</code>{" "}
            and Forge creates an issue. Useful for wiring Postmark /
            SendGrid inbound webhooks to a target inbox.
          </p>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Enable email ingestion</div>
              <div className="text-xs text-muted-foreground">
                When off, the endpoint returns 403 even with a valid
                signature.
              </div>
            </div>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) =>
                updateWorkspace.mutate({ emailIngestEnabled: e.target.checked })
              }
              className="h-4 w-4"
              disabled={updateWorkspace.isPending}
            />
          </label>

          <div className="space-y-2 rounded-md border border-border bg-background/40 p-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">HMAC secret</span>
              <span className="text-[0.6875rem] text-muted-foreground">
                {secretSet ? "configured" : "not yet generated"}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 text-[0.6875rem]"
                disabled={rotateSecret.isPending}
                onClick={() => rotateSecret.mutate()}
              >
                <RefreshCw className="h-3 w-3" />
                {secretSet ? "Rotate secret" : "Generate secret"}
              </Button>
            </div>
            {pendingSecret && (
              <div className="rounded border border-warning/30 bg-warning/10 p-2 text-[0.6875rem]">
                <div className="mb-1 font-semibold text-warning">
                  Copy now — this secret is shown once.
                </div>
                <code className="block break-all font-mono">
                  {pendingSecret}
                </code>
                <button
                  type="button"
                  onClick={() => copy(pendingSecret, "Secret copied.")}
                  className="mt-1 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Copy className="h-3 w-3" /> Copy
                </button>
              </div>
            )}
            <p className="text-[0.6875rem] text-muted-foreground">
              The signature header is{" "}
              <code className="font-mono">x-forge-email-signature</code>:
              hex-encoded HMAC-SHA256 of the raw request body using
              this secret.
            </p>
          </div>

          <div className="space-y-2 rounded-md border border-border bg-background/40 p-3 text-[0.6875rem] text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="font-medium">Target inbox</span>
              <code className="font-mono text-foreground">{inboxAddress}</code>
              <button
                type="button"
                onClick={() => copy(inboxAddress, "Inbox address copied.")}
                className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
                title="Copy"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <p>
              The address above is a placeholder — actual Postmark /
              SendGrid wiring lands in a future run. Today the
              endpoint is the contract.
            </p>
            <details className="text-foreground/80">
              <summary className="cursor-pointer text-foreground hover:text-ember">
                Example payload
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-card/60 p-2 font-mono text-[0.625rem] text-foreground/90">
                {examplePayload}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </Card>
  );
}
