"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Route, GripVertical, MoreHorizontal } from "lucide-react";
import { MentionEngagementPolicy, Priority } from "@prisma/client";
import type { EngagementMode } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { PriorityGlyph } from "@/components/ui/priority-glyph";
import {
  EngagementModeGlyph,
  MODE_LABEL,
  MODE_SUBTITLE,
  MODE_ORDER,
  type EngagementModeValue,
} from "@/components/ui/engagement-mode-glyph";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";

/**
 * Admin-gated surface for the dispatch rules engine. Rules are a
 * declarative routing layer consulted before the mode-based picker —
 * first match wins, ineligible-target rules fall through to mode.
 *
 * Reorder uses the same drag-n-drop pattern as the Statuses page so the
 * feel matches; arrow-button fallback would be a second UI pattern to
 * learn, and the existing one already supports keyboard focus via the
 * native draggable contract. Conditions are nullable = "any"; explicit
 * selects handle the null encoding.
 */

const ANY = "__any__";

const PRIORITY_OPTIONS: { label: string; value: Priority | null }[] = [
  { label: "Any", value: null },
  { label: "Urgent", value: Priority.URGENT },
  { label: "High", value: Priority.HIGH },
  { label: "Medium", value: Priority.MEDIUM },
  { label: "Low", value: Priority.LOW },
  { label: "None", value: Priority.NONE },
];

type EditingState = {
  id?: string;
  name: string;
  priority: Priority | null;
  labelId: string | null;
  projectId: string | null;
  targetAgentId: string;
};

const EMPTY_EDITING: EditingState = {
  name: "",
  priority: null,
  labelId: null,
  projectId: null,
  targetAgentId: "",
};

// Human-readable labels for the workspace auto-dispatch (fall-through)
// modes. The page can read the current mode from `workspace.current`,
// but the `workspace.update` mutation does not (yet) accept
// `autoDispatchMode`, so the fall-through control is rendered read-only
// — see the "Fall-through" section below. Setting it lives under
// Settings → Workspace.
const FALL_THROUGH_OPTIONS: { value: string; label: string }[] = [
  { value: "ROUND_ROBIN", label: "Round robin" },
  { value: "CAPABILITY_MATCH", label: "Capability match" },
  { value: "PRIORITY_MATCH", label: "Priority match" },
  { value: "MANUAL_ONLY", label: "Manual only" },
];

const MENTION_POLICY_OPTIONS: {
  value: MentionEngagementPolicy;
  label: string;
  hint: string;
}[] = [
  {
    value: MentionEngagementPolicy.INFER,
    label: "Infer",
    hint: "No marker → the agent infers intent and asks before anything irreversible.",
  },
  {
    value: MentionEngagementPolicy.FIXED,
    label: "Fixed",
    hint: "Always use the mention default mode regardless of the comment text.",
  },
  {
    value: MentionEngagementPolicy.REQUIRE_MARKER,
    label: "Require marker",
    hint: "Execution needs an explicit marker; otherwise treat as Discuss.",
  },
];

const RESOLUTION_HELP = [
  "An issue enters the dispatch queue without an assigned agent.",
  "Forge walks the enabled rules top-to-bottom. A rule matches only if every non-'any' condition (priority, label, project) matches the issue.",
  "The first matching rule's target agent claims the issue — even if that agent isn't otherwise eligible under the workspace mode.",
  "If no rule matches, the issue falls through to the workspace's auto-dispatch mode (set under Settings → Workspace).",
];

type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  priority: Priority | null;
  labelId: string | null;
  projectId: string | null;
  targetAgentId: string;
  label: { id: string; name: string; color: string } | null;
  project: { id: string; name: string; key: string } | null;
  targetAgent: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
    status: string;
  };
};

export default function DispatchRulesPage() {
  const utils = trpc.useUtils();
  const { data: rules, isLoading, refetch } =
    trpc.dispatchRule.list.useQuery();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: labels } = trpc.label.list.useQuery();
  const { data: projectPage } = trpc.project.list.useQuery({
    archived: false,
    limit: 500,
  });
  const { data: workspace } = trpc.workspace.current.useQuery();

  // Local mirror of the rule list so drag reorder can be optimistic.
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (rules) setRows(rules as RuleRow[]);
  }, [rules]);

  // Close the per-row kebab menu on any outside click / Escape.
  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuId(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  const invalidate = () => {
    utils.dispatchRule.list.invalidate();
    refetch();
  };

  const create = trpc.dispatchRule.create.useMutation({
    onSuccess: () => {
      toast.success("Rule created.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.dispatchRule.update.useMutation({
    onSuccess: () => {
      toast.success("Rule updated.");
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const reorder = trpc.dispatchRule.reorder.useMutation({
    onSuccess: () => refetch(),
    onError: (e) => {
      toast.error(e.message);
      refetch();
    },
  });
  const toggle = trpc.dispatchRule.toggle.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.dispatchRule.delete.useMutation({
    onSuccess: () => {
      toast.success("Rule deleted.");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Engagement-mode config lives on the Workspace row; the
  // `workspace.update` mutation persists it. Optimistically reflect the
  // chosen value through `workspace.current`.
  const updateWorkspace = trpc.workspace.update.useMutation({
    onSuccess: () => {
      toast.success("Engagement defaults saved.");
      utils.workspace.current.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = create.isPending || update.isPending;

  const activeAgents = useMemo(() => agents ?? [], [agents]);
  const labelsById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; color: string }>();
    for (const l of labels ?? []) m.set(l.id, l);
    return m;
  }, [labels]);
  const projectsById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; key: string }>();
    for (const p of projectPage?.items ?? []) m.set(p.id, p);
    return m;
  }, [projectPage]);

  function commitOrder(next: RuleRow[]) {
    setRows(next);
    reorder.mutate({ ids: next.map((r) => r.id) });
  }
  function onDragStart(id: string) {
    setDragId(id);
  }
  function onDragOver(targetId: string, e: React.DragEvent) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const from = rows.findIndex((r) => r.id === dragId);
    const to = rows.findIndex((r) => r.id === targetId);
    if (from === -1 || to === -1) return;
    const next = rows.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRows(next);
  }
  function onDrop() {
    if (dragId) commitOrder(rows);
    setDragId(null);
  }

  function openEdit(row: RuleRow) {
    setEditing({
      id: row.id,
      name: row.name,
      priority: row.priority,
      labelId: row.labelId,
      projectId: row.projectId,
      targetAgentId: row.targetAgentId,
    });
  }

  async function submit(): Promise<{ error?: string } | undefined> {
    if (!editing) return;
    if (!editing.name.trim()) {
      return { error: "Name required." };
    }
    if (!editing.targetAgentId) {
      return { error: "Target agent required." };
    }
    try {
      if (editing.id) {
        await update.mutateAsync({
          id: editing.id,
          name: editing.name.trim(),
          priority: editing.priority,
          labelId: editing.labelId,
          projectId: editing.projectId,
          targetAgentId: editing.targetAgentId,
        });
      } else {
        await create.mutateAsync({
          name: editing.name.trim(),
          priority: editing.priority,
          labelId: editing.labelId,
          projectId: editing.projectId,
          targetAgentId: editing.targetAgentId,
        });
      }
      return undefined;
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "Failed to save rule.",
      };
    }
  }

  return (
    <>
      <Topbar
        title="Dispatch rules"
        subtitle="Pin agents by priority, label, or project. Rules run before auto-dispatch — first match wins, drag to reorder. Ineligible targets fall through to the workspace dispatch mode."
        actions={
          <Button
            variant="ember"
            size="sm"
            onClick={() => setEditing({ ...EMPTY_EDITING })}
            disabled={activeAgents.length === 0}
            title={
              activeAgents.length === 0
                ? "Register an agent first."
                : undefined
            }
          >
            New rule
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          {!isLoading && rows.length === 0 ? (
            <Section
              title="Routing matrix"
              hint="Pin specific work to specific agents. Each rule maps a condition — priority, label, and/or project — to a target agent."
            >
              <EmptyState
                as="div"
                icon={Route}
                title="No dispatch rules yet"
                hint="Dispatch rules route incoming issues to a chosen agent before the workspace's auto-dispatch mode runs. A rule matches on priority, label, and/or project (any field left as 'any' is a wildcard); the first enabled rule that matches claims the issue. Unmatched issues fall through to the workspace dispatch mode."
                action={
                  <Button
                    variant="ember"
                    size="sm"
                    onClick={() => setEditing({ ...EMPTY_EDITING })}
                    disabled={activeAgents.length === 0}
                    title={
                      activeAgents.length === 0
                        ? "Register an agent first."
                        : undefined
                    }
                  >
                    Create your first rule
                  </Button>
                }
              />
              {activeAgents.length === 0 && (
                <p className="mt-2 text-center text-[0.6875rem] text-muted-foreground">
                  Register an agent under Settings → Agents before adding a rule.
                </p>
              )}
            </Section>
          ) : (
            <Section
              title="Routing matrix"
              hint="Read top-to-bottom — the first enabled rule that matches an issue claims it. Drag a row to reorder priority. Toggle a rule off to keep it without firing."
              actions={
                rows.length > 0 ? (
                  <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
                    {rows.length} rule{rows.length === 1 ? "" : "s"}
                  </span>
                ) : undefined
              }
            >
              <Card as="div" className="overflow-hidden">
                {/* Columnar header row. Grid template is shared with each
                    rule row below so columns line up. */}
                <div className="grid grid-cols-[28px_28px_1fr_120px_140px_120px_180px_36px] gap-3 border-b border-border bg-card/30 px-4 py-2 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  <span aria-hidden />
                  <span>On</span>
                  <span>Name</span>
                  <span>Priority</span>
                  <span>Label</span>
                  <span>Project</span>
                  <span>Target agent</span>
                  <span aria-hidden />
                </div>
                <ul
                  className="divide-y divide-border/60"
                  onDrop={onDrop}
                  onDragOver={(e: React.DragEvent) => e.preventDefault()}
                >
                  {rows.map((r) => {
                    const label =
                      r.label ??
                      (r.labelId ? labelsById.get(r.labelId) ?? null : null);
                    const project =
                      r.project ??
                      (r.projectId
                        ? projectsById.get(r.projectId) ?? null
                        : null);
                    return (
                      <li
                        key={r.id}
                        draggable
                        onDragStart={() => onDragStart(r.id)}
                        onDragOver={(e) => onDragOver(r.id, e)}
                        onDragEnd={() => setDragId(null)}
                        className={
                          "group grid grid-cols-[28px_28px_1fr_120px_140px_120px_180px_36px] items-center gap-3 px-4 py-2.5 " +
                          (dragId === r.id ? "opacity-50" : "")
                        }
                      >
                        {/* Drag handle */}
                        <GripVertical
                          size={13}
                          aria-hidden
                          className="cursor-grab text-muted-foreground/50 opacity-0 group-hover:opacity-100"
                        />
                        {/* Ember toggle switch — same enable mutation */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={r.enabled}
                          aria-label={
                            r.enabled ? "Disable rule" : "Enable rule"
                          }
                          onClick={() =>
                            toggle.mutate({ id: r.id, enabled: !r.enabled })
                          }
                          className={
                            "focus-ring inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors " +
                            (r.enabled ? "bg-ember" : "bg-subtle")
                          }
                        >
                          <span
                            className={
                              "inline-block h-3 w-3 rounded-full bg-background transition-transform " +
                              (r.enabled
                                ? "translate-x-3.5"
                                : "translate-x-0.5")
                            }
                          />
                        </button>
                        {/* Name */}
                        <span className="truncate text-sm" title={r.name}>
                          {r.name}
                        </span>
                        {/* Priority */}
                        <span className="text-meta">
                          {r.priority ? (
                            <span className="inline-flex items-center gap-1">
                              <PriorityGlyph priority={r.priority} />{" "}
                              {r.priority.toLowerCase()}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">any</span>
                          )}
                        </span>
                        {/* Label chip */}
                        <span className="text-meta">
                          {label ? (
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-meta">
                              <span
                                aria-hidden
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ background: label.color }}
                              />
                              <span className="truncate">{label.name}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">any</span>
                          )}
                        </span>
                        {/* Project */}
                        <span className="text-meta">
                          {project ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                aria-hidden
                                className="inline-block h-2 w-2 rounded-sm bg-muted-foreground/60"
                              />
                              <span className="font-mono">{project.key}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">any</span>
                          )}
                        </span>
                        {/* Target agent */}
                        <span className="flex items-center gap-1.5 text-meta">
                          {r.targetAgent.avatar ? (
                            <span style={{ fontSize: 12 }}>
                              {r.targetAgent.avatar}
                            </span>
                          ) : null}
                          <span className="truncate font-mono">
                            @{r.targetAgent.profileKey}
                          </span>
                        </span>
                        {/* Kebab — edit / delete */}
                        <div className="relative">
                          <button
                            type="button"
                            aria-label="Rule actions"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId((id) =>
                                id === r.id ? null : r.id,
                              );
                            }}
                            className="focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-subtle hover:text-foreground group-hover:opacity-100 data-[open=true]:opacity-100"
                            data-open={openMenuId === r.id}
                          >
                            <MoreHorizontal size={12} />
                          </button>
                          {openMenuId === r.id && (
                            <div
                              role="menu"
                              onClick={(e) => e.stopPropagation()}
                              className="absolute right-0 top-7 z-10 w-32 overflow-hidden rounded-md border border-border bg-card py-1 shadow-md"
                            >
                              <button
                                role="menuitem"
                                type="button"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  openEdit(r);
                                }}
                                className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-subtle"
                              >
                                Edit
                              </button>
                              <button
                                role="menuitem"
                                type="button"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setDeleteTarget({ id: r.id, name: r.name });
                                }}
                                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-danger hover:bg-subtle"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </Section>
          )}

          {/* Engagement modes — what kind of work a dispatched agent is
              asked to do. Persisted on the Workspace row via
              `workspace.update`. See docs/agents/engagement-modes.md. */}
          <Section
            title="Engagement modes"
            hint="The intent handed to an agent at dispatch time — what it's asked to do, separate from which agent gets picked. Assignments default to one mode; @-mentions follow a policy."
          >
            <Card as="div" className="space-y-5 p-5">
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">Assignment default</span>
                  <span className="text-meta text-muted-foreground">
                    Used when an issue is assigned or queued.
                  </span>
                </div>
                <ModeSegmented
                  value={
                    (workspace?.assignmentEngagementMode as EngagementModeValue) ??
                    "EXECUTE"
                  }
                  disabled={updateWorkspace.isPending}
                  onChange={(mode) =>
                    updateWorkspace.mutate({ assignmentEngagementMode: mode })
                  }
                />
              </div>

              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">Mention policy</span>
                  <span className="text-meta text-muted-foreground">
                    How an @-mention without an explicit marker is handled.
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Mention policy"
                  className="inline-flex rounded-md border border-border bg-card/30 p-0.5"
                >
                  {MENTION_POLICY_OPTIONS.map((o) => {
                    const active =
                      (workspace?.mentionEngagementPolicy ?? "INFER") === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={updateWorkspace.isPending}
                        onClick={() =>
                          updateWorkspace.mutate({
                            mentionEngagementPolicy: o.value,
                          })
                        }
                        title={o.hint}
                        className={
                          "focus-ring rounded-[0.3125rem] px-3 py-1 text-xs transition-colors " +
                          (active
                            ? "bg-ember text-ember-foreground"
                            : "text-muted-foreground hover:text-foreground")
                        }
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-meta text-muted-foreground">
                  {MENTION_POLICY_OPTIONS.find(
                    (o) =>
                      o.value === (workspace?.mentionEngagementPolicy ?? "INFER"),
                  )?.hint}
                </p>
              </div>

              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm">Mention default mode</span>
                  <span className="text-meta text-muted-foreground">
                    The mode a mention starts from (under Infer / Fixed).
                  </span>
                </div>
                <ModeSegmented
                  value={
                    (workspace?.mentionDefaultMode as EngagementModeValue) ??
                    "DISCUSS"
                  }
                  disabled={updateWorkspace.isPending}
                  onChange={(mode) =>
                    updateWorkspace.mutate({ mentionDefaultMode: mode })
                  }
                />
              </div>
            </Card>
          </Section>

          {/* Fall-through mode. The current value comes from
              `workspace.current` (which exposes `autoDispatchMode`), but
              `workspace.update` does not accept `autoDispatchMode`, so this
              is rendered read-only — changing it lives under Settings →
              Workspace. Wiring an inline mutation would require a new
              backend field, which is out of scope here. */}
          <Section
            title="Fall-through"
            hint="What happens when no rule matches. Set the mode under Settings → Workspace."
          >
            <Card as="div" className="space-y-2 p-5">
              <div
                role="radiogroup"
                aria-label="Fall-through mode (read-only)"
                aria-readonly="true"
                className="inline-flex rounded-md border border-border bg-card/30 p-0.5"
              >
                {FALL_THROUGH_OPTIONS.map((o) => {
                  const active = workspace?.autoDispatchMode === o.value;
                  return (
                    <span
                      key={o.value}
                      role="radio"
                      aria-checked={active}
                      className={
                        "rounded-[0.3125rem] px-3 py-1 text-xs transition-colors " +
                        (active
                          ? "bg-ember text-ember-foreground"
                          : "text-muted-foreground")
                      }
                    >
                      {o.label}
                    </span>
                  );
                })}
              </div>
              <p className="text-meta text-muted-foreground">
                Unmatched issues fall through to the workspace&rsquo;s
                auto-dispatch mode. This reflects the current setting; change
                it under Settings &rarr; Workspace.
              </p>
            </Card>
          </Section>

          <Section
            title="How rules resolve"
            hint="The order rules and auto-dispatch interact when a new issue needs an owner."
          >
            <Card as="div" className="divide-y divide-border">
              {RESOLUTION_HELP.map((step, i) => (
                <div key={i} className="flex gap-3 px-4 py-3">
                  <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-subtle font-mono text-[0.625rem] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {step}
                  </span>
                </div>
              ))}
            </Card>
          </Section>
        </div>
      </div>

      <QuickForm
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        title={editing?.id ? "Edit dispatch rule" : "New dispatch rule"}
        description="All non-'any' conditions must match the issue. First enabled rule (by order) that matches wins."
        primaryLabel={editing?.id ? "Save" : "Create"}
        loading={pending}
        onSubmit={submit}
      >
        {editing && (
          <>
            <Field label="Name" required>
              <Input
                value={editing.name}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
                maxLength={120}
                placeholder="urgent ops → mizu"
                autoFocus
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Priority">
                <select
                  value={editing.priority ?? ANY}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      priority:
                        e.target.value === ANY
                          ? null
                          : (e.target.value as Priority),
                    })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITY_OPTIONS.map((p) => (
                    <option key={p.value ?? ANY} value={p.value ?? ANY}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Label">
                <select
                  value={editing.labelId ?? ANY}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      labelId: e.target.value === ANY ? null : e.target.value,
                    })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value={ANY}>Any</option>
                  {(labels ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Project">
                <select
                  value={editing.projectId ?? ANY}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      projectId:
                        e.target.value === ANY ? null : e.target.value,
                    })
                  }
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value={ANY}>Any</option>
                  {(projectPage?.items ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Target agent" required>
              <select
                value={editing.targetAgentId}
                onChange={(e) =>
                  setEditing({ ...editing, targetAgentId: e.target.value })
                }
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Pick an agent…</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} (@{a.profileKey})
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </QuickForm>

      <Confirm
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        variant="destructive"
        title={`Delete rule "${deleteTarget?.name}"?`}
        description="The rule stops firing immediately. Existing assignments made via this rule are not reverted."
        primaryLabel="Delete"
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

/**
 * ModeSegmented — segmented control over the four engagement modes, each
 * option showing its glyph + label + one-line subtext. Shared shape with the
 * assign-popover picker so the feel matches.
 */
function ModeSegmented({
  value,
  onChange,
  disabled,
}: {
  value: EngagementModeValue;
  onChange: (mode: EngagementMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Engagement mode"
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {MODE_ORDER.map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(m as EngagementMode)}
            className={
              "focus-ring flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition-colors " +
              (active
                ? "border-ember/60 bg-ember/10"
                : "border-border bg-card/30 hover:bg-subtle")
            }
          >
            <span className="flex items-center gap-1.5">
              <EngagementModeGlyph mode={m} size={12} />
              <span className="text-xs">{MODE_LABEL[m]}</span>
            </span>
            <span className="text-[0.625rem] text-muted-foreground">
              {MODE_SUBTITLE[m]}
            </span>
          </button>
        );
      })}
    </div>
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
    <QuickForm.Field label={label} required={required} hint={hint}>
      {children}
    </QuickForm.Field>
  );
}
