"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  ChevronLeft,
  Cloud,
  Globe,
  HardDrive,
  Server,
} from "lucide-react";
import type { RuntimeKind } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { Section, SkeletonList } from "@/components/ui";
import { CodeBlock } from "@/components/mcp-integration-blocks";
import { RuntimeToolSurfacePanel } from "@/components/runtime-tool-surface";
import { RuntimeCredentials } from "@/components/settings/runtime-credentials";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

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

function agentPresenceText(input: Date | string | null | undefined): string {
  return input
    ? `presence heartbeat ${relativeTime(input)} ago`
    : "no presence heartbeat yet";
}

/**
 * Runtime detail — header, agents on this runtime, optional connect-a-
 * daemon block (LOCAL_DAEMON only when no agents are attached yet), plus
 * the rename / archive controls.
 *
 * Stream D will fill in the SSE channel id details once `forge daemon
 * start` is wired through. For now the connect block is a static recipe.
 */
export default function RuntimeDetailPage() {
  const ws = useWorkspace();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data: runtime, isLoading } = trpc.runtime.byId.useQuery(
    { id },
    { enabled: !!id },
  );

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEndpoint, setEditEndpoint] = useState("");
  const [editSecret, setEditSecret] = useState("");
  const [editConfig, setEditConfig] = useState("{}");
  const [archiveOpen, setArchiveOpen] = useState(false);

  useEffect(() => {
    if (editOpen && runtime) {
      setEditName(runtime.name);
      setEditEndpoint(runtime.endpoint ?? "");
      setEditSecret("");
      setEditConfig(JSON.stringify(runtime.config ?? {}, null, 2));
    }
    // Only re-seed when the modal toggles open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOpen]);

  const update = trpc.runtime.update.useMutation({
    onSuccess: () => {
      toast.success("Runtime saved.");
      void utils.runtime.byId.invalidate({ id });
      void utils.runtime.list.invalidate();
      setEditOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const verify = trpc.runtime.verifyConnection.useMutation({
    onSuccess: (res) => {
      const title = res.probe.reachable ? "Connection reachable." : "Connection test failed.";
      (res.probe.reachable ? toast.success : toast.error)(`${title} ${res.probe.detail}`);
      void utils.runtime.byId.invalidate({ id });
      void utils.runtime.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setEnabled = trpc.runtime.setEnabled.useMutation({
    onSuccess: (rt) => {
      toast.success(rt.disabledAt ? "Runtime disabled." : "Runtime enabled.");
      void utils.runtime.byId.invalidate({ id });
      void utils.runtime.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.runtime.archive.useMutation({
    onSuccess: () => {
      toast.success("Runtime archived.");
      void utils.runtime.list.invalidate();
      void utils.runtime.byId.invalidate({ id });
      setArchiveOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const unarchive = trpc.runtime.unarchive.useMutation({
    onSuccess: () => {
      toast.success("Runtime restored.");
      void utils.runtime.list.invalidate();
      void utils.runtime.byId.invalidate({ id });
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isLoading && !runtime) notFound();

  const KindIcon = runtime ? KIND_ICON[runtime.kind] : Server;
  const showConnectPane =
    runtime?.kind === "LOCAL_DAEMON" && runtime.agents.length === 0;

  return (
    <>
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <Link
              href={`/w/${ws.slug}/settings/runtimes`}
              className="text-muted-foreground hover:text-foreground"
              title="Back to Runtimes"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <KindIcon className="h-4 w-4 text-muted-foreground" />
            <span>{runtime?.name ?? "Runtime"}</span>
          </span>
        }
        subtitle={runtime ? KIND_LABEL[runtime.kind] : undefined}
        actions={
          runtime && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => verify.mutate({ id })}
                disabled={verify.isPending}
              >
                {verify.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
              {!runtime.archivedAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEnabled.mutate({ id, enabled: Boolean(runtime.disabledAt) })}
                  disabled={setEnabled.isPending}
                >
                  {runtime.disabledAt ? "Enable" : "Disable"}
                </Button>
              )}
              {runtime.archivedAt ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => unarchive.mutate({ id })}
                  disabled={unarchive.isPending}
                >
                  Unarchive
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setArchiveOpen(true)}
                >
                  Archive
                </Button>
              )}
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          {!runtime ? (
            <SkeletonList rows={4} />
          ) : (
            <>
              {runtime.archivedAt && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-meta">
                  <div className="font-medium text-foreground">
                    This runtime is archived.
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    It is hidden from the active list and rejects
                    heartbeats. Use{" "}
                    <span className="font-medium text-foreground">
                      Unarchive
                    </span>{" "}
                    in the toolbar to restore it.
                  </div>
                </div>
              )}
              <Card as="div" className="divide-y-0 p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
                    <KindIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{runtime.name}</h2>
                      <KindBadge kind={runtime.kind} />
                      <RuntimeHealthBadge health={runtime.health} />
                      {runtime.providersAvailable.map((p) => (
                        <span
                          key={p}
                          className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
                      <span className="font-mono">
                        id <span className="text-id">{runtime.id}</span>
                      </span>
                      <span>·</span>
                      <span>{runtime.health.lastSignal}</span>
                      {runtime.connectedAt && (
                        <>
                          <span>·</span>
                          <span>
                            connected {relativeTime(runtime.connectedAt)} ago
                          </span>
                        </>
                      )}
                      {runtime.owner && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar
                              name={runtime.owner.name}
                              image={runtime.owner.image}
                              size={16}
                            />
                            <span>{runtime.owner.name ?? "unknown"}</span>
                          </span>
                        </>
                      )}
                    </div>
                    <div className="grid gap-2 rounded-md border border-border/60 bg-background/40 p-3 text-meta text-muted-foreground sm:grid-cols-2">
                      <div>
                        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                          Reason
                        </div>
                        <div className="mt-1 text-foreground/80">{runtime.health.reason}</div>
                      </div>
                      <div>
                        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                          {runtime.adapterKey === "hermes" ? "Probe / presence" : "Last signal"}
                        </div>
                        <div className="mt-1">{runtime.health.lastSignal}</div>
                      </div>
                      <div>
                        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                          Probe / sweep
                        </div>
                        <div className="mt-1">{runtime.health.sweepExpectation}</div>
                      </div>
                      <div>
                        <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
                          Endpoint / adapter
                        </div>
                        <div className="mt-1 truncate font-mono text-[0.6875rem] text-foreground/80">
                          {runtime.endpoint ?? "no endpoint"} · {runtime.health.adapter}
                        </div>
                      </div>
                    </div>
                    {runtime.endpoint && (
                      <div className="text-meta text-muted-foreground">
                        endpoint{" "}
                        <span className="font-mono text-foreground/80">
                          {runtime.endpoint}
                        </span>
                      </div>
                    )}
                    <RuntimeToolSurfacePanel
                      adapterKey={runtime.adapterKey}
                      config={runtime.config}
                      configStatus={runtime.configStatus}
                    />
                  </div>
                </div>
              </Card>

              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    Agents on this runtime
                    <span className="font-mono text-meta text-muted-foreground">
                      {runtime.agents.length}
                    </span>
                  </span>
                }
              >
                {runtime.agents.length === 0 ? (
                  <Card as="div" className="px-4 py-6 text-meta text-muted-foreground">
                    No agents are pointing at this runtime yet.
                    {runtime.kind === "LOCAL_DAEMON" && (
                      <>
                        {" "}
                        Once the daemon connects, attach an agent by setting
                        its <span className="font-mono">runtimeId</span> to{" "}
                        <code className="rounded bg-subtle px-1 font-mono text-id">
                          {runtime.id}
                        </code>
                        .
                      </>
                    )}
                  </Card>
                ) : (
                  <Card as="div" className="divide-y-0 p-0">
                    <ul className="divide-y divide-border">
                      {runtime.agents.map((a) => (
                        <li
                          key={a.id}
                          className="flex items-center gap-3 px-4 py-2.5"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-subtle text-sm">
                            {a.avatar ? (
                              <span aria-hidden>{a.avatar}</span>
                            ) : (
                              <span className="text-xs font-medium text-muted-foreground">
                                {a.name.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                href={`/w/${ws.slug}/agents/${a.profileKey}`}
                                className="truncate text-sm font-medium text-foreground hover:text-ember"
                              >
                                {a.name}
                              </Link>
                              <span className="text-id text-muted-foreground">
                                @{a.profileKey}
                              </span>
                              <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                                {a.provider}
                              </span>
                              <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                                {a.runtimeMode === "PERSISTENT"
                                  ? "persistent"
                                  : "session"}
                              </span>
                              <span
                                className={cn(
                                  "rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
                                  a.status === "ONLINE"
                                    ? "bg-success/10 text-success"
                                    : a.status === "BUSY"
                                      ? "bg-warning/10 text-warning"
                                      : "bg-subtle/40 text-muted-foreground",
                                )}
                              >
                                {a.status.toLowerCase()}
                              </span>
                            </div>
                            <div className="mt-0.5 text-meta text-muted-foreground">
                              {agentPresenceText(a.lastHeartbeatAt)}
                            </div>
                          </div>
                          <Link href={`/w/${ws.slug}/agents/${a.profileKey}`}>
                            <Button size="sm" variant="ghost">
                              Open
                            </Button>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </Section>

              <RuntimeCredentials runtimeId={id} />

              {showConnectPane && (
                <Section
                  title={
                    <span className="flex items-center gap-2">
                      <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                      Connect a new daemon
                    </span>
                  }
                  hint={
                    <>
                      The Forge CLI registers this runtime on{" "}
                      <code className="font-mono">forge daemon start</code>,
                      then opens an SSE subscription scoped to it. Stream D
                      will land the binary; the recipe stays the same.
                    </>
                  }
                >
                  <Card as="div" className="space-y-3 divide-y-0 p-4">
                    <CodeBlock
                      label="On the host running the daemon"
                      code={`forge login --workspace ${ws.slug}\nforge daemon start`}
                    />
                    <div className="text-meta text-muted-foreground">
                      Once connected, the daemon heartbeats every 60s and
                      this card is replaced by the agent list above. The SSE
                      channel id is{" "}
                      <code className="rounded bg-subtle px-1 font-mono text-id">
                        runtime:{runtime.id}
                      </code>{" "}
                      <span className="text-muted-foreground/70">
                        (final wire format pending Stream D)
                      </span>
                      .
                    </div>
                  </Card>
                </Section>
              )}
            </>
          )}
        </div>
      </div>

      <QuickForm
        open={editOpen}
        onOpenChange={(v) => {
          if (!v) setEditOpen(false);
        }}
        title="Edit runtime"
        description="Update runtime connection details. Leave the secret blank to keep the existing value. Config must be a JSON object validated by the adapter."
        primaryLabel="Save"
        loading={update.isPending}
        onSubmit={async (e) => {
          e.preventDefault();
          const name = editName.trim();
          if (!name) return { error: "Name cannot be empty." };
          let config: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(editConfig || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return { error: "Config must be a JSON object." };
            }
            config = parsed as Record<string, unknown>;
          } catch (err) {
            return { error: err instanceof Error ? err.message : "Invalid JSON config." };
          }
          try {
            await update.mutateAsync({
              id,
              name,
              endpoint: editEndpoint.trim(),
              secret: editSecret.trim() || undefined,
              config,
            });
          } catch (err) {
            return { error: err instanceof Error ? err.message : "Save failed." };
          }
        }}
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
              Name
            </span>
            <Input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={120}
              placeholder="Runtime name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
              Endpoint
            </span>
            <Input
              value={editEndpoint}
              onChange={(e) => setEditEndpoint(e.target.value)}
              placeholder="https://… or wss://…"
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
              Secret {runtime?.hasSecret ? "(configured — blank keeps it)" : "(none set)"}
            </span>
            <Input
              type="password"
              value={editSecret}
              onChange={(e) => setEditSecret(e.target.value)}
              placeholder={runtime?.hasSecret ? "••••••••" : "HMAC / gateway token"}
              className="font-mono"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
              Config JSON
            </span>
            <textarea
              value={editConfig}
              onChange={(e) => setEditConfig(e.target.value)}
              rows={6}
              className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs"
            />
          </label>
        </div>
      </QuickForm>

      <Confirm
        open={archiveOpen}
        onOpenChange={(v) => !v && setArchiveOpen(false)}
        title={`Archive ${runtime?.name ?? "runtime"}?`}
        description="The runtime is hidden from the active list. Agents pointing at it stay assigned, but new heartbeats are rejected."
        primaryLabel="Archive"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ id })}
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
