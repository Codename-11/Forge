"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  GitBranch,
  Github,
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
import { GitHubReconciliationPolicy } from "@/components/settings/github-reconciliation-policy";
import { IntegrationAccessPanel } from "@/components/settings/integration-access-panel";
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

const PROVIDER_META: Record<ConnectionProvider, { label: string; glyph: string; color: string }> = {
  GITHUB: { label: "GitHub", glyph: "GH", color: "#24292f" },
  SLACK: { label: "Slack", glyph: "S", color: "#4A154B" },
  GOOGLE: { label: "Google", glyph: "G", color: "#4285F4" },
  OIDC: { label: "OIDC", glyph: "ID", color: "#5b6472" },
  CUSTOM: { label: "Custom", glyph: "C", color: "#6b6257" },
};

type ConnectionRow = inferRouterOutputs<AppRouter>["connection"]["list"][number];
type MappingRow = inferRouterOutputs<AppRouter>["connectionMapping"]["list"][number];
type LabelRow = inferRouterOutputs<AppRouter>["label"]["list"][number];
type StatusRow = inferRouterOutputs<AppRouter>["status"]["list"][number];
type ProjectRow = inferRouterOutputs<AppRouter>["project"]["list"]["items"][number];
type AgentRow = inferRouterOutputs<AppRouter>["agent"]["list"][number];

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type PriorityValue = (typeof PRIORITIES)[number];

const GITHUB_STATUS_RULES = [
  { key: "issueClosedStatusId", label: "GitHub issue closed" },
  { key: "issueReopenedStatusId", label: "GitHub issue reopened" },
  { key: "prOpenedStatusId", label: "PR opened" },
  { key: "prReadyForReviewStatusId", label: "PR ready for review" },
  { key: "prChangesRequestedStatusId", label: "PR changes requested" },
  { key: "prMergedStatusId", label: "PR merged" },
  { key: "checksFailedStatusId", label: "Checks failed" },
] as const;
type GitHubStatusRuleKey = (typeof GITHUB_STATUS_RULES)[number]["key"];

type GitHubMappingUiConfig = {
  autoCreateIssues: boolean;
  syncTitle: boolean;
  syncDescription: boolean;
  syncComments: boolean;
  defaultProjectId: string;
  defaultPriority: PriorityValue;
  queueOnCreate: boolean;
  assignedAgentId: string;
  claimedById: string;
  labelMap: Record<string, string>;
  statusRules: Record<GitHubStatusRuleKey, string>;
};

type EditingState = {
  id?: string;
  connectionId: string;
  kind: MappingKind;
  target: string;
  direction: Direction;
  routeTo: string;
  labelIds: string[];
  github: GitHubMappingUiConfig;
};

function emptyGitHubRules(): Record<GitHubStatusRuleKey, string> {
  return Object.fromEntries(GITHUB_STATUS_RULES.map((r) => [r.key, ""])) as Record<
    GitHubStatusRuleKey,
    string
  >;
}

function defaultGitHubConfig(): GitHubMappingUiConfig {
  return {
    autoCreateIssues: false,
    syncTitle: true,
    syncDescription: false,
    syncComments: false,
    defaultProjectId: "",
    defaultPriority: "NONE",
    queueOnCreate: false,
    assignedAgentId: "",
    claimedById: "",
    labelMap: {},
    statusRules: emptyGitHubRules(),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function priorityValue(value: unknown): PriorityValue {
  return PRIORITIES.includes(value as PriorityValue) ? (value as PriorityValue) : "NONE";
}

function readGitHubConfig(config: unknown): GitHubMappingUiConfig {
  const root = objectValue(config);
  const github = objectValue(root.github);
  const statusRules = objectValue(github.statusRules);
  const next = defaultGitHubConfig();
  return {
    ...next,
    autoCreateIssues: booleanValue(github.autoCreateIssues, next.autoCreateIssues),
    syncTitle: booleanValue(github.syncTitle, next.syncTitle),
    syncDescription: booleanValue(github.syncDescription, next.syncDescription),
    syncComments: booleanValue(github.syncComments, next.syncComments),
    defaultProjectId: stringValue(github.defaultProjectId),
    defaultPriority: priorityValue(github.defaultPriority),
    queueOnCreate: booleanValue(github.queueOnCreate, next.queueOnCreate),
    assignedAgentId: stringValue(github.assignedAgentId),
    claimedById: stringValue(github.claimedById),
    labelMap: objectValue(github.labelMap) as Record<string, string>,
    statusRules: Object.fromEntries(
      GITHUB_STATUS_RULES.map((rule) => [rule.key, stringValue(statusRules[rule.key])]),
    ) as Record<GitHubStatusRuleKey, string>,
  };
}

function githubConfigForSave(config: GitHubMappingUiConfig): Record<string, unknown> {
  return {
    github: {
      autoCreateIssues: config.autoCreateIssues,
      syncTitle: config.syncTitle,
      syncDescription: config.syncDescription,
      syncComments: config.syncComments,
      defaultProjectId: config.defaultProjectId || null,
      defaultLabelIds: [],
      labelMap: config.labelMap,
      defaultPriority: config.defaultPriority,
      queueOnCreate: config.queueOnCreate,
      assignedAgentId: config.assignedAgentId || null,
      claimedById: config.claimedById || null,
      statusRules: Object.fromEntries(
        GITHUB_STATUS_RULES.map((rule) => [rule.key, config.statusRules[rule.key] || null]),
      ),
    },
  };
}

export default function ConnectionsMappingPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const utils = trpc.useUtils();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";

  const { data: connections, isLoading: connectionsLoading } = trpc.connection.list.useQuery();
  const { data: mappings, isLoading: mappingsLoading } = trpc.connectionMapping.list.useQuery();
  const { data: labels } = trpc.label.list.useQuery();
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });

  // Quick lookup so mapping rows can render chosen labels by id.
  const labelById = useMemo(() => new Map((labels ?? []).map((l) => [l.id, l])), [labels]);

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    target: string;
  } | null>(null);
  const [importing, setImporting] = useState<{
    mappingId: string;
    repo: string;
    number: string;
    projectId: string;
    queue: boolean;
  } | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const selectedConnection = useMemo(
    () => (connections ?? []).find((c) => c.id === editing?.connectionId) ?? null,
    [connections, editing?.connectionId],
  );
  const isGitHubRepoEditing = selectedConnection?.provider === "GITHUB" && editing?.kind === "repo";
  const { data: installationRepos, isLoading: installationReposLoading } =
    trpc.github.listInstallationRepos.useQuery(
      { connectionId: editing?.connectionId ?? "" },
      { enabled: !!editing?.connectionId && selectedConnection?.provider === "GITHUB" },
    );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ok = url.searchParams.get("connection_connected");
    const err = url.searchParams.get("connection_error");
    if (!ok && !err) return;
    if (ok) toast.success("GitHub App connected.", { description: ok });
    if (err) toast.error("GitHub App setup failed.", { description: err });
    url.searchParams.delete("connection_connected");
    url.searchParams.delete("connection_error");
    window.history.replaceState({}, "", url.pathname + url.search);
    invalidate();
    // `invalidate` closes over tRPC utils; the callback is intentionally
    // one-shot for URL params on first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const importIssue = trpc.github.importIssue.useMutation({
    onSuccess: (data) => {
      toast.success(data.created ? "GitHub issue imported." : "GitHub issue already linked.");
      setImporting(null);
      void utils.issue.list.invalidate();
      router.push(`/w/${ws.slug}/issues/${data.issueId}`);
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
    () => (connections ?? []).filter((c) => c.status === "CONNECTED" && !byConnection.has(c.id)),
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
      labelIds: [],
      github: defaultGitHubConfig(),
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
      labelIds: row.labelIds ?? [],
      github: readGitHubConfig(row.config),
    });
  }

  async function submit(): Promise<{ error?: string } | undefined> {
    if (!editing) return;
    if (!editing.connectionId) return { error: "Pick a connection." };
    if (!editing.target.trim()) return { error: "Target required." };
    const selected = (connections ?? []).find((c) => c.id === editing.connectionId);
    const config =
      selected?.provider === "GITHUB" && editing.kind === "repo"
        ? githubConfigForSave(editing.github)
        : undefined;
    try {
      if (editing.id) {
        await update.mutateAsync({
          id: editing.id,
          target: editing.target.trim(),
          direction: editing.direction,
          routeTo: editing.routeTo.trim() || null,
          labelIds: editing.labelIds,
          config,
        });
      } else {
        await create.mutateAsync({
          connectionId: editing.connectionId,
          kind: editing.kind,
          target: editing.target.trim(),
          direction: editing.direction,
          routeTo: editing.routeTo.trim() || undefined,
          labelIds: editing.labelIds,
          config,
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
            {isAdmin && (
              <a
                href={`/api/connections/github/install?returnTo=${encodeURIComponent(`/w/${ws.slug}/settings/connections`)}`}
                className="focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-subtle px-2 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Github className="h-3.5 w-3.5" />
                Install GitHub App
              </a>
            )}
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
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
          {/* Explainer banner */}
          <div className="rounded-md border border-border bg-card/40 p-3 text-[0.8125rem]">
            <div className="flex items-center gap-2">
              <PlugZap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">
                Identities live at your account. Workspaces decide what they map to.
              </span>
            </div>
            <p className="text-meta mt-1 text-muted-foreground">
              The same GitHub identity might post to{" "}
              <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">
                forge-platform/forge
              </code>{" "}
              in this workspace and{" "}
              <code className="rounded bg-subtle px-1 py-0.5 text-[10.5px]">bailey/axiom</code> in
              another — same token, different mapping.
            </p>
          </div>

          <GitHubReconciliationPolicy isAdmin={isAdmin} />

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
              labelById={labelById}
              isAdmin={isAdmin}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
              onAdd={() => openAdd(conn.id, defaultKindFor(conn.provider))}
              onEdit={openEdit}
              onImport={(row) =>
                setImporting({
                  mappingId: row.id,
                  repo: row.target,
                  number: "",
                  projectId: "",
                  queue: readGitHubConfig(row.config).queueOnCreate,
                })
              }
              onDelete={(row) => setDeleteTarget({ id: row.id, target: row.target })}
              onTogglePause={(row) =>
                update.mutate({
                  id: row.id,
                  status: row.status === "active" ? "paused" : "active",
                })
              }
              saving={update.isPending}
            />
          ))}

          {!mappingsLoading && hasAnyConnection && mappedConnections.length === 0 && (
            <EmptyState
              as="div"
              icon={GitBranch}
              title="No mappings yet"
              hint="Map one of your connected identities to a repo, channel, or webhook in this workspace using the section below."
            />
          )}

          <IntegrationAccessPanel isAdmin={isAdmin} />

          {/* Available identities */}
          <Section title="Available identities" hint="Connected globally but not mapped here yet.">
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
                      <span className="text-[0.8125rem] font-semibold">{meta.label}</span>
                      {c.account && (
                        <span className="text-meta ml-2 font-mono text-muted-foreground">
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
              {!connectionsLoading && hasAnyConnection && availableIdentities.length === 0 && (
                <div className="text-meta p-6 text-center text-muted-foreground">
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
                onChange={(e) => {
                  const connectionId = e.target.value;
                  const next = (connections ?? []).find((c) => c.id === connectionId);
                  setEditing({
                    ...editing,
                    connectionId,
                    kind: next ? defaultKindFor(next.provider) : editing.kind,
                    target: "",
                  });
                }}
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <QuickForm.Field label="Kind" required>
                <select
                  value={editing.kind}
                  disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value as MappingKind })}
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
            <QuickForm.Field label="Target" required hint={targetHint(editing.kind)}>
              {isGitHubRepoEditing && (installationRepos?.length ?? 0) > 0 ? (
                <select
                  value={editing.target}
                  onChange={(e) => setEditing({ ...editing, target: e.target.value })}
                  className="focus-ring h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm"
                  autoFocus
                >
                  <option value="">Pick a repository...</option>
                  {(installationRepos ?? []).map((repo) => (
                    <option key={repo.id} value={repo.full_name}>
                      {repo.full_name}
                      {repo.private ? " · private" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={editing.target}
                  onChange={(e) => setEditing({ ...editing, target: e.target.value })}
                  maxLength={400}
                  placeholder={targetPlaceholder(editing.kind)}
                  className="font-mono"
                  autoFocus
                />
              )}
              {isGitHubRepoEditing && installationReposLoading && (
                <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                  Loading GitHub installation repositories...
                </p>
              )}
            </QuickForm.Field>
            <QuickForm.Field
              label="Routes to"
              hint="Optional — where matched events go (e.g. Dispatch matrix, Chat · @victor)."
            >
              <Input
                value={editing.routeTo}
                onChange={(e) => setEditing({ ...editing, routeTo: e.target.value })}
                maxLength={200}
                placeholder="Dispatch matrix"
              />
            </QuickForm.Field>
            <QuickForm.Field
              label="Default labels"
              hint="Optional — applied to issues created from events on this mapping."
            >
              {(labels ?? []).length === 0 ? (
                <p className="text-[0.6875rem] text-muted-foreground">
                  No labels in this workspace yet.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(labels ?? []).map((l) => {
                    const selected = editing.labelIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() =>
                          setEditing({
                            ...editing,
                            labelIds: selected
                              ? editing.labelIds.filter((id) => id !== l.id)
                              : [...editing.labelIds, l.id],
                          })
                        }
                        className={
                          "text-meta inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 transition-colors " +
                          (selected
                            ? "border-ember/40 bg-ember/10 text-foreground"
                            : "border-dashed border-border bg-background text-muted-foreground")
                        }
                      >
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: l.color }}
                        />
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </QuickForm.Field>
            {isGitHubRepoEditing && (
              <GitHubMappingFields
                config={editing.github}
                statuses={statuses ?? []}
                projects={projects?.items ?? []}
                agents={agents ?? []}
                onChange={(github) => setEditing({ ...editing, github })}
              />
            )}
          </>
        )}
      </QuickForm>

      <QuickForm
        open={!!importing}
        onOpenChange={(v) => !v && setImporting(null)}
        title="Import GitHub issue"
        description={
          importing ? `Create or open the Forge issue sourced from ${importing.repo}.` : ""
        }
        primaryLabel="Import"
        loading={importIssue.isPending}
        onSubmit={async () => {
          if (!importing) return;
          const number = Number(importing.number);
          if (!Number.isInteger(number) || number <= 0) {
            return { error: "Issue number must be a positive integer." };
          }
          await importIssue.mutateAsync({
            mappingId: importing.mappingId,
            number,
            projectId: importing.projectId || null,
            queue: importing.queue,
          });
          return undefined;
        }}
      >
        {importing && (
          <>
            <QuickForm.Field label="Repository">
              <div className="rounded-md border border-border bg-subtle/40 px-2 py-1.5 font-mono text-xs">
                {importing.repo}
              </div>
            </QuickForm.Field>
            <QuickForm.Field label="GitHub issue number" required>
              <Input
                value={importing.number}
                onChange={(e) => setImporting({ ...importing, number: e.target.value })}
                inputMode="numeric"
                placeholder="123"
                className="font-mono"
                autoFocus
              />
            </QuickForm.Field>
            <QuickForm.Field label="Project">
              <select
                value={importing.projectId}
                onChange={(e) => setImporting({ ...importing, projectId: e.target.value })}
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Use mapping default</option>
                {(projects?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </QuickForm.Field>
            <label className="flex items-center gap-2 rounded-md border border-border bg-card/40 p-2 text-[0.8125rem]">
              <input
                type="checkbox"
                checked={importing.queue}
                onChange={(e) => setImporting({ ...importing, queue: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              Queue imported issue
            </label>
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

function GitHubMappingFields({
  config,
  statuses,
  projects,
  agents,
  onChange,
}: {
  config: GitHubMappingUiConfig;
  statuses: StatusRow[];
  projects: ProjectRow[];
  agents: AgentRow[];
  onChange: (config: GitHubMappingUiConfig) => void;
}) {
  const set = (patch: Partial<GitHubMappingUiConfig>) => onChange({ ...config, ...patch });
  const setRule = (key: GitHubStatusRuleKey, value: string) =>
    onChange({
      ...config,
      statusRules: { ...config.statusRules, [key]: value },
    });

  return (
    <>
      <QuickForm.Field
        label="GitHub sync policy"
        hint="Read-only against GitHub. These rules only create or update Forge issues."
      >
        <div className="space-y-2 rounded-md border border-border bg-card/40 p-2">
          <div className="flex items-center gap-2 border-b border-border/60 pb-2">
            <Github className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[0.8125rem] font-medium">Repository events</span>
          </div>
          <ToggleRow
            label="Create Forge issues from new GitHub issues"
            hint="Applies when GitHub sends an issues.opened webhook."
            checked={config.autoCreateIssues}
            onChange={(autoCreateIssues) => set({ autoCreateIssues })}
          />
          <ToggleRow
            label="Queue created issues"
            hint="Makes imported GitHub issues available to agent claim/dispatch."
            checked={config.queueOnCreate}
            onChange={(queueOnCreate) => set({ queueOnCreate })}
          />
          <ToggleRow
            label="Sync source issue titles"
            hint="Keeps Forge titles aligned for SOURCE links."
            checked={config.syncTitle}
            onChange={(syncTitle) => set({ syncTitle })}
          />
          <ToggleRow
            label="Mirror GitHub comments"
            hint="Creates Forge system comments for new GitHub comments."
            checked={config.syncComments}
            onChange={(syncComments) => set({ syncComments })}
          />
        </div>
      </QuickForm.Field>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <QuickForm.Field label="Default project">
          <select
            value={config.defaultProjectId}
            onChange={(e) => set({ defaultProjectId: e.target.value })}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">No default project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </QuickForm.Field>
        <QuickForm.Field label="Default priority">
          <select
            value={config.defaultPriority}
            onChange={(e) => set({ defaultPriority: e.target.value as PriorityValue })}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </QuickForm.Field>
      </div>

      <QuickForm.Field
        label="Assigned agent"
        hint="Optional — imported issues can start assigned to a known agent."
      >
        <select
          value={config.assignedAgentId}
          onChange={(e) => set({ assignedAgentId: e.target.value })}
          className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">No default agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              @{agent.profileKey} · {agent.name}
            </option>
          ))}
        </select>
      </QuickForm.Field>

      <QuickForm.Field
        label="Status rules"
        hint="Optional Forge status transitions driven by GitHub webhooks."
      >
        <div className="grid grid-cols-1 gap-2">
          {GITHUB_STATUS_RULES.map((rule) => (
            <label
              key={rule.key}
              className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)] items-center gap-2"
            >
              <span className="text-[0.8125rem] text-muted-foreground">{rule.label}</span>
              <select
                value={config.statusRules[rule.key]}
                onChange={(e) => setRule(rule.key, e.target.value)}
                className="focus-ring h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">No change</option>
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </QuickForm.Field>
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-border/60 bg-background/60 p-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <span className="min-w-0">
        <span className="block text-[0.8125rem] font-medium">{label}</span>
        <span className="block text-[0.6875rem] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function githubPolicyChips(row: MappingRow): string[] {
  const config = readGitHubConfig(row.config);
  const chips: string[] = [];
  if (config.autoCreateIssues) chips.push("auto-create");
  if (config.queueOnCreate) chips.push("queue");
  if (config.syncTitle) chips.push("sync title");
  if (config.syncComments) chips.push("comments");
  if (config.defaultProjectId) chips.push("project default");
  if (config.assignedAgentId) chips.push("agent default");
  const hasRules = GITHUB_STATUS_RULES.some((rule) => config.statusRules[rule.key]);
  if (hasRules) chips.push("status rules");
  return chips;
}

/* ── Per-connection mapping table ───────────────────────────────────── */
function ConnectionMappingSection({
  conn,
  rows,
  labelById,
  isAdmin,
  openMenuId,
  setOpenMenuId,
  onAdd,
  onEdit,
  onImport,
  onDelete,
  onTogglePause,
  saving,
}: {
  conn: ConnectionRow;
  rows: MappingRow[];
  labelById: Map<string, LabelRow>;
  isAdmin: boolean;
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  onAdd: () => void;
  onEdit: (row: MappingRow) => void;
  onImport: (row: MappingRow) => void;
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
        <div className="text-meta hidden grid-cols-[1.4fr_0.8fr_0.7fr_0.4fr_28px] items-center gap-3 border-b border-border bg-subtle/40 px-4 py-2 text-muted-foreground md:grid">
          <span>{conn.provider === "SLACK" ? "Channel" : "Target"}</span>
          <span>Routes to</span>
          <span>Direction</span>
          <span className="text-right">Status</span>
          <span />
        </div>

        {rows.map((m) => {
          const githubChips =
            conn.provider === "GITHUB" && m.kind === "repo" ? githubPolicyChips(m) : [];
          return (
            <div
              key={m.id}
              className="grid grid-cols-[minmax(0,1fr)_28px] items-start gap-x-3 gap-y-2 border-b border-border/60 px-4 py-3 last:border-b-0 md:grid-cols-[1.4fr_0.8fr_0.7fr_0.4fr_28px] md:items-center"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <KindIcon kind={m.kind as MappingKind} />
                  <span className="truncate font-mono text-[0.8125rem]">{m.target}</span>
                </span>
                {m.labelIds.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1">
                    {m.labelIds.map((id) => {
                      const l = labelById.get(id);
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-1 py-0.5 text-[10px] text-muted-foreground"
                        >
                          <span
                            aria-hidden
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ background: l?.color ?? "var(--admin-border)" }}
                          />
                          {l?.name ?? id.slice(0, 6)}
                        </span>
                      );
                    })}
                  </span>
                )}
                {githubChips.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1">
                    {githubChips.map((chip) => (
                      <span
                        key={chip}
                        className="inline-flex items-center rounded border border-border/60 bg-card/40 px-1 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {chip}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span className="col-span-2 flex items-center justify-between gap-3 text-[0.8125rem] text-muted-foreground md:col-auto md:block md:truncate">
                <span className="text-meta text-muted-foreground/70 md:hidden">Routes to</span>
                <span className="min-w-0 truncate">{m.routeTo || "—"}</span>
              </span>
              <span className="text-meta col-span-2 flex items-center justify-between gap-3 text-muted-foreground md:col-auto md:block">
                <span className="text-muted-foreground/70 md:hidden">Direction</span>
                <span>{directionLabel(m.direction as Direction)}</span>
              </span>
              <span className="col-span-2 flex items-center justify-between gap-3 text-right md:col-auto md:block">
                <span className="text-meta text-muted-foreground/70 md:hidden">Status</span>
                <span
                  className={
                    "text-meta inline-flex items-center gap-1 " +
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
              <div className="relative col-start-2 row-start-1 flex justify-end md:col-auto md:row-auto">
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
                    {conn.provider === "GITHUB" && m.kind === "repo" && (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          onImport(m);
                        }}
                        className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-subtle"
                      >
                        Import issue
                      </button>
                    )}
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
          );
        })}

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
      <span className="text-meta inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-success">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
        connected
      </span>
    );
  }
  if (status === "DEGRADED") {
    return (
      <span className="text-meta inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-warning">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />
        degraded
      </span>
    );
  }
  return (
    <span className="text-meta inline-flex items-center gap-1 rounded-md bg-subtle/40 px-1.5 py-0.5 text-muted-foreground">
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
