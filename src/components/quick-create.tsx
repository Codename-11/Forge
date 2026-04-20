"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { NewCycleDialog } from "@/components/cycles/new-cycle-dialog";
import { NewInitiativeDialog } from "@/components/initiatives/new-initiative-dialog";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type Mode =
  | { kind: "issue" }
  | { kind: "cycle" }
  | { kind: "initiative" }
  | { kind: "project" }
  | { kind: "issue-context"; issueId: string; allowSubIssue: boolean };

/**
 * Context-aware quick-create. `⇧C` opens a dialog whose behavior depends
 * on the current pathname:
 *
 *   /w/*\/cycles*        → New cycle
 *   /w/*\/initiatives*   → New initiative
 *   /w/*\/projects*      → New project
 *   /w/*\/issues/:id     → New comment (default) or sub-issue
 *   anywhere else        → New issue (the default behavior this file had)
 *
 * The decision is made when the dialog opens, not reactively — so tapping
 * `⇧C` while looking at an issue detail and navigating mid-form doesn't
 * swap the dialog contents out from under you.
 *
 * Legacy hooks are preserved: clicking any `[data-quick-create]` element
 * and dispatching `forge:quick-create` both still open the default issue
 * form; callers that want a specific project can set
 * `data-quick-create-project=<id>` or pass `{ projectId }` in the event.
 */
export function QuickCreate() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "issue" });

  // Issue-form state.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [parentId, setParentId] = useState<string>("");
  const [priority, setPriority] = useState<Priority>("NONE");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string>("");

  // Issue-context state (comment vs sub-issue on an issue detail).
  const [issueContextIntent, setIssueContextIntent] =
    useState<"comment" | "sub-issue">("comment");
  const [commentBody, setCommentBody] = useState("");

  const router = useRouter();
  const pathname = usePathname();
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();

  // Pull templates + projects lazily — only when the issue flavor is open.
  const issueish = mode.kind === "issue" || mode.kind === "issue-context";
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { enabled: open && issueish },
  );
  const { data: templates } = trpc.template.list.useQuery(undefined, {
    enabled: open && mode.kind === "issue",
  });

  // Pick up the parent issue's details so sub-issue inherits its project
  // (a reasonable default — user can still override).
  const contextIssueId =
    mode.kind === "issue-context" ? mode.issueId : undefined;
  const { data: contextIssue } = trpc.issue.byId.useQuery(
    { id: contextIssueId ?? "" },
    { enabled: open && !!contextIssueId },
  );

  const createIssue = trpc.issue.create.useMutation({
    onSuccess: async (issue) => {
      toast.success(`Created #${issue.number}`);
      close();
      await utils.issue.list.invalidate();
      const base = ws ? `/w/${ws.slug}` : "";
      router.push(`${base}/issues/${issue.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const createComment = trpc.comment.create.useMutation({
    onSuccess: async (_, input) => {
      toast.success("Comment added.");
      close();
      await utils.issue.byId.invalidate({ id: input.issueId });
      await utils.issue.activity.invalidate({ issueId: input.issueId });
    },
    onError: (err) => toast.error(err.message),
  });

  function close() {
    setOpen(false);
    setTitle("");
    setDescription("");
    setProjectId("");
    setParentId("");
    setPriority("NONE");
    setLabelIds([]);
    setTemplateId("");
    setIssueContextIntent("comment");
    setCommentBody("");
  }

  function applyTemplate(tid: string) {
    setTemplateId(tid);
    const t = templates?.find((x) => x.id === tid);
    if (!t) return;
    setTitle(t.titleTemplate);
    setDescription(t.descriptionTemplate ?? "");
    setProjectId(t.projectId ?? "");
    setPriority(t.defaultPriority as Priority);
    setLabelIds(t.labelIds);
  }

  // Decide the mode based on the current URL. Purely a lookup over the
  // pathname — no async lookups, so safe to call synchronously.
  //
  // Note: we match the list pages (`/cycles`, `/initiatives`, `/projects`)
  // with and without a trailing `?…`, but *not* their detail pages. On a
  // project detail (`/projects/<id>`) the intuitive next action is "new
  // issue in this project", not "new project". The project detail page
  // carries `data-quick-create-project=<id>` on its button, which our
  // click handler funnels back through the issue form.
  function modeForPath(path: string | null): Mode {
    if (!path) return { kind: "issue" };
    // Tolerate the /w/<slug>/... prefix and bare paths alike.
    const tail = path.replace(/^\/w\/[^/]+/, "");
    const issueMatch = tail.match(/^\/issues\/([^/?#]+)/);
    if (issueMatch) {
      return { kind: "issue-context", issueId: issueMatch[1], allowSubIssue: true };
    }
    // List-page exact matches. `/cycles/<id>` falls through to issue mode.
    if (tail === "/cycles" || tail.startsWith("/cycles?")) return { kind: "cycle" };
    if (tail === "/initiatives" || tail.startsWith("/initiatives?"))
      return { kind: "initiative" };
    if (tail === "/projects" || tail.startsWith("/projects?"))
      return { kind: "project" };
    return { kind: "issue" };
  }

  function openQuickCreate(override?: { projectId?: string }) {
    const next = modeForPath(pathname);
    setMode(next);
    if (override?.projectId) setProjectId(override.projectId);
    setOpen(true);
  }

  // `c` is reserved for "open current cycle" (Phase 3 planning primitives).
  // Quick-create binds to Shift+C and remains clickable from the sidebar.
  useHotkey("shift+c", () => openQuickCreate());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(
        "[data-quick-create]",
      ) as HTMLElement | null;
      if (!el) return;
      const pid = el.dataset.quickCreateProject;
      openQuickCreate(pid ? { projectId: pid } : undefined);
    };
    document.addEventListener("click", handler);

    const evt = (e: Event) => {
      const detail =
        (e as CustomEvent<{ projectId?: string; templateId?: string }>).detail ??
        {};
      openQuickCreate(detail);
    };
    window.addEventListener("forge:quick-create", evt);

    return () => {
      document.removeEventListener("click", handler);
      window.removeEventListener("forge:quick-create", evt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Render the right dialog per mode. Cycle/initiative/project each have
  // a dedicated shared component — we just forward `open` / `onClose`.
  if (mode.kind === "cycle") {
    return <NewCycleDialog open={open} onClose={close} />;
  }
  if (mode.kind === "initiative") {
    return <NewInitiativeDialog open={open} onClose={close} />;
  }
  if (mode.kind === "project") {
    return <NewProjectDialog open={open} onClose={close} />;
  }

  // Issue + issue-context flows share one dialog with mode-swapped body.
  return (
    <Dialog open={open} onClose={close} className="max-w-lg">
      <div className="space-y-3 p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>
            {mode.kind === "issue-context"
              ? issueContextIntent === "comment"
                ? "New comment"
                : "New sub-issue"
              : "New issue"}
          </span>
          <span className="ml-auto kbd">⏎ to create</span>
        </div>

        {mode.kind === "issue-context" && (
          <div
            role="tablist"
            aria-label="Quick-create intent"
            className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]"
          >
            <IntentTab
              selected={issueContextIntent === "comment"}
              onClick={() => setIssueContextIntent("comment")}
              label="Comment"
            />
            <IntentTab
              selected={issueContextIntent === "sub-issue"}
              onClick={() => setIssueContextIntent("sub-issue")}
              label="Sub-issue"
            />
          </div>
        )}

        {mode.kind === "issue-context" && issueContextIntent === "comment" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!commentBody.trim()) return;
              createComment.mutate({
                issueId: mode.issueId,
                body: commentBody.trim(),
              });
            }}
            className="space-y-3"
          >
            <textarea
              autoFocus
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={5}
              placeholder="Write a comment… (Markdown-flavored)"
              className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="ember"
                size="sm"
                disabled={!commentBody.trim() || createComment.isPending}
              >
                {createComment.isPending ? "Posting…" : "Post comment"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim().length < 1) return;
              const isSubIssue = mode.kind === "issue-context";
              createIssue.mutate({
                title: title.trim(),
                description: description.trim() || undefined,
                projectId:
                  (isSubIssue ? contextIssue?.projectId ?? undefined : undefined) ??
                  (projectId || undefined),
                parentId: isSubIssue ? mode.issueId : parentId || undefined,
                priority,
                labelIds,
              });
            }}
            className="space-y-3"
          >
            {mode.kind === "issue-context" && contextIssue && (
              <div className="rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                Parent:{" "}
                <span className="font-mono text-foreground">
                  {contextIssue.title}
                </span>
              </div>
            )}

            {mode.kind === "issue" && templates && templates.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  Start from template
                </label>
                <select
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">Blank</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode.kind === "issue-context" ? "Sub-issue title" : "Issue title"
              }
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)…"
              rows={3}
              className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
            {mode.kind === "issue" && (
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">No project</option>
                  {projects?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
            )}
            {mode.kind === "issue-context" && (
              <div className="grid grid-cols-1 gap-2">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
            )}
            {labelIds.length > 0 && (
              <div className="flex flex-wrap gap-1 text-[11px]">
                {labelIds.map((lid) => (
                  <Badge key={lid}>{lid.slice(0, 8)}</Badge>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="ember"
                size="sm"
                disabled={!title.trim() || createIssue.isPending}
              >
                {createIssue.isPending
                  ? "Creating…"
                  : mode.kind === "issue-context"
                  ? "Create sub-issue"
                  : "Create issue"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}

function IntentTab({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={
        "focus-ring rounded px-2 py-1 transition-colors " +
        (selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {label}
    </button>
  );
}
