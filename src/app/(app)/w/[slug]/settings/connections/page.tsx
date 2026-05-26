"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  GitBranch,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  PlugZap,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import type { ConnectionProvider } from "@prisma/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { Topbar } from "@/components/topbar";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";

/**
 * Workspace · Connections — the **mapping** surface.
 *
 * OAuth/OIDC *identities* (your GitHub login, Slack auth) are global,
 * user-owned `Connection` rows. This page maps an identity to concrete
 * targets *in this workspace* — repos, channels, webhooks — with a
 * direction and status. The same GitHub token can map to different repos
 * in different workspaces. Reads are workspace-scoped; create / edit /
 * delete are admin-gated and require owning the underlying connection.
 * Mirrors `WorkspaceConnectionsMappingScreen` in the design handoff.
 */

type MappingKind = "repo" | "channel" | "webhook";
type Direction = "inbound" | "outbound" | "inbound+outbound";

const KIND_OPTIONS: { value: MappingKind; label: string }[] = [
  { value: "repo", label: "Repository" },
  { value: "channel", label: "Channel" },
  { value: "webhook", label: "Webhook" },
];

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "inbound+outbound", label: "Inbound + outbound" },
  { value: "inbound", label: "Inbound only" },
  { value: "outbound", label: "Outbound only" },
];

const PROVIDER_META: Record<
  ConnectionProvider,
  { label: string; glyph: string; color: string }
> = {
  GITHUB: { label: "GitHub", glyph: "GH", color: "#24292f" },
  SLACK: { label: "Slack", glyph: "S", color: "#4A154B" },
  GOOGLE: { label: "Google", glyph: "G", color: "#4285F4" },
  OIDC: { label: "OIDC", glyph: "ID", color: "#5b6472" },
  CUSTOM: { label: "Custom", glyph: "C", color: "#6b6257" },
};

type ConnectionRow = inferRouterOutputs<AppRouter>["connection"]["list"][number];
type MappingRow = inferRouterOutputs<AppRouter>["connectionMapping"]["list"][number];

type EditingState = {
  id?: string;
  connectionId: string;
  kind: MappingKind;
  target: string;
  direction: Direction;
  routeTo: string;
};

export default function ConnectionsMappingPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";

  const { data: connections, isLoading: connectionsLoading } =
    trpc.connection.list.useQuery();
  const { data: mappings, isLoading: mappingsLoading } =
    trpc.connectionMapping.list.useQuery();

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    target: string;
  } | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  function invalidate() {
    void utils.connectionMapping.list.invalidate();
    void utils.connection.list.invalidate();
  }

  const create = trpc.connectionMapping.create.useMutation({
    onSuccess: () => {
      toast.success("Mapping added.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.connectionMapping.update.useMutation({
    onSuccess: () => {
      toast.success("Mapping updated.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.connectionMapping.delete.useMutation({
    onSuccess: () => {
      toast.success("Mapping removed.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Group this workspace's mappings by their underlying connection.
  const byConnection = useMemo(() => {
    const m = new Map<string, MappingRow[]>();
    for (const row of mappings ?? []) {
      const list = m.get(row.connectionId) ?? [];
      list.push(row);
      m.set(row.connectionId, list);
    }
    return m;
  }, [mappings]);

  // Connections with at least one mapping here (rendered as mapping tables).
  const mappedConnections = useMemo(
    () => (connections ?? []).filter((c) => byConnection.has(c.id)),
    [connections, byConnection],
  );

  // Connected identities not yet mapped into this workspace.
  const availableIdentities = useMemo(
    () =>
      (connections ?? []).filter(
        (c) => c.status === "CONNECTED" && !byConnection.has(c.id),
      ),
    [connections, byConnection],
  );

  const pending = create.isPending || update.isPending;
  const hasAnyConnection = (connections ?? []).length > 0;

  function openAdd(connectionId?: string, kind: MappingKind = "repo") {
    setEditing({
      connectionId: connectionId ?? availableIdentities[0]?.id ?? connections?.[0]?.id ?? "",
      kind,
      target: "",
      direction: "inbound+outbound",
      routeTo: "",
    });
  }

  function openEdit(row: MappingRow) {
    setEditing({
      id: row.id,
      connectionId: row.connectionId,
      kind: row.kind as MappingKind,
      target: row.target,
      direction: row.direction as Direction,
      routeTo: row.routeTo ?? "",
    });
  }

  async function submit(): Promise<{ error?: string } | undefined> {
    if (!editing) return;
    if (!editing.connectionId) return { error: "Pick a connection." };
    if (!editing.target.trim()) return { error: "Target required." };
    try {
      if (editing.id) {
        await update.mutateAsync({
          id: editing.id,
          target: editing.target.trim(),
          direction: editing.direction,
          routeTo: editing.routeTo.trim() || null,
        });
      } else {
        await create.mutateAsync({
          connectionId: editing.connectionId,
          kind: editing.kind,
          target: editing.target.trim(),
          direction: editing.direction,
          routeTo: editing.routeTo.trim() || undefined,
        });
      }
      return undefined;
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Failed to save mapping." };
    }
  }

  return (
    <>
      <Topbar
        title="Connections"
        subtitle="Map your global OAuth identities to channels, repos, and webhooks in this workspace."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/settings/connections">
              <Button size="sm" variant="ghost">
                My connections
              </Button>
            </Link>
            {isAdmin && hasAnyConnection && (
              <Button size="sm" variant="ember" onClick={() => openAdd()}>
                <Plus className="h-3.5 w-3.5" />
                Add mapping
              </Button>
            )}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          {/* Explainer banner */}
          <div className="rounded-md border border-border bg-card/40 p-3 text-[0.8125rem]">
            <div className="flex items-center gap-2">
              <PlugZap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">
                Identities live at your account. Workspaces decide what they map to.
              </span>
            </div>
            <p className="mt-1 text-meta text-muted-foreground">
              The same GitHub identity might post to{" "}
              <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">
                forge-platform/forge
              </code>{" "}
              in this workspace and{" "}
              <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">
                bailey/axiom
              </code>{" "}
              in another — same token, different mapping.
            </p>
          </div>

          {!connectionsLoading && !hasAnyConnection && (
            <EmptyState
              as="div"
              icon={PlugZap}
              title="No connections yet"
              hint="Connect an external identity (GitHub, Slack, an OIDC provider) at your account level first, then map it into this workspace here."
              action={
                <Link href="/settings/connections">
                  <Button size="sm" variant="ember">
                    Manage your connections
                  </Button>
                </Link>
              }
            />
          )}

          {/* Per-connection mapping tables */}
          {mappedConnections.map((conn) => (
            <ConnectionMappingSection
              key={conn.id}
              conn={conn}
              rows={byConnection.get(conn.id) ?? []}
              isAdmin={isAdmin}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onAdd={() => openAdd(conn.id, defaultKindFor(conn.provider))}
              onEdit={openEdit}
              onDelete={(row) =>
                setDeleteTarget({ id: row.id, target: row.target })
              }
              onTogglePause={(row) =>
                update.mutate({
                  id: row.id,
                  status: row.status === "active" ? "paused" : "active",
                })
              }
              saving={update.isPending}
            />
          ))}

          {!mappingsLoading &&
            hasAnyConnection &&
            mappedConnections.length === 0 && (
              <EmptyState
                as="div"
                icon={GitBranch}
                title="No mappings yet"
                hint="Map one of your connected identities to a repo, channel, or webhook in this workspace using the section below."
              />
            )}

          {/* Available identities */}
          <Section
            title="Available identities"
            hint="Connected globally but not mapped here yet."
          >
            <Card as="div">
              {availableIdentities.map((c) => {
                const meta = PROVIDER_META[c.provider];
                return (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 border-b border-border/60 p-3 last:border-b-0"
                  >
                    <ProviderGlyph provider={c.provider} />
                    <div className="min-w-0 flex-1">
                      <span className="text-[0.8125rem] font-semibold">
                        {meta.label}
                      </span>
                      {c.account && (
                        <span className="ml-2 font-mono text-meta text-muted-foreground">
                          {c.account}
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ember"
                      disabled={!isAdmin}
                      title={!isAdmin ? "Admins only." : undefined}
                      onClick={() => openAdd(c.id, defaultKindFor(c.provider))}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add mapping
                    </Button>
                  </div>
                );
              })}
              {!connectionsLoading &&
                hasAnyConnection &&
                availableIdentities.length === 0 && (
                  <div className="p-6 text-center text-meta text-muted-foreground">
                    All connected identities are mapped here. Add a new one from{" "}
                    <Link
                      href="/settings/connections"
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      your global connections
                    </Link>
                    .
                  </div>
                )}
            </Card>
          </Section>
        </div>
      </div>

      <QuickForm
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        title={editing?.id ? "Edit mapping" : "Add mapping"}
        description="Map a global connection to a concrete target in this workspace."
        primaryLabel={editing?.id ? "Save" : "Add mapping"}
        loading={pending}
        onSubmit={submit}
      >
        {editing && (
          <>
            <QuickForm.Field label="Connection" required>
              <select
                value={editing.connectionId}
                disabled={!!editing.id}
                onChange={(e) =>
                  setEditing({ ...editing, connectionId: e.target.value })
                }
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
              >
                <option value="">Pick a connection…</option>
                {(connections ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {PROVIDER_META[c.provider].label}
                    {c.account ? ` · ${c.account}` : ""}
                  </option>
                ))}
              </select>
            </QuickForm.Field>
            <div className="grid grid-cols-2 gap-2">
              <QuickForm.Field label="Kind" required>
                <select
                  value={editing.kind}
                  disabled={!!editing.id}
                  onChange={(e) =>
                    setEditing({ ...editing, kind: e.target.value as MappingKind })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </QuickForm.Field>
              <QuickForm.Field label="Direction">
                <select
                  value={editing.direction}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      direction: e.target.value as Direction,
                    })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {DIRECTION_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </QuickForm.Field>
            </div>
            <QuickForm.Field
              label="Target"
              required
              hint={targetHint(editing.kind)}
            >
              <Input
                value={editing.target}
                onChange={(e) =>
                  setEditing({ ...editing, target: e.target.value })
                }
                maxLength={400}
                placeholder={targetPlaceholder(editing.kind)}
                className="font-mono"
                autoFocus
              />
            </QuickForm.Field>
            <QuickForm.Field
              label="Routes to"
              hint="Optional — where matched events go (e.g. Dispatch matrix, Chat · @victor)."
            >
              <Input
                value={editing.routeTo}
                onChange={(e) =>
                  setEditing({ ...editing, routeTo: e.target.value })
                }
                maxLength={200}
                placeholder="Dispatch matrix"
              />
            </QuickForm.Field>
          </>
        )}
      </QuickForm>

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title="Remove mapping?"
        description={`"${deleteTarget?.target}" stops routing in this workspace. The underlying connection is untouched.`}
        primaryLabel="Remove"
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

/* ── Per-connection mapping table ───────────────────────────────────── */
function ConnectionMappingSection({
  conn,
  rows,
  isAdmin,
  openMenuId,
  setOpenMenuId,
  onAdd,
  onEdit,
  onDelete,
  onTogglePause,
  saving,
}: {
  conn: ConnectionRow;
  rows: MappingRow[];
  isAdmin: boolean;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  onAdd: () => void;
  onEdit: (row: MappingRow) => void;
  onDelete: (row: MappingRow) => void;
  onTogglePause: (row: MappingRow) => void;
  saving: boolean;
}) {
  const meta = PROVIDER_META[conn.provider];
  const subject = conn.provider === "SLACK" ? "channel" : "repository";
  return (
    <Section
      title={meta.label}
      hint={`Connection · ${conn.account ?? conn.label} · ${conn.status.toLowerCase()}`}
    >
      <Card as="div" className="overflow-visible">
        {/* Connection header */}
        <div className="flex items-center gap-2 border-b border-border/60 p-4">
          <ProviderGlyph provider={conn.provider} />
          <span className="text-sm font-semibold">{conn.account ?? conn.label}</span>
          <StatusChip status={conn.status} />
        </div>

        {/* Column header */}
        <div className="grid grid-cols-[1.4fr_0.8fr_0.7fr_0.4fr_28px] items-center gap-3 border-b border-border bg-subtle/40 px-4 py-2 text-meta text-muted-foreground">
          <span>{conn.provider === "SLACK" ? "Channel" : "Target"}</span>
          <span>Routes to</span>
          <span>Direction</span>
          <span className="text-right">Status</span>
          <span />
        </div>

        {rows.map((m) => (
          <div
            key={m.id}
            className="grid grid-cols-[1.4fr_0.8fr_0.7fr_0.4fr_28px] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <span className="flex items-center gap-2">
              <KindIcon kind={m.kind as MappingKind} />
              <span className="truncate font-mono text-[0.8125rem]">{m.target}</span>
            </span>
            <span className="truncate text-[0.8125rem] text-muted-foreground">
              {m.routeTo || "—"}
            </span>
            <span className="text-meta text-muted-foreground">
              {directionLabel(m.direction as Direction)}
            </span>
            <span className="text-right">
              <span
                className={
                  "inline-flex items-center gap-1 text-meta " +
                  (m.status === "active" ? "text-success" : "text-muted-foreground")
                }
              >
                <span
                  aria-hidden
                  className={
                    "inline-block h-1.5 w-1.5 rounded-full " +
                    (m.status === "active" ? "bg-success" : "bg-muted-foreground/60")
                  }
                />
                {m.status}
              </span>
            </span>
            <div className="relative flex justify-end">
              <button
                type="button"
                aria-label="Mapping actions"
                disabled={!isAdmin}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === m.id ? null : m.id);
                }}
                className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-40"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {openMenuId === m.id && (
                <div
                  role="menu"
                  className="absolute right-0 top-7 z-10 w-40 overflow-hidden rounded-md border border-border bg-card py-1 shadow-md"
                  onMouseLeave={() => setOpenMenuId(null)}
                >
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setOpenMenuId(null);
                      onEdit(m);
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-subtle"
                  >
                    Edit
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setOpenMenuId(null);
                      onTogglePause(m);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-subtle"
                  >
                    {m.status === "active" ? (
                      <>
                        <Pause className="h-3 w-3" /> Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" /> Resume
                      </>
                    )}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setOpenMenuId(null);
                      onDelete(m);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-subtle"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {isAdmin && (
          <button
            type="button"
            onClick={onAdd}
            className="flex w-full items-center gap-2 border-t border-border/60 p-3 text-[0.8125rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Map another {subject}
          </button>
        )}
      </Card>
    </Section>
  );
}

function ProviderGlyph({ provider }: { provider: ConnectionProvider }) {
  const meta = PROVIDER_META[provider];
  return (
    <span
      aria-hidden
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold text-white"
      style={{ background: meta.color }}
    >
      {meta.glyph}
    </span>
  );
}

function KindIcon({ kind }: { kind: MappingKind }) {
  const cls = "h-3 w-3 text-muted-foreground";
  if (kind === "channel") return <MessageSquare className={cls} />;
  if (kind === "webhook") return <Webhook className={cls} />;
  return <GitBranch className={cls} />;
}

function StatusChip({ status }: { status: ConnectionRow["status"] }) {
  if (status === "CONNECTED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-meta text-success">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
        connected
      </span>
    );
  }
  if (status === "DEGRADED") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-meta text-warning">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />
        degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-subtle/40 px-1.5 py-0.5 text-meta text-muted-foreground">
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
      disconnected
    </span>
  );
}

function directionLabel(d: Direction): string {
  if (d === "inbound") return "inbound only";
  if (d === "outbound") return "outbound only";
  return "inbound + outbound";
}

function defaultKindFor(provider: ConnectionProvider): MappingKind {
  if (provider === "SLACK") return "channel";
  if (provider === "GITHUB") return "repo";
  return "webhook";
}

function targetHint(kind: MappingKind): string {
  if (kind === "channel") return "Channel name, e.g. #ops.";
  if (kind === "webhook") return "Webhook URL or endpoint identifier.";
  return "owner/repo, e.g. forge-platform/forge.";
}

function targetPlaceholder(kind: MappingKind): string {
  if (kind === "channel") return "#ops";
  if (kind === "webhook") return "https://example.com/hook";
  return "forge-platform/forge";
}
