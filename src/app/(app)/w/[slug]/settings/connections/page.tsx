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
  Sparkles,
  ArrowRight,
  GitBranch,
  MessageSquare,
  Inbox as InboxIcon,
  AlertTriangle,
  PlugZap,
  Mail,
  KeyRound,
  Copy,
  RefreshCw,
} from "lucide-react";

/**
 * Connections — inbound + outbound external I/O.
 *
 * This is what used to be "Integrations", minus the adapters that were
 * actually *agents* in disguise (Hermes, Claude Code, Codex). Those moved
 * to Settings → Automation → Agents, where provider + runtime + connection
 * now live on one card. This page is strictly for systems that *talk to*
 * Forge, not systems that *are* Forge.
 *
 * Email-to-issue is the one inbound channel with a real backend today
 * (`/api/ingest/email`); the remaining cards describe the contract and
 * read as "available" until their upstream wiring ships.
 */

type ConnectionRow = {
  key: string;
  title: string;
  blurb: string;
  icon: typeof GitBranch;
  transport: string;
  status: "connected" | "available" | "needs auth";
  scope?: string | null;
  beta?: boolean;
};

const INBOUND: ConnectionRow[] = [
  {
    key: "github",
    title: "GitHub",
    blurb: "Two-way sync: issues, PR status, mentions.",
    icon: GitBranch,
    transport: "OAuth",
    status: "available",
    scope: null,
  },
  {
    key: "slack-cmd",
    title: "Slack commands",
    blurb: "Slash-commands and mentions from a Slack workspace.",
    icon: MessageSquare,
    transport: "OAuth",
    status: "available",
    scope: null,
  },
  {
    key: "linear-import",
    title: "Linear import",
    blurb: "One-shot import from a Linear workspace.",
    icon: InboxIcon,
    transport: "API key",
    status: "available",
    scope: null,
  },
];

const OUTBOUND: ConnectionRow[] = [
  {
    key: "slack-notif",
    title: "Slack notifications",
    blurb: "Mirror inbox to a channel. One-way write.",
    icon: MessageSquare,
    transport: "OAuth",
    status: "available",
    scope: null,
  },
  {
    key: "discord",
    title: "Discord webhook",
    blurb: "Post issue events to a Discord channel.",
    icon: MessageSquare,
    transport: "Webhook URL",
    status: "available",
    scope: null,
  },
  {
    key: "pagerduty",
    title: "PagerDuty",
    blurb: "Route URGENT issues to a PagerDuty service.",
    icon: AlertTriangle,
    transport: "Service key",
    status: "available",
    scope: null,
  },
  {
    key: "custom-webhook",
    title: "Custom webhook",
    blurb: "Any HTTPS endpoint. Signed payloads, retries built-in.",
    icon: PlugZap,
    transport: "Webhook URL",
    status: "available",
    scope: null,
  },
];

const EVENTS = [
  "issue.created",
  "issue.updated",
  "issue.assigned",
  "issue.transitioned",
  "comment.created",
  "cycle.started",
  "cycle.ended",
  "plan.completed",
];

export default function ConnectionsPage() {
  const ws = useWorkspace();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        title="Connections"
        subtitle="Send work into Forge, or send events out. For agents and their runtimes, use Agents."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Where did Integrations go? */}
          <div className="flex items-start gap-3 rounded-lg border border-border bg-card/30 p-3 text-meta">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
            <div>
              <span className="font-medium text-foreground">
                Looking for Hermes, Claude Code, or Codex?
              </span>{" "}
              <span className="text-muted-foreground">
                Those are agents now — they live under{" "}
                <Link
                  href={`/w/${ws.slug}/settings/agents`}
                  className="text-foreground underline decoration-dotted underline-offset-2 hover:text-ember"
                >
                  Automation → Agents
                </Link>
                . This page is for things that{" "}
                <span className="text-foreground">talk to Forge</span>, not things that{" "}
                <span className="text-foreground">are Forge</span>.
              </span>
            </div>
          </div>

          {/* Inbound */}
          <ConnectionSection
            title="Inbound"
            hint="External systems that send work into Forge — create issues, post mentions, trigger commands."
          >
            <EmailIngestCard />
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {INBOUND.map((c) => (
                <ConnectionCard key={c.key} c={c} direction="in" />
              ))}
            </ul>
          </ConnectionSection>

          {/* Outbound */}
          <ConnectionSection
            title="Outbound"
            hint="External systems that receive events from Forge — notifications, mirrors, paging."
          >
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {OUTBOUND.map((c) => (
                <ConnectionCard key={c.key} c={c} direction="out" />
              ))}
            </ul>
          </ConnectionSection>

          {/* Event vocabulary */}
          <ConnectionSection
            title="Event vocabulary"
            hint="Connections subscribe to these events. Outbound deliveries are queued and retried automatically."
            actions={
              <Link
                href={`/w/${ws.slug}/settings/deliveries`}
                className="text-meta text-muted-foreground hover:text-foreground"
              >
                Webhook deliveries →
              </Link>
            }
          >
            <Card as="div">
              <ul className="grid grid-cols-2 gap-2 p-4 font-mono text-meta sm:grid-cols-4">
                {EVENTS.map((e) => (
                  <li
                    key={e}
                    className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5"
                  >
                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ember/60" />
                    <span className="truncate text-foreground">{e}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </ConnectionSection>
        </div>
      </div>
    </div>
  );
}

function ConnectionSection({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-[0.8125rem] font-semibold text-foreground">{title}</h2>
        {actions && <span className="ml-auto">{actions}</span>}
      </div>
      <p className="px-1 text-meta text-muted-foreground">{hint}</p>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ConnectionCard({
  c,
  direction,
}: {
  c: ConnectionRow;
  direction: "in" | "out";
}) {
  const Icon = c.icon;
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card/40 p-3 hover:border-ember/40">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-subtle">
        <Icon className="h-3.5 w-3.5 text-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{c.title}</span>
          {c.beta && (
            <span className="rounded border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
              beta
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">{c.blurb}</p>
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          <span className="inline-flex items-center gap-1">
            {direction === "in" ? (
              <>
                <span>external</span>
                <ArrowRight className="h-2.5 w-2.5" />
                <span className="text-ember">Forge</span>
              </>
            ) : (
              <>
                <span className="text-ember">Forge</span>
                <ArrowRight className="h-2.5 w-2.5" />
                <span>external</span>
              </>
            )}
          </span>
          <span>·</span>
          <span className="font-mono">{c.transport}</span>
          {c.scope && (
            <>
              <span>·</span>
              <span className="truncate font-mono">{c.scope}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <StatusBadge status={c.status} />
        <button
          type="button"
          disabled
          title="Upstream wiring lands in a future run."
          className="inline-flex h-6 cursor-default items-center rounded-md px-2 text-meta text-muted-foreground/60"
        >
          {c.status === "available" ? "Connect →" : "Configure →"}
        </button>
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: ConnectionRow["status"] }) {
  if (status === "connected") {
    return (
      <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
        connected
      </span>
    );
  }
  if (status === "needs auth") {
    return (
      <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-warning">
        needs auth
      </span>
    );
  }
  return (
    <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
      available
    </span>
  );
}

/**
 * Email-to-issue (beta) — the one inbound channel with a live backend.
 * Exposes a webhook endpoint at `/api/ingest/email`. Toggle + HMAC secret
 * rotation. Provider wiring (Postmark / SendGrid inbound) lives in the
 * operator's deployment, not in Forge itself. Off by default. Admin-only.
 */
function EmailIngestCard() {
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
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-subtle text-foreground/80">
          <Mail className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Email-to-issue</h3>
            <span
              className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
              title="The endpoint is wired and accepts signed payloads, but no upstream provider integration ships yet."
            >
              beta
            </span>
            {enabled && (
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                enabled
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <span>external</span>
              <ArrowRight className="h-2.5 w-2.5" />
              <span className="text-ember">Forge</span>
            </span>
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            POST signed JSON to <code className="font-mono">/api/ingest/email</code> and
            Forge creates an issue. Useful for wiring Postmark / SendGrid inbound webhooks
            to a target inbox.
          </p>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Enable email ingestion</div>
              <div className="text-xs text-muted-foreground">
                When off, the endpoint returns 403 even with a valid signature.
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
                <code className="block break-all font-mono">{pendingSecret}</code>
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
              <code className="font-mono">x-forge-email-signature</code>: hex-encoded
              HMAC-SHA256 of the raw request body using this secret.
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
              The address above is a placeholder — actual Postmark / SendGrid wiring lands
              in a future run. Today the endpoint is the contract.
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
