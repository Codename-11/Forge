"use client";

import Link from "next/link";
import { useState } from "react";
import { Bot, KeyRound, ShieldOff, Terminal, Trash2, User } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/modal";
import { Spinner } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

type AccessKey = {
  id: string;
  name: string;
  prefix: string;
  kind: "AGENT" | "PERSONAL" | "SESSION";
  scopes: string[];
  projectIds: string[];
  labelIds: string[];
  initiativeIds: string[];
  linkedAgent: { id: string; name: string; profileKey: string; avatar: string | null } | null;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
};

type ClientStatus = {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
  detail: string;
};

function isExpired(key: AccessKey) {
  return Boolean(key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now());
}

function statusForKey(key: AccessKey): ClientStatus {
  if (key.revokedAt) {
    return {
      label: "revoked",
      tone: "danger",
      detail: `Revoked ${relativeTime(key.revokedAt)} ago.`,
    };
  }
  if (key.expiresAt && isExpired(key)) {
    return {
      label: "expired",
      tone: "danger",
      detail: `Expired ${relativeTime(key.expiresAt)} ago.`,
    };
  }
  if (!key.lastUsedAt) {
    return {
      label: "setup pending",
      tone: "warning",
      detail: "This key has not authenticated to Forge yet.",
    };
  }
  const usedMs = new Date(key.lastUsedAt).getTime();
  const stale = Number.isFinite(usedMs) && Date.now() - usedMs > 7 * 86_400_000;
  return stale
    ? {
        label: "stale",
        tone: "warning",
        detail: `Last used ${relativeTime(key.lastUsedAt)} ago.`,
      }
    : {
        label: "connected",
        tone: "success",
        detail: `Last used ${relativeTime(key.lastUsedAt)} ago.`,
      };
}

function formatExpiry(key: AccessKey): string | null {
  if (!key.expiresAt) return null;
  const ms = new Date(key.expiresAt).getTime() - Date.now();
  if (ms <= 0) return `expired ${relativeTime(key.expiresAt)} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `expires in ${Math.max(1, hours)}h`;
  return `expires in ${Math.floor(hours / 24)}d`;
}

function clientLabel(key: AccessKey) {
  const name = key.name.toLowerCase();
  if (name.includes("codex")) return "Codex";
  if (name.includes("claude")) return "Claude";
  if (name.includes("hermes")) return "Hermes";
  if (key.linkedAgent) return "Agent MCP";
  if (key.kind === "SESSION") return "Session client";
  if (key.kind === "PERSONAL") return "Personal MCP";
  return "Custom client";
}

function clientIcon(key: AccessKey) {
  const name = key.name.toLowerCase();
  if (key.kind === "SESSION" || name.includes("codex") || name.includes("claude")) return Terminal;
  if (key.kind === "PERSONAL") return User;
  if (key.linkedAgent) return Bot;
  return KeyRound;
}

function statusClasses(tone: ClientStatus["tone"]) {
  return tone === "success"
    ? "border-success/30 bg-success/10 text-success"
    : tone === "danger"
      ? "border-danger/30 bg-danger/10 text-danger"
      : tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border bg-subtle/40 text-muted-foreground";
}

export default function AgentClientsPage() {
  const [revokeTarget, setRevokeTarget] = useState<AccessKey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccessKey | null>(null);
  const { data: keys, isLoading, refetch } = trpc.access.list.useQuery();
  const clients = (keys ?? []) as AccessKey[];

  const revoke = trpc.access.revoke.useMutation({
    onSuccess: () => {
      toast.success("Client key revoked.");
      setRevokeTarget(null);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.access.delete.useMutation({
    onSuccess: () => {
      toast.success("Client key deleted.");
      setDeleteTarget(null);
      void refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const activeCount = clients.filter((k) => !k.revokedAt && !isExpired(k)).length;

  return (
    <>
      <Topbar
        title="Agent Clients"
        subtitle="MCP clients, session keys, and user-owned tokens for Claude Code, Codex CLI, Hermes, and scripts."
        actions={
          <Link
            href="/settings/access?create=session"
            className="focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-ember px-2 text-xs font-medium text-ember-foreground hover:bg-ember/90"
          >
            <Terminal className="h-3.5 w-3.5" />
            Add session
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <div className="grid gap-3 md:grid-cols-3">
            <SetupCard
              icon={Terminal}
              title="Ephemeral client"
              body="Short-lived key for Claude Code, Codex CLI, or a one-off local agent session."
              href="/settings/access?create=session"
              action="Generate session key"
            />
            <SetupCard
              icon={User}
              title="Personal MCP token"
              body="User-owned token for scripts and local clients that should survive longer than a session."
              href="/settings/access?create=personal"
              action="Create token"
            />
            <SetupCard
              icon={Bot}
              title="Registered agent"
              body="Persistent agent key tied to a Forge agent profile and provider-specific MCP setup."
              href="/settings/access?create=agent"
              action="Register agent"
            />
          </div>

          <Section
            title="Clients"
            hint="Existing clients are derived from workspace API keys. Raw setup config is shown only when a key is created or rotated."
            actions={
              <div className="flex items-center gap-3">
                <span className="text-[0.6875rem] text-muted-foreground">
                  {activeCount} active
                </span>
                <Link
                  href="/settings/access"
                  className="focus-ring inline-flex h-7 items-center justify-center rounded-md border border-border px-2 text-xs font-medium hover:bg-subtle"
                >
                  Developer access
                </Link>
              </div>
            }
          >
            <Card>
              {isLoading ? (
                <li className="flex items-center justify-center px-4 py-10">
                  <Spinner />
                </li>
              ) : clients.length === 0 ? (
                <EmptyState
                  icon={Terminal}
                  title="No agent clients yet"
                  hint="Generate a session key or register an agent to connect an external MCP client."
                />
              ) : (
                clients.map((key) => {
                  const Icon = clientIcon(key);
                  const status = statusForKey(key);
                  const narrowed =
                    key.projectIds.length + key.labelIds.length + key.initiativeIds.length;
                  return (
                    <li key={key.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{key.name}</span>
                          <Badge>{clientLabel(key)}</Badge>
                          <Badge>{key.kind.toLowerCase()}</Badge>
                          <span
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
                              statusClasses(status.tone),
                            )}
                            title={status.detail}
                          >
                            {status.label}
                          </span>
                          {key.linkedAgent && (
                            <Badge>
                              @{key.linkedAgent.profileKey}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                          <span className="font-mono">{key.prefix}...</span>
                          <span>·</span>
                          <span>created {relativeTime(key.createdAt)} ago</span>
                          <span>·</span>
                          <span>{key.lastUsedAt ? `used ${relativeTime(key.lastUsedAt)} ago` : "never used"}</span>
                          {key.expiresAt && (
                            <>
                              <span>·</span>
                              <span>{formatExpiry(key)}</span>
                            </>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {key.scopes.slice(0, 6).map((scope) => (
                            <Badge key={scope}>{scope}</Badge>
                          ))}
                          {key.scopes.length > 6 && <Badge>+{key.scopes.length - 6}</Badge>}
                          {narrowed > 0 && <Badge>{narrowed} narrowing rule{narrowed === 1 ? "" : "s"}</Badge>}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        <Link
                          href="/settings/access"
                          className="focus-ring inline-flex h-7 items-center justify-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-subtle hover:text-foreground"
                        >
                          Manage
                        </Link>
                        {!key.revokedAt && !isExpired(key) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRevokeTarget(key)}
                            disabled={revoke.isPending}
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                            Revoke
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(key)}
                          disabled={remove.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </li>
                  );
                })
              )}
            </Card>
          </Section>

          <div className="rounded-md border border-border bg-card/40 px-3 py-2 text-meta text-muted-foreground">
            Need the raw MCP config again? Rotate the key from{" "}
            <Link href="/settings/access" className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">
              Developer access
            </Link>
            . Forge stores only a hash after the creation or rotation reveal.
          </div>
        </div>
      </div>

      <Confirm
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        variant="destructive"
        title={revokeTarget ? `Revoke ${revokeTarget.name}?` : "Revoke client key?"}
        description="The client loses MCP/API access immediately. The row remains for audit and troubleshooting."
        primaryLabel="Revoke"
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate({ id: revokeTarget.id });
        }}
      />
      <Confirm
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        variant="destructive"
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete client key?"}
        description="This removes the row entirely. Revoke is safer if you need an audit trail."
        primaryLabel="Delete key"
        typeToConfirm={deleteTarget?.name}
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate({ id: deleteTarget.id });
        }}
      />
    </>
  );
}

function SetupCard({
  icon: Icon,
  title,
  body,
  href,
  action,
}: {
  icon: typeof Terminal;
  title: string;
  body: string;
  href: string;
  action: string;
}) {
  return (
    <Link
      href={href}
      className="focus-ring rounded-lg border border-border bg-card/40 p-3 text-left transition-colors hover:border-ember/40 hover:bg-subtle/50"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/60">
          <Icon className="h-3.5 w-3.5 text-ember" />
        </span>
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      <p className="mt-2 min-h-10 text-meta leading-relaxed text-muted-foreground">{body}</p>
      <span className="mt-3 inline-flex text-xs font-medium text-ember">{action}</span>
    </Link>
  );
}
