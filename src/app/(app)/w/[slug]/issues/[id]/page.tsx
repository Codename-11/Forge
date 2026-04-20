"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { formatDate, formatIssueId, relativeTime } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";
import { useWorkspace } from "@/hooks/use-workspace";
import { IssueRelationsPanel } from "@/components/relations/issue-relations-panel";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: issue, isLoading, error } = trpc.issue.byId.useQuery({ id });
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: allLabels } = trpc.label.list.useQuery();
  const timePrefs = useTimePrefs();
  const utils = trpc.useUtils();

  const update = trpc.issue.update.useMutation({
    onMutate: async (input) => {
      await utils.issue.byId.cancel({ id: input.id });
      const prev = utils.issue.byId.getData({ id: input.id });
      utils.issue.byId.setData({ id: input.id }, (old) => {
        if (!old) return old;
        return { ...old, ...input } as typeof old;
      });
      return { prev };
    },
    onError: (err, input, ctx) => {
      if (ctx?.prev) utils.issue.byId.setData({ id: input.id }, ctx.prev);
      toast.error(err.message);
    },
    onSettled: () => utils.issue.byId.invalidate({ id }),
  });

  const assign = trpc.issue.assign.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id });
      utils.issue.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setLabels = trpc.label.setForIssue.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id }),
    onError: (e) => toast.error(e.message),
  });

  const setQueued = trpc.issue.setQueued.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id }),
    onError: (e) => toast.error(e.message),
  });

  const releaseClaim = trpc.issue.release.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id }),
    onError: (e) => toast.error(e.message),
  });

  const softDelete = trpc.issue.softDelete.useMutation({
    onSuccess: () => {
      toast.success("Issue deleted.");
      utils.issue.list.invalidate();
      router.push(`/w/${slug}/issues`);
    },
    onError: (e) => toast.error(e.message),
  });

  const createComment = trpc.comment.create.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id });
      setCommentDraft("");
    },
  });

  const [commentDraft, setCommentDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);

  useEffect(() => {
    if (issue && !editingTitle) setTitleDraft(issue.title);
    if (issue && !editingDesc) setDescDraft(issue.description ?? "");
  }, [issue, editingTitle, editingDesc]);

  if (error)
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {error.message}
      </div>
    );
  if (isLoading || !issue)
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  return (
    <>
      <Topbar
        title={ws ? formatIssueId(ws.key, issue.number) : "Issue"}
        subtitle={<span className="font-mono text-[10px]">{issue.status.name}</span>}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${slug}/focus/${id}`)}
              title="Fullscreen, distraction-free"
            >
              Focus
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm("Delete this issue?")) softDelete.mutate({ id });
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_300px] overflow-hidden">
        <div className="min-w-0 overflow-y-auto px-8 py-6">
          {editingTitle ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (titleDraft.trim() && titleDraft !== issue.title)
                  update.mutate({ id: issue.id, title: titleDraft.trim() });
                setEditingTitle(false);
              }}
            >
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (titleDraft.trim() && titleDraft !== issue.title)
                    update.mutate({ id: issue.id, title: titleDraft.trim() });
                  setEditingTitle(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setTitleDraft(issue.title);
                    setEditingTitle(false);
                  }
                }}
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-xl font-semibold tracking-tight"
              />
            </form>
          ) : (
            <h1
              className="cursor-text rounded-md px-1 py-0.5 text-xl font-semibold tracking-tight hover:bg-subtle/60"
              onClick={() => setEditingTitle(true)}
              title="Click to edit"
            >
              {issue.title}
            </h1>
          )}

          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar name={issue.author.name} image={issue.author.image} size={16} />
            <span>{issue.author.name ?? "Unknown"}</span>
            <span>·</span>
            <span title={formatDate(issue.createdAt, timePrefs)}>
              {relativeTime(issue.createdAt)}
            </span>
          </div>

          <section className="mt-6">
            {editingDesc ? (
              <div className="space-y-2">
                <textarea
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  rows={8}
                  placeholder="Description (Markdown-flavored)"
                  className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
                />
                <div className="flex gap-2">
                  <Button
                    variant="ember"
                    size="sm"
                    onClick={() => {
                      update.mutate({
                        id: issue.id,
                        description: descDraft.trim() || null,
                      });
                      setEditingDesc(false);
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDescDraft(issue.description ?? "");
                      setEditingDesc(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <article
                className="prose prose-sm max-w-none cursor-text whitespace-pre-wrap rounded-md px-1 py-0.5 text-[13px] leading-relaxed text-foreground/90 hover:bg-subtle/40"
                onClick={() => setEditingDesc(true)}
                title="Click to edit"
              >
                {issue.description || (
                  <span className="text-muted-foreground">No description. Click to add.</span>
                )}
              </article>
            )}
          </section>

          {/* attachment-panel-slot */}
          <IssueRelationsPanel issueId={issue.id} />

          <section className="mt-10">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Activity
            </h2>
            <div className="space-y-3">
              {issue.comments.length === 0 && (
                <p className="text-xs text-muted-foreground">No comments yet.</p>
              )}
              {issue.comments.map((c) => (
                <div key={c.id} className="flex gap-2.5">
                  <Avatar name={c.author.name} image={c.author.image} size={22} />
                  <div className="min-w-0 flex-1 rounded-md border border-border bg-card/40 p-2.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-medium">{c.author.name}</span>
                      <span className="text-muted-foreground">{relativeTime(c.createdAt)}</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-[13px]">{c.body}</div>
                  </div>
                </div>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!commentDraft.trim()) return;
                createComment.mutate({ issueId: id, body: commentDraft.trim() });
              }}
              className="mt-4 flex gap-2"
            >
              <Input
                placeholder="Leave a comment…"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={!commentDraft.trim() || createComment.isPending}>
                Comment
              </Button>
            </form>
          </section>
        </div>

        <aside className="overflow-y-auto border-l border-border p-5 text-xs">
          <div className="space-y-4">
            <Field label="Status">
              <select
                value={issue.statusId}
                onChange={(e) => update.mutate({ id: issue.id, statusId: e.target.value })}
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1"
              >
                {statuses?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={issue.priority}
                onChange={(e) =>
                  update.mutate({ id: issue.id, priority: e.target.value as typeof issue.priority })
                }
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1"
              >
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label="Project">
              <select
                value={issue.projectId ?? ""}
                onChange={(e) =>
                  update.mutate({
                    id: issue.id,
                    projectId: e.target.value || null,
                  })
                }
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1"
              >
                <option value="">— none —</option>
                {projects?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Assignees">
              <AssigneePicker
                current={issue.assignees.map((a) => ({
                  userId: a.userId,
                  name: a.user.name,
                  image: a.user.image,
                }))}
                members={(members ?? []).map((m) => ({
                  userId: m.user.id,
                  name: m.user.name ?? m.user.email,
                  image: m.user.image,
                }))}
                onChange={(userIds) => assign.mutate({ id: issue.id, userIds })}
              />
            </Field>
            <Field label="Labels">
              <LabelPicker
                current={issue.labels.map((l) => ({
                  id: l.labelId,
                  name: l.label.name,
                  color: l.label.color,
                }))}
                all={allLabels ?? []}
                onChange={(labelIds) => setLabels.mutate({ issueId: issue.id, labelIds })}
              />
            </Field>
            <Field label="Due">
              <input
                type="date"
                value={issue.dueDate ? new Date(issue.dueDate).toISOString().slice(0, 10) : ""}
                onChange={(e) =>
                  update.mutate({
                    id: issue.id,
                    dueDate: e.target.value ? new Date(e.target.value) : null,
                  })
                }
                className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 font-mono"
              />
            </Field>

            <Field label="Agent queue">
              <label className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1">
                <input
                  type="checkbox"
                  checked={issue.queued}
                  onChange={(e) =>
                    setQueued.mutate({ id: issue.id, queued: e.target.checked })
                  }
                  className="h-3.5 w-3.5"
                />
                <span className="text-[11px] text-muted-foreground">
                  Available to claim via MCP
                </span>
              </label>
              {issue.claimedAt && (
                <div className="mt-2 rounded-md border border-border bg-card/60 p-2 text-[11px]">
                  <div className="text-muted-foreground">Claimed</div>
                  <div className="mt-0.5">
                    by <span className="font-mono">{issue.claimedById?.slice(0, 8)}</span>
                    {issue.claimExpiresAt && (
                      <>
                        {" "}· expires {relativeTime(issue.claimExpiresAt)}
                      </>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1 w-full"
                    onClick={() => releaseClaim.mutate({ id: issue.id })}
                  >
                    Release claim
                  </Button>
                </div>
              )}
            </Field>
          </div>
        </aside>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function LabelPicker({
  current,
  all,
  onChange,
}: {
  current: { id: string; name: string; color: string }[];
  all: { id: string; name: string; color: string }[];
  onChange: (labelIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(current.map((l) => l.id));

  function toggle(labelId: string) {
    const next = selected.has(labelId)
      ? current.filter((l) => l.id !== labelId).map((l) => l.id)
      : [...current.map((l) => l.id), labelId];
    onChange(next);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="focus-ring flex w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-left hover:bg-subtle"
      >
        {current.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          current.map((l) => (
            <Badge key={l.id} color={l.color}>
              {l.name}
            </Badge>
          ))
        )}
        <span className="ml-auto text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {all.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => toggle(l.id)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-subtle"
                >
                  <span
                    className={
                      "inline-block h-3 w-3 rounded-sm border " +
                      (selected.has(l.id) ? "border-ember bg-ember" : "border-border bg-background")
                    }
                  />
                  <Badge color={l.color}>{l.name}</Badge>
                </button>
              </li>
            ))}
            {all.length === 0 && (
              <li className="px-3 py-3 text-center text-[11px] text-muted-foreground">
                No labels defined yet.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function AssigneePicker({
  current,
  members,
  onChange,
}: {
  current: { userId: string; name: string | null; image: string | null }[];
  members: { userId: string; name: string; image: string | null }[];
  onChange: (userIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = new Set(current.map((a) => a.userId));

  function toggle(userId: string) {
    const next = selected.has(userId)
      ? current.filter((a) => a.userId !== userId).map((a) => a.userId)
      : [...current.map((a) => a.userId), userId];
    onChange(next);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="focus-ring flex w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-left hover:bg-subtle"
      >
        {current.length === 0 ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          <>
            <div className="flex -space-x-1.5">
              {current.slice(0, 3).map((a) => (
                <Avatar key={a.userId} name={a.name} image={a.image} size={18} />
              ))}
            </div>
            <span className="ml-1 text-muted-foreground">{current.length}</span>
          </>
        )}
        <span className="ml-auto text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <ul className="max-h-64 overflow-y-auto py-1">
            {members.map((m) => (
              <li key={m.userId}>
                <button
                  type="button"
                  onClick={() => toggle(m.userId)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-subtle"
                >
                  <span
                    className={
                      "inline-block h-3 w-3 rounded-sm border " +
                      (selected.has(m.userId)
                        ? "border-ember bg-ember"
                        : "border-border bg-background")
                    }
                  />
                  <Avatar name={m.name} image={m.image} size={18} />
                  <span className="truncate">{m.name}</span>
                </button>
              </li>
            ))}
            {members.length === 0 && (
              <li className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                No workspace members.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
