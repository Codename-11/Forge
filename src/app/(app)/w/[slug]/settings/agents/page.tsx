"use client";
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { useWorkspace } from "@/hooks/use-workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, SidePanel } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentQuickActions } from "@/components/agent-quick-actions";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Workspace-scoped agent registry.
 *
 * Agents are MCP-first actors — profile-keyed handles (like `victor`) that
 * hold their own ApiKeys, receive push dispatches, and can be assigned to
 * issues directly. This page is the admin surface for registering them,
 * tuning their webhooks, and retiring stale profiles. Mutations route
 * through `trpc.agent.*` which is admin-gated server-side.
 */

const PROFILE_KEY_RE = /^[a-z0-9][a-z0-9-_]*$/;

type EditingState = {
  id?: string;
  name: string;
  profileKey: string;
  description: string;
  avatar: string;
  webhookUrl: string;
  capabilitiesRaw: string;
  maxConcurrent: number;
  templateMarkdown: string;
};

const EMPTY_EDITING: EditingState = {
  name: "",
  profileKey: "",
  description: "",
  avatar: "",
  webhookUrl: "",
  capabilitiesRaw: "",
  maxConcurrent: 1,
  templateMarkdown: "",
};

const TEMPLATE_PLACEHOLDER = `### Context

### Acceptance criteria

### Constraints`;


export default function AgentsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: agents, refetch, isLoading } = trpc.agent.list.useQuery({
    includeArchived: true,
  });

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    profileKey: string;
    assigned: number;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    name: string;
    archived: boolean;
  } | null>(null);

  const invalidate = () => {
    utils.agent.list.invalidate();
    refetch();
  };

  const create = trpc.agent.create.useMutation({
    onSuccess: () => {
      toast.success("Agent created.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.agent.update.useMutation({
    onSuccess: () => {
      toast.success("Agent updated.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const archive = trpc.agent.archive.useMutation({
    onSuccess: () => {
      toast.success("Agent archived.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const unarchive = trpc.agent.unarchive.useMutation({
    onSuccess: () => {
      toast.success("Agent restored.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.agent.delete.useMutation({
    onSuccess: () => {
      toast.success("Agent deleted.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = create.isPending || update.isPending;
  const rows = useMemo(() => agents ?? [], [agents]);

  function parseCapabilities(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s.length <= 40),
      ),
    ).slice(0, 32);
  }

  function validate(e: EditingState): string | null {
    if (!e.name.trim()) return "Name required.";
    if (!PROFILE_KEY_RE.test(e.profileKey))
      return "profileKey must be lowercase letters, digits, `-` or `_` (start with a letter or digit).";
    if (e.webhookUrl.trim()) {
      try {
        new URL(e.webhookUrl.trim());
      } catch {
        return "Webhook URL must be a valid http(s) URL.";
      }
    }
    if (!Number.isFinite(e.maxConcurrent) || e.maxConcurrent < 0)
      return "maxConcurrent must be >= 0.";
    return null;
  }

  function submit() {
    if (!editing) return;
    const err = validate(editing);
    if (err) {
      toast.error(err);
      return;
    }
    const capabilities = parseCapabilities(editing.capabilitiesRaw);
    const webhookUrl = editing.webhookUrl.trim() || undefined;
    const description = editing.description.trim() || undefined;
    const avatar = editing.avatar.trim() || undefined;
    // Intentionally keep the raw value — trailing newlines are part of
    // the template shape. Only an all-whitespace string collapses to
    // "unset" so the null path clears the column.
    const templateRaw = editing.templateMarkdown;
    const templateMarkdown = templateRaw.trim().length > 0 ? templateRaw : undefined;
    if (editing.id) {
      update.mutate({
        id: editing.id,
        name: editing.name.trim(),
        description: description ?? null,
        avatar: avatar ?? null,
        webhookUrl: webhookUrl ?? null,
        capabilities,
        maxConcurrent: Math.floor(editing.maxConcurrent),
        templateMarkdown: templateMarkdown ?? null,
      });
    } else {
      create.mutate({
        name: editing.name.trim(),
        profileKey: editing.profileKey.trim(),
        description,
        avatar,
        webhookUrl,
        capabilities,
        maxConcurrent: Math.floor(editing.maxConcurrent),
        templateMarkdown,
      });
    }
  }

  return (
    <>
      <Topbar
        title="Agents"
        subtitle="MCP-first actors that hold keys and receive work."
        actions={
          <Button
            variant="ember"
            size="sm"
            onClick={() => setEditing({ ...EMPTY_EDITING })}
          >
            New agent
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            {rows.map((a) => {
              const isArchived = !!a.archivedAt;
              const assignedCount = a._count?.assignedIssues ?? 0;
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-start gap-3 px-4 py-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-sm">
                    {a.avatar ? (
                      <span aria-hidden>{a.avatar}</span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {a.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {a.name}
                      </span>
                      <span
                        className="font-mono text-[11px] text-muted-foreground"
                        title="Profile key — the stable cross-system handle. Matches the Hermes profile directory."
                      >
                        @{a.profileKey}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-sm bg-subtle px-1.5 py-0.5 text-[11px] font-medium">
                        <AgentPresenceDot
                          status={a.status}
                          size="sm"
                          pulse
                          lastHeartbeatAt={a.lastHeartbeatAt}
                        />
                        {a.status}
                      </span>
                      {isArchived && <Badge>archived</Badge>}
                    </div>
                    {a.description && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {a.description}
                      </div>
                    )}
                    <div
                      className="mt-2 flex flex-wrap items-center gap-1"
                      title="Capabilities are tags used by the dispatcher (CAPABILITY_MATCH mode) and PRIORITY_MATCH (a tag like 'urgent' qualifies for that priority)."
                    >
                      {a.capabilities.map((c) => (
                        <Badge key={c}>{c}</Badge>
                      ))}
                      {a.capabilities.length === 0 && (
                        <span className="text-[11px] text-muted-foreground/70">
                          No capabilities declared.
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span>
                        {assignedCount} assigned issue
                        {assignedCount === 1 ? "" : "s"}
                      </span>
                      <span>·</span>
                      <span>
                        {a.lastHeartbeatAt
                          ? `heartbeat ${relativeTime(a.lastHeartbeatAt)}`
                          : "no heartbeat yet"}
                      </span>
                      {a.maxConcurrent !== 1 && (
                        <>
                          <span>·</span>
                          <span className="font-mono">
                            max {a.maxConcurrent}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <AgentQuickActions
                      agentId={a.id}
                      profileKey={a.profileKey}
                      name={a.name}
                      status={a.status}
                    />
                    <Link href={`/w/${ws.slug}/agents/${a.profileKey}`}>
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setEditing({
                          id: a.id,
                          name: a.name,
                          profileKey: a.profileKey,
                          description: a.description ?? "",
                          avatar: a.avatar ?? "",
                          webhookUrl: a.webhookUrl ?? "",
                          capabilitiesRaw: a.capabilities.join(", "),
                          maxConcurrent: a.maxConcurrent,
                          templateMarkdown: a.templateMarkdown ?? "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setArchiveTarget({
                          id: a.id,
                          name: a.name,
                          archived: isArchived,
                        })
                      }
                    >
                      {isArchived ? "Restore" : "Archive"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDeleteTarget({
                          id: a.id,
                          name: a.name,
                          profileKey: a.profileKey,
                          assigned: assignedCount,
                        })
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
            {!isLoading && rows.length === 0 && (
              <EmptyState
                icon={Bot}
                title="No agents yet"
                hint="Register an agent profile so it can hold keys, claim issues, and receive push dispatches."
                action={
                  <Button
                    variant="ember"
                    size="sm"
                    onClick={() => setEditing({ ...EMPTY_EDITING })}
                  >
                    Create your first agent
                  </Button>
                }
              />
            )}
          </Card>
        </div>
      </div>

      <SidePanel
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        title={editing?.id ? "Edit agent" : "New agent"}
        description={
          editing?.id
            ? "profileKey is immutable — create a new agent to change it."
            : "The profileKey is the stable cross-system handle (e.g. `victor`)."
        }
        primaryLabel={editing?.id ? "Save" : "Create"}
        onPrimary={submit}
        secondaryLabel="Cancel"
        loading={pending}
      >
        {editing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="space-y-3.5"
          >
            <Field label="Name" required>
              <Input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                maxLength={120}
                placeholder="Victor"
                autoFocus
              />
            </Field>
            <Field
              label="Profile key"
              hint={
                editing.id
                  ? "Cannot be changed after creation."
                  : "Lowercase letters, digits, `-` or `_`. Matches the Hermes profile directory."
              }
              required
            >
              <Input
                value={editing.profileKey}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    profileKey: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]/g, ""),
                  })
                }
                maxLength={40}
                placeholder="victor"
                className="font-mono"
                disabled={!!editing.id}
              />
            </Field>
            <Field label="Description">
              <textarea
                value={editing.description}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
                maxLength={2000}
                rows={3}
                placeholder="Lead architect; triages incoming platform work."
                className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
              />
            </Field>
            <Field
              label="Avatar"
              hint="Short text or emoji shown in pickers (optional)."
            >
              <Input
                value={editing.avatar}
                onChange={(e) =>
                  setEditing({ ...editing, avatar: e.target.value })
                }
                maxLength={200}
                placeholder="🔷"
              />
            </Field>
            <Field
              label="Webhook URL"
              hint="Forge POSTs dispatch events here (AGENT_ASSIGNED, COMMENT_CREATED, ISSUE_PRIORITY_CHANGED) signed with the per-agent secret. Hermes' webhook adapter format is http://<host>:<port>/webhooks/<route>. Leave blank for pull-only agents that poll via MCP — those won't get push presence either."
            >
              <Input
                type="url"
                value={editing.webhookUrl}
                onChange={(e) =>
                  setEditing({ ...editing, webhookUrl: e.target.value })
                }
                maxLength={500}
                placeholder="http://<internal-host>:8644/webhooks/forge-dispatch"
              />
            </Field>
            <Field
              label="Capabilities"
              hint="Comma-separated tags (e.g. `triage, architecture`). Used by CAPABILITY_MATCH dispatch (intersect with issue labels) and PRIORITY_MATCH (e.g. 'urgent' tag → eligible for URGENT). Max 32."
            >
              <Input
                value={editing.capabilitiesRaw}
                onChange={(e) =>
                  setEditing({ ...editing, capabilitiesRaw: e.target.value })
                }
                placeholder="triage, architecture, code-review"
              />
            </Field>
            <Field
              label="Max concurrent"
              hint="Upper bound on simultaneously-assigned active issues. 0 disables new assignments entirely (existing ones unchanged)."
            >
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                value={editing.maxConcurrent}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    maxConcurrent: Number.parseInt(e.target.value || "0", 10),
                  })
                }
                className="w-28"
              />
            </Field>
            <Field
              label="Issue template"
              hint="Markdown auto-applied to an issue's description on assignment, only when the description is empty."
            >
              <textarea
                value={editing.templateMarkdown}
                onChange={(e) =>
                  setEditing({ ...editing, templateMarkdown: e.target.value })
                }
                rows={8}
                placeholder={TEMPLATE_PLACEHOLDER}
                className="focus-ring w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
              />
            </Field>
            {/* Submit via Enter anywhere in the form. */}
            <button type="submit" className="sr-only" aria-hidden>
              submit
            </button>
          </form>
        )}
      </SidePanel>

      <Confirm
        open={!!archiveTarget}
        onOpenChange={(v) => !v && setArchiveTarget(null)}
        title={
          archiveTarget?.archived
            ? `Restore ${archiveTarget.name}?`
            : `Archive ${archiveTarget?.name}?`
        }
        description={
          archiveTarget?.archived
            ? "The agent returns to the active list and can receive new work."
            : "The agent is hidden from pickers and marked offline. Assignments remain; restore later to resume."
        }
        primaryLabel={archiveTarget?.archived ? "Restore" : "Archive"}
        loading={archive.isPending || unarchive.isPending}
        onConfirm={async () => {
          if (!archiveTarget) return;
          if (archiveTarget.archived) {
            await unarchive.mutateAsync({ id: archiveTarget.id });
          } else {
            await archive.mutateAsync({ id: archiveTarget.id });
          }
          setArchiveTarget(null);
        }}
      />

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete agent "${deleteTarget?.name}"?`}
        description={
          deleteTarget && deleteTarget.assigned > 0
            ? `This agent is assigned to ${deleteTarget.assigned} issue${
                deleteTarget.assigned === 1 ? "" : "s"
              }. Those issues will lose their agent assignment. This cannot be undone — consider archiving instead.`
            : "Removes the agent profile, its keys, and any webhook registration. Cannot be undone."
        }
        primaryLabel="Delete"
        typeToConfirm={
          deleteTarget && deleteTarget.assigned > 0
            ? deleteTarget.profileKey
            : undefined
        }
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

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        {required && <span className="text-ember">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
