"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  ArrowRightLeft,
  AtSign,
  Bot,
  FilePlus,
  Inbox,
  Link2,
  MessageCircle,
  UserCheck,
} from "lucide-react";
import type { EventKind, StatusCategory } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { IssueList } from "@/components/issue-list";
import { IssueBoard } from "@/components/issue-board";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { EmptyState, Skeleton } from "@/components/ui";
import { InitiativeChip } from "@/components/initiative-chip";
import { CycleChip } from "@/components/cycle-chip";
import { PinButton } from "@/components/pins/pin-button";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

type Tab = "overview" | "list" | "board";

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: project, error, refetch } = trpc.project.byId.useQuery({ id });
  const { data: ws } = trpc.workspace.current.useQuery();

  const tabParam = (searchParams?.get("view") ?? "overview") as Tab;
  const tab: Tab =
    tabParam === "list" || tabParam === "board" ? tabParam : "overview";

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "overview") params.delete("view");
    else params.set("view", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const trpcUtils = trpc.useUtils();
  const archive = trpc.project.archive.useMutation({
    onSuccess: () => {
      toast.success("Project archived.");
      trpcUtils.project.list.invalidate();
      router.push(`/w/${slug}/projects`);
    },
    onError: (e) => toast.error(e.message),
  });

  const del = trpc.project.softDelete.useMutation({
    onSuccess: () => {
      toast.success("Project deleted.");
      trpcUtils.project.list.invalidate();
      trpcUtils.project.byId.invalidate({ id });
      router.push(`/w/${slug}/projects`);
    },
    onError: (e) => toast.error(e.message),
  });

  // Phase 1C — record this visit so it surfaces in the command palette's
  // Recents rail. Server-side debounced 5s.
  const trackM = trpc.recentItem.track.useMutation();
  useEffect(() => {
    if (project?.id) {
      trackM.mutate({ targetType: "PROJECT", targetId: project.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          title="Project not found"
          description={error.message}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/w/${slug}/projects`)}
            >
              Back to projects
            </Button>
          }
        />
      </div>
    );
  }

  if (!project)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  return (
    <>
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: project.color ?? "#78716c" }}
            />
            {project.icon && <span>{project.icon}</span>}
            {project.name}
          </span>
        }
        subtitle={project.key}
        actions={
          <div className="flex items-center gap-2">
            <PinButton
              targetType="PROJECT"
              targetId={project.id}
              workspaceId={workspace.id}
            />
            <Button
              variant="ember"
              size="sm"
              data-quick-create
              data-quick-create-project={project.id}
            >
              New issue
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={archive.isPending || project.archived}
              onClick={() => setArchiveOpen(true)}
            >
              {project.archived ? "Archived" : "Archive"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={del.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-border bg-background px-4 text-xs">
          <ProjectTabButton active={tab === "overview"} onClick={() => setTab("overview")}>
            Overview
          </ProjectTabButton>
          <ProjectTabButton active={tab === "list"} onClick={() => setTab("list")}>
            List
          </ProjectTabButton>
          <ProjectTabButton active={tab === "board"} onClick={() => setTab("board")}>
            Board
          </ProjectTabButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === "overview" && (
            <div className="h-full overflow-y-auto">
              <OverviewTab projectId={project.id} workspaceSlug={slug} />
            </div>
          )}
          {tab === "list" && (
            <div className="h-full overflow-y-auto">
              <IssueList workspaceKey={ws?.key ?? "—"} projectId={project.id} includeDone />
            </div>
          )}
          {tab === "board" && (
            <IssueBoard workspaceKey={ws?.key ?? "—"} projectId={project.id} />
          )}
        </div>
      </div>

      <EditProjectDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        onSaved={() => refetch()}
      />
      <Confirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${project.name}?`}
        description="Hides the project. Its issues stay intact; you can restore later."
        primaryLabel="Archive"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ id: project.id })}
      />
      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${project.name}?`}
        description="Issues are preserved but unlinked from this project. Soft-delete — audit trail retained."
        primaryLabel="Delete project"
        loading={del.isPending}
        onConfirm={() => del.mutate({ id: project.id })}
      />
    </>
  );
}

function ProjectTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  projectId,
  workspaceSlug,
}: {
  projectId: string;
  workspaceSlug: string;
}) {
  const { data, isLoading, refetch } = trpc.project.overview.useQuery({
    id: projectId,
  });
  const utils = trpc.useUtils();
  const update = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success("Saved.");
      void refetch();
      void utils.project.byId.invalidate({ id: projectId });
    },
    onError: (e) => toast.error(e.message),
  });

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");

  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { project, counts, linkedInitiative, currentCycleSlice, members, recentActivity } =
    data;

  const headerStats: Array<{ label: string; value: number; tone?: "warn" }> = [
    { label: "Total", value: counts.total },
    { label: "Open", value: counts.open },
    { label: "In progress", value: counts.inProgress },
    { label: "Done", value: counts.done },
    {
      label: "Blocked",
      value: counts.blocked,
      tone: counts.blocked > 0 ? "warn" : undefined,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* Header — name + description (inline edit). Edit/avatar/etc. live
          on the page Topbar so they're consistent across tabs. */}
      <header className="space-y-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {project.icon && <span className="mr-1.5">{project.icon}</span>}
            {project.name}
          </h1>
          <span className="text-id text-muted-foreground">{project.key}</span>
        </div>
        {editingDesc ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  update.mutate({
                    id: project.id,
                    description: descDraft.trim() || null,
                  });
                  setEditingDesc(false);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDescDraft(project.description ?? "");
                  setEditingDesc(false);
                }
              }}
              rows={4}
              className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ember"
                disabled={update.isPending}
                onClick={() => {
                  update.mutate({
                    id: project.id,
                    description: descDraft.trim() || null,
                  });
                  setEditingDesc(false);
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDescDraft(project.description ?? "");
                  setEditingDesc(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p
            className="cursor-text whitespace-pre-wrap rounded-md px-1 py-0.5 text-sm text-foreground/80 hover:bg-subtle/40"
            onClick={() => {
              setDescDraft(project.description ?? "");
              setEditingDesc(true);
            }}
            title="Click to edit"
          >
            {project.description || (
              <span className="text-muted-foreground">
                No description. Click to add.
              </span>
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
          {project.startDate && <span>Starts {relativeTime(project.startDate)}</span>}
          {project.targetDate && <span>Target {relativeTime(project.targetDate)}</span>}
          <span>Updated {relativeTime(project.updatedAt)}</span>
          {project.archived && <Badge color="#d97706">archived</Badge>}
        </div>
      </header>

      {/* Status row — clean horizontal stat strip. Numbers prominent,
          labels muted. Blocked goes warm-warning when > 0. */}
      <section
        aria-label="Project status"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5"
      >
        {headerStats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} />
        ))}
      </section>

      {/* Linked initiative */}
      <section aria-label="Initiative">
        <SectionEyebrow>Part of</SectionEyebrow>
        {linkedInitiative ? (
          <div className="mt-2 flex items-center gap-2">
            <InitiativeChip
              initiative={linkedInitiative}
              slug={workspaceSlug}
            />
            <span className="text-meta text-muted-foreground">
              {linkedInitiative.status.toLowerCase().replace(/_/g, " ")}
            </span>
          </div>
        ) : (
          <LinkInitiativeCta projectId={project.id} onLinked={() => refetch()} />
        )}
      </section>

      {/* Current sprint slice */}
      {currentCycleSlice && (
        <section aria-label="Current sprint">
          <div className="mb-2 flex items-baseline justify-between">
            <SectionEyebrow>Current sprint</SectionEyebrow>
            <span className="text-meta text-muted-foreground">
              {currentCycleSlice.total} issue
              {currentCycleSlice.total === 1 ? "" : "s"}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-card/40">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <CycleChip
                cycle={currentCycleSlice}
                slug={workspaceSlug}
              />
              <span className="text-meta text-muted-foreground">
                ends {relativeTime(currentCycleSlice.endsAt)}
              </span>
              <Link
                href={`/w/${workspaceSlug}/cycles/${currentCycleSlice.id}`}
                className="ml-auto text-meta text-muted-foreground hover:text-ember"
              >
                View all in sprint →
              </Link>
            </div>
            <ul className="divide-y divide-border">
              {currentCycleSlice.issues.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/w/${workspaceSlug}/issues/${i.id}`}
                    className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-subtle/60"
                  >
                    <span className="text-id text-muted-foreground">
                      {project.key}-{i.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {i.title}
                    </span>
                    <StatusPill status={i.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Members */}
      <section aria-label="Members">
        <div className="mb-2 flex items-baseline justify-between">
          <SectionEyebrow>Members</SectionEyebrow>
          <span className="text-meta text-muted-foreground">
            {members.length} active
          </span>
        </div>
        {members.length === 0 ? (
          <p className="text-meta text-muted-foreground">
            No members with open issues yet.
          </p>
        ) : (
          <ul className="flex flex-wrap items-center gap-2">
            {members.map((m) => (
              <li key={m.userId}>
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/40 py-0.5 pl-0.5 pr-2"
                  title={
                    m.openCount > 0
                      ? `${m.name ?? m.handle ?? "member"} — ${m.openCount} open`
                      : (m.name ?? m.handle ?? "member")
                  }
                >
                  <Avatar name={m.name} image={m.avatarUrl} size={20} />
                  <span className="text-xs">{m.name ?? m.handle ?? "—"}</span>
                  <span className="text-id text-muted-foreground">
                    {m.openCount}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent activity */}
      <section aria-label="Recent activity">
        <SectionEyebrow>Recent activity</SectionEyebrow>
        <div className="mt-2 rounded-lg border border-border bg-card/40">
          {recentActivity.length === 0 ? (
            <div className="px-3 py-4 text-meta text-muted-foreground">
              No activity yet. Create an issue to start the timeline.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {recentActivity.map((evt) => (
                <li
                  key={evt.id}
                  className="flex items-start gap-2 px-3 py-2 text-xs"
                >
                  <span className="mt-0.5 shrink-0">
                    <ActivityIcon kind={evt.kind} />
                  </span>
                  <Avatar
                    name={evt.actor?.name}
                    image={evt.actor?.image}
                    size={20}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <ActivitySummary
                      evt={evt}
                      projectKey={project.key}
                      workspaceSlug={workspaceSlug}
                    />
                  </div>
                  <span className="text-meta shrink-0 text-muted-foreground">
                    {relativeTime(evt.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "warn" && "text-warning",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: { name: string; color: string; category: StatusCategory };
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-id"
      style={{
        backgroundColor: `${status.color}1F`,
        color: status.color,
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      {status.name}
    </span>
  );
}

function ActivityIcon({ kind }: { kind: EventKind }) {
  const cls = "h-3.5 w-3.5 text-muted-foreground";
  switch (kind) {
    case "ISSUE_CREATED":
      return <FilePlus className={cls} />;
    case "ISSUE_STATUS_CHANGED":
      return <ArrowRightLeft className={cls} />;
    case "ISSUE_ASSIGNED":
    case "AGENT_ASSIGNED":
      return <UserCheck className={cls} />;
    case "ISSUE_PRIORITY_CHANGED":
      return <Activity className={cls} />;
    case "ISSUE_QUEUED":
      return <Inbox className={cls} />;
    case "COMMENT_CREATED":
      return <MessageCircle className={cls} />;
    default:
      return <Bot className={cls} />;
  }
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function ActivitySummary({
  evt,
  projectKey,
  workspaceSlug,
}: {
  evt: {
    kind: EventKind;
    actor: { id: string; name: string | null; image: string | null } | null;
    issue: {
      id: string;
      number: number;
      title: string;
      status: { id: string; name: string; color: string; category: StatusCategory };
    } | null;
    payload: unknown;
  };
  projectKey: string;
  workspaceSlug: string;
}) {
  const actorName = evt.actor?.name ?? "system";
  const issue = evt.issue;
  const issueLink = issue ? (
    <Link
      href={`/w/${workspaceSlug}/issues/${issue.id}`}
      className="font-mono text-foreground hover:text-ember"
    >
      {projectKey}-{issue.number}
    </Link>
  ) : (
    <span className="text-muted-foreground">an issue</span>
  );

  switch (evt.kind) {
    case "ISSUE_CREATED":
      return (
        <div>
          <div>
            {actorName} created {issueLink}
          </div>
          {issue && (
            <div className="text-meta truncate text-muted-foreground">
              {issue.title}
            </div>
          )}
        </div>
      );
    case "ISSUE_STATUS_CHANGED":
      return (
        <div>
          <div>
            {actorName} moved {issueLink}
            {issue && (
              <>
                {" "}
                &rarr;{" "}
                <span style={{ color: issue.status.color }}>
                  {issue.status.name}
                </span>
              </>
            )}
          </div>
          {issue && (
            <div className="text-meta truncate text-muted-foreground">
              {issue.title}
            </div>
          )}
        </div>
      );
    case "ISSUE_ASSIGNED": {
      const handle = readPayloadString(evt.payload, "agentProfileKey");
      return (
        <div>
          {actorName} assigned {issueLink}
          {handle && (
            <>
              {" "}
              to <span className="font-mono">@{handle}</span>
            </>
          )}
        </div>
      );
    }
    case "AGENT_ASSIGNED": {
      const handle = readPayloadString(evt.payload, "agentProfileKey");
      const mode = readPayloadString(evt.payload, "mode");
      return (
        <div>
          <div>
            {actorName} assigned {issueLink}
            {handle && (
              <>
                {" "}
                to <span className="font-mono">@{handle}</span>
              </>
            )}
          </div>
          {mode && (
            <div className="text-meta truncate text-muted-foreground">
              mode &middot; {mode}
            </div>
          )}
        </div>
      );
    }
    case "ISSUE_PRIORITY_CHANGED": {
      const to = readPayloadString(evt.payload, "to");
      return (
        <div>
          {actorName} changed priority on {issueLink}
          {to && (
            <>
              {" "}
              &rarr; <span className="text-foreground">{to}</span>
            </>
          )}
        </div>
      );
    }
    case "ISSUE_QUEUED":
      return (
        <div>
          {actorName} queued {issueLink} for an agent
        </div>
      );
    case "COMMENT_CREATED":
      return (
        <div>
          <span className="inline-flex items-center gap-1">
            <AtSign className="h-3 w-3 text-muted-foreground" />
            {actorName}
          </span>{" "}
          commented on {issueLink}
          {issue && (
            <div className="text-meta truncate text-muted-foreground">
              {issue.title}
            </div>
          )}
        </div>
      );
    default:
      return (
        <div>
          {actorName} updated {issueLink}
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Link-to-initiative CTA — minimal in-place picker (mirrors the picker
// pattern on the initiative detail page, without adding a route trip).
// ---------------------------------------------------------------------------

function LinkInitiativeCta({
  projectId,
  onLinked,
}: {
  projectId: string;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: initiatives } = trpc.initiative.list.useQuery(
    {},
    { enabled: open },
  );
  const link = trpc.initiative.linkProject.useMutation({
    onSuccess: () => {
      toast.success("Linked.");
      setOpen(false);
      setQuery("");
      onLinked();
    },
    onError: (e) => toast.error(e.message),
  });

  const filtered = (initiatives ?? []).filter((i) => {
    const q = query.toLowerCase();
    return !q || i.name.toLowerCase().includes(q);
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-card/20 px-2 py-1 text-meta text-muted-foreground",
          "hover:border-ember/40 hover:text-ember",
        )}
      >
        <Link2 className="h-3 w-3" />
        Link to an initiative
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-dashed border-border bg-card/20 p-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an initiative…"
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ul className="mt-2 max-h-56 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-2 py-2 text-meta text-muted-foreground">
            No initiatives match.
          </li>
        ) : (
          filtered.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate({ initiativeId: i.id, projectId })
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-subtle disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: i.color ?? "#78716c" }}
                />
                <span className="truncate">{i.name}</span>
                <span className="ml-auto text-id text-muted-foreground">
                  {i.slug}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog — preserved from the previous implementation.
// ---------------------------------------------------------------------------

function EditProjectDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: {
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    icon: string | null;
  };
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [color, setColor] = useState(project.color ?? "#78716c");
  const [icon, setIcon] = useState(project.icon ?? "");

  const update = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success("Saved.");
      onSaved();
    },
  });

  return (
    <QuickForm
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Edit project"
      primaryLabel={update.isPending ? "Saving…" : "Save"}
      loading={update.isPending}
      onSubmit={async () => {
        try {
          await update.mutateAsync({
            id: project.id,
            name: name.trim(),
            description: description.trim() || null,
            color,
            icon: icon.trim() || undefined,
          });
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Failed to save." };
        }
      }}
    >
      <QuickForm.Field label="Name">
        <Input name="name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </QuickForm.Field>
      <QuickForm.Field label="Description">
        <textarea
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
        />
      </QuickForm.Field>
      <div className="grid grid-cols-2 gap-3">
        <QuickForm.Field label="Color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-input bg-background"
            />
            <Input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="flex-1"
            />
          </div>
        </QuickForm.Field>
        <QuickForm.Field label="Icon (emoji)">
          <Input
            name="icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={8}
          />
        </QuickForm.Field>
      </div>
    </QuickForm>
  );
}

// `useViewPref` import — preserved at the top of the file in the original
// version. Since the tab now drives view state via the URL, we no longer
// need it here. Removing `ViewToggle` from the topbar is intentional:
// the tab strip subsumes its role.
