"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Route } from "lucide-react";
import { Priority } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
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

  // Local mirror of the rule list so drag reorder can be optimistic.
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (rules) setRows(rules as RuleRow[]);
  }, [rules]);

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
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card
            onDrop={onDrop}
            onDragOver={(e: React.DragEvent) => e.preventDefault()}
          >
            {rows.map((r) => {
              const label = r.label ?? (r.labelId ? labelsById.get(r.labelId) ?? null : null);
              const project =
                r.project ??
                (r.projectId ? projectsById.get(r.projectId) ?? null : null);
              return (
                <li
                  key={r.id}
                  draggable
                  onDragStart={() => onDragStart(r.id)}
                  onDragOver={(e) => onDragOver(r.id, e)}
                  onDragEnd={() => setDragId(null)}
                  className={
                    "flex flex-wrap items-center gap-3 px-4 py-3 " +
                    (dragId === r.id
                      ? "cursor-grabbing opacity-50"
                      : "cursor-grab")
                  }
                >
                  <span
                    className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground"
                    aria-hidden
                  >
                    ⋮⋮
                  </span>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    {String(r.order).padStart(2, "0")}
                  </span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        toggle.mutate({ id: r.id, enabled: e.target.checked })
                      }
                      className="focus-ring h-3.5 w-3.5 cursor-pointer"
                    />
                    <span>{r.enabled ? "on" : "off"}</span>
                  </label>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="truncate text-sm font-medium">
                      {r.name}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                      <span>if</span>
                      <Badge>
                        priority={" "}
                        <span className="font-mono">
                          {r.priority ?? "any"}
                        </span>
                      </Badge>
                      <Badge color={label?.color}>
                        label={" "}
                        <span className="font-mono">
                          {label?.name ?? "any"}
                        </span>
                      </Badge>
                      <Badge>
                        project={" "}
                        <span className="font-mono">
                          {project?.key ?? "any"}
                        </span>
                      </Badge>
                      <span>→</span>
                      <Badge>
                        {r.targetAgent.avatar ? `${r.targetAgent.avatar} ` : ""}
                        <span className="font-mono">
                          @{r.targetAgent.profileKey}
                        </span>
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(r)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDeleteTarget({ id: r.id, name: r.name })
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
                icon={Route}
                title="No dispatch rules"
                hint="Add a rule to pin an agent by priority, label, or project. Rules run before the mode-based picker."
                action={
                  <Button
                    variant="ember"
                    size="sm"
                    onClick={() => setEditing({ ...EMPTY_EDITING })}
                    disabled={activeAgents.length === 0}
                  >
                    Create your first rule
                  </Button>
                }
              />
            )}
          </Card>
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
