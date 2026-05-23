"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Cloud,
  Globe,
  HardDrive,
  Server,
  Users as UsersIcon,
} from "lucide-react";
import type { RuntimeKind } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
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
};

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
  } | null>(null);

  const { data: adapters } = trpc.runtime.adapters.useQuery();

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
          <Card as="div" className="divide-y-0 p-0">
            <ul className="divide-y divide-border">
              {rows.map((rt) => {
                const KindIcon = KIND_ICON[rt.kind];
                const isArchived = Boolean(rt.archivedAt);
                return (
                  <li
                    key={rt.id}
                    className={cn(
                      "flex flex-wrap items-start gap-3 px-4 py-3",
                      isArchived && "opacity-60",
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
                        <span>
                          {rt.heartbeatAt
                            ? `heartbeat ${relativeTime(rt.heartbeatAt)} ago`
                            : "no heartbeat yet"}
                        </span>
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
                        onClick={() =>
                          setEditTarget({
                            id: rt.id,
                            name: rt.name,
                            endpoint: rt.endpoint ?? "",
                            hasSecret: rt.hasSecret,
                          })
                        }
                      >
                        Edit
                      </Button>
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

type AdapterOption = {
  key: string;
  title: string;
  tagline: string;
  transport: string;
  multiAgent: boolean;
  providers: string[];
};

const fieldLabel = "mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground";

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
  }) => Promise<void>;
  pending: boolean;
}) {
  const [adapterKey, setAdapterKey] = useState("");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (open) {
      const first = adapters[0]?.key ?? "";
      setAdapterKey(first);
      setName("");
      setEndpoint("");
      setSecret("");
    }
  }, [open, adapters]);

  const adapter = adapters.find((a) => a.key === adapterKey);

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
            <span className="mt-1 block text-xs text-muted-foreground">{adapter.tagline}</span>
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
              (gateway base URL, e.g. http://127.0.0.1:8642/v1)
            </span>
          </span>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…"
            className="font-mono"
          />
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
      </div>
    </QuickForm>
  );
}

function EditRuntimeModal({
  target,
  onCancel,
  onSubmit,
  pending,
}: {
  target: { id: string; name: string; endpoint: string; hasSecret: boolean } | null;
  onCancel: () => void;
  onSubmit: (vals: { name: string; endpoint: string; secret?: string }) => Promise<void>;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (target) {
      setName(target.name);
      setEndpoint(target.endpoint);
      setSecret("");
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
      </div>
    </QuickForm>
  );
}
