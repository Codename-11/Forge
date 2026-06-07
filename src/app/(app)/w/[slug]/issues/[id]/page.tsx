"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { AgentStatus, WorkItemKind } from "@prisma/client";
import { Bot, Paperclip, Plus, Trash2, Workflow } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Confirm, Picker } from "@/components/ui/modal";
import {
  WorkItemKindGlyph,
  KIND_LABEL,
  KIND_SUBTITLE,
  KIND_ORDER,
  type WorkItemKindValue,
} from "@/components/ui/work-item-kind-glyph";
import {
  EngagementModeGlyph,
  MODE_LABEL,
  MODE_SUBTITLE,
  MODE_ORDER,
  type EngagementModeValue,
} from "@/components/ui/engagement-mode-glyph";
import { EmptyState, Skeleton, SkeletonText } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { presenceAvailability } from "@/lib/transport-display";
import { trpc } from "@/lib/trpc";
import { formatDate, formatIssueId, relativeTime } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";
import { useWorkspace } from "@/hooks/use-workspace";
import { PinButton } from "@/components/pins/pin-button";
import { WatchButton } from "@/components/watch-button";
import { IssueDetailTopbar } from "@/components/issue-detail/issue-topbar";
import { IssueMain } from "@/components/issue-detail/issue-main";
import { IssueRail } from "@/components/issue-detail/issue-rail";
import { IssueAgentPanel } from "@/components/issue-detail/issue-agent-panel";
import { TerminalRunFailureBanner } from "@/components/issue-detail/run-failure-banner";
import { RuntimePreflightBanner } from "@/components/issue-detail/runtime-preflight-banner";
import { RunActivityChip } from "@/components/issue-detail/run-activity-chip";
import { AiTriageCard } from "@/components/ai-triage-card";
import { Breadcrumb } from "@/components/breadcrumb";
import { ProjectChip } from "@/components/project-chip";
import { InitiativeChip } from "@/components/initiative-chip";
import { CycleChip } from "@/components/cycle-chip";
import { DispatchReasonChip, type DispatchReason } from "@/components/dispatch-reason-chip";
import { IssueSiblingNav } from "@/components/issue-sibling-nav";
import { useHotkey } from "@/lib/keyboard";

const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * Issue detail page. Two-column layout above `md`:
 *
 *   [ main column (flex-1, lg:max-w-4xl xl:max-w-5xl) | right rail ]
 *     description + comments                           Properties + tabs
 *
 * The outer scrollable area is capped at `max-w-[1600px] mx-auto` so
 * ultra-wide monitors don't leave gigantic gutters. The main column
 * widens with the viewport (3xl → 4xl → 5xl) so descriptions and
 * comments get more breathing room without becoming uncomfortable to
 * scan. Padding scales `p-5 md:p-6 xl:p-8`.
 *
 * The right rail hosts everything that isn't the description / comments:
 * a "Properties" header (project / labels / due / agent queue) plus the
 * existing tabs (Attachments / Relations / Activity). Tab state lives in
 * `?tab=…` so deep-links work. A secondary header ("IssueDetailTopbar")
 * below the shell <Topbar /> hosts the inline editors (title, status,
 * priority, assignees) — keeps the description above the fold without a
 * separate metadata column below it.
 */
export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: ws } = trpc.workspace.current.useQuery();
  // 15s refetch keeps the topbar's RunActivityChip (and other live
  // surfaces on this page) honest without a manual reload while an
  // agent is working the issue. Cheap — the byId payload is small
  // relative to the page render cost.
  const {
    data: issue,
    isLoading,
    error,
  } = trpc.issue.byId.useQuery({ id }, { refetchInterval: 15_000 });
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: cycles } = trpc.cycle.list.useQuery({});
  const { data: allLabels } = trpc.label.list.useQuery();
  // Pre-loaded for the reassign confirmation toast — both the agent
  // list (for the new-assignee display name) and a cap-50 activity
  // window (for the "X events shared" hint). Neither is on the
  // critical render path so a brief stale read is fine; they cost
  // one tRPC call each but are reused by the picker / activity rail.
  const { data: agentListData } = trpc.agent.list.useQuery({
    includeArchived: false,
  });
  const { data: recentEvents } = trpc.issue.activity.useQuery(
    { issueId: id, limit: 50 },
    { staleTime: 30_000 },
  );
  // Used to gate the ActionRequest Accept/Decline buttons rendered
  // inline in agent comments. Stays in this page so the byId payload
  // doesn't have to teach every nested consumer about the current user.
  const { data: me } = trpc.user.me.useQuery();
  const { data: watchers } = trpc.issue.watchers.useQuery({ issueId: id }, { staleTime: 30_000 });
  // Phase 1B: surface project's linked initiative and the issue's cycle as
  // chips. Both queries are skipped when the underlying id is null so we
  // don't hit the server on issues that don't have either link.
  const projectId = issue?.projectId ?? null;
  const cycleId = issue?.cycleId ?? null;
  const { data: linkedInitiative } = trpc.initiative.linkedFor.useQuery(
    { projectId: projectId ?? "" },
    { enabled: !!projectId, staleTime: 60_000 },
  );
  const { data: cycleData } = trpc.cycle.get.useQuery(
    { id: cycleId ?? "" },
    { enabled: !!cycleId, staleTime: 60_000 },
  );
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
    onSuccess: (_data, vars) => {
      toast.success(vars.queued ? "Queued for agent." : "Removed from agent queue.");
      utils.issue.byId.invalidate({ id });
      utils.issue.queue.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const releaseClaim = trpc.issue.release.useMutation({
    onSuccess: () => {
      toast.success("Claim released.");
      utils.issue.byId.invalidate({ id });
      utils.issue.queue.invalidate();
    },
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

  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);

  useEffect(() => {
    if (issue && !editingTitle) setTitleDraft(issue.title);
  }, [issue, editingTitle]);

  // Capital A opens the agent picker. Lowercase `a` is intentionally left
  // free for the user-assignee picker + as the `g a` nav leader second key.
  useHotkey("shift+a", () => setAgentPickerOpen(true), []);

  // Phase 1C — record this visit so it surfaces in the command palette's
  // Recents rail. Server-side debounced 5s; the keyed effect re-fires
  // when the user navigates to a different issue inside this same mount
  // (sibling-nav with `[`/`]`).
  const trackM = trpc.recentItem.track.useMutation();
  useEffect(() => {
    if (issue?.id) {
      trackM.mutate({ targetType: "ISSUE", targetId: issue.id });
    }
    // trackM is a tRPC mutation handle — stable across renders. Including
    // it would loop on every re-render via the useMutation identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue?.id]);

  // Phase 1B: sibling navigation. Scope picks which list defines siblings —
  // project membership wins; cycle membership is the fallback for issues
  // without a project. If neither, the nav is hidden and hotkeys no-op.
  const siblingScope: "project" | "cycle" | null = projectId ? "project" : cycleId ? "cycle" : null;
  const { data: siblings } = trpc.issue.siblings.useQuery(
    { issueId: id, scope: siblingScope ?? "project" },
    { enabled: !!siblingScope, staleTime: 30_000 },
  );
  useHotkey(
    "[",
    () => {
      if (siblings?.prev) router.push(`/w/${slug}/issues/${siblings.prev.id}`);
    },
    [siblings?.prev?.id, slug],
  );
  useHotkey(
    "]",
    () => {
      if (siblings?.next) router.push(`/w/${slug}/issues/${siblings.next.id}`);
    },
    [siblings?.next?.id, slug],
  );

  if (error)
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState variant="page" title="Unable to load issue" description={error.message} />
      </div>
    );
  if (isLoading || !issue)
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Skeleton className="h-6 w-3/5" />
        <SkeletonText lines={4} />
        <Skeleton className="h-32 w-full" />
      </div>
    );

  const issueKey = ws ? formatIssueId(ws.key, issue.number) : "Issue";

  // Phase 1B: replace the title-only header with a real path. Project →
  // issue when the issue is grouped; otherwise fall back to the issues
  // index. The trailing issue-key segment is non-link (current page) and
  // renders in mono via `BreadcrumbItem.mono`.
  const breadcrumbItems = issue.project
    ? [
        { label: "Projects", href: `/w/${slug}/projects` },
        {
          label: issue.project.name,
          href: `/w/${slug}/projects/${issue.project.id}`,
        },
        { label: issueKey, mono: true },
      ]
    : [
        { label: "Issues", href: `/w/${slug}/issues` },
        { label: issueKey, mono: true },
      ];

  return (
    <>
      <Topbar
        title={<Breadcrumb className="font-normal" items={breadcrumbItems} />}
        subtitle={<span className="font-mono">{issue.status.name}</span>}
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
              onClick={() => setDeleteOpen(true)}
              title="Delete issue"
              aria-label="Delete issue"
            >
              <Trash2 className="h-3.5 w-3.5 sm:hidden" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </>
        }
      />

      <IssueDetailTopbar
        left={
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 md:gap-2">
              <span className="text-id shrink-0 text-muted-foreground">{issueKey}</span>
              <KindPicker
                value={issue.kind}
                onChange={(kind) => update.mutate({ id: issue.id, kind })}
              />
              {issue.attachments.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // Jump to the right rail's Attachments tab. The rail
                    // reads `?tab=` from the URL and "attachments" is its
                    // default, so clearing the param works either way.
                    const url = new URL(window.location.href);
                    url.searchParams.delete("tab");
                    router.replace(`${url.pathname}${url.search}${url.hash}`);
                  }}
                  title={`${issue.attachments.length} attachment${issue.attachments.length === 1 ? "" : "s"}`}
                  className="focus-ring inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-subtle/60 hover:text-foreground"
                >
                  <Paperclip className="h-3 w-3" />
                  <span className="text-id">{issue.attachments.length}</span>
                </button>
              )}
              {issue.project && (
                <ProjectChip
                  project={{
                    id: issue.project.id,
                    key: issue.project.key,
                    name: issue.project.name,
                    color: issue.project.color,
                    icon: issue.project.icon,
                  }}
                />
              )}
              {linkedInitiative?.initiative && (
                <InitiativeChip
                  initiative={{
                    id: linkedInitiative.initiative.id,
                    slug: linkedInitiative.initiative.slug,
                    name: linkedInitiative.initiative.name,
                    status: linkedInitiative.initiative.status,
                  }}
                />
              )}
              {cycleData && (
                <CycleChip
                  cycle={{
                    id: cycleData.id,
                    name: cycleData.name,
                    status: cycleData.status,
                  }}
                />
              )}
              {(() => {
                // Phase 1C — surface "why was this agent picked?" inline
                // with the existing chips when the dispatcher has stamped
                // a reason on the issue. Coerce the JSON blob through a
                // narrow validator (same shape `agent-timeline.tsx` uses)
                // so a malformed payload doesn't crash the page.
                const reason = coerceDispatchReason(issue.dispatchReason);
                return reason ? <DispatchReasonChip reason={reason} /> : null;
              })()}
              {/* Phase 1A: per-workspace pin toggle. Lives next to the
                  chip cluster so it visually groups with the issue's other
                  metadata. The legacy `<PinToggleButton>` higher up in the
                  Topbar actions still drives the cross-workspace strip
                  (issue-only, p shortcut). */}
              <PinButton
                targetType="ISSUE"
                targetId={issue.id}
                workspaceId={workspace.id}
                shortcut="p"
              />
              <WatchButton issueId={issue.id} />
            </div>
            {editingTitle ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (titleDraft.trim() && titleDraft !== issue.title)
                    update.mutate({ id: issue.id, title: titleDraft.trim() });
                  setEditingTitle(false);
                }}
                className="min-w-0"
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
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-sm font-semibold"
                />
              </form>
            ) : (
              <h1
                className="min-w-0 cursor-text break-words rounded-md px-1 py-0.5 text-sm font-semibold tracking-tight hover:bg-subtle/60"
                onClick={() => setEditingTitle(true)}
                title="Click to edit"
              >
                {issue.title}
              </h1>
            )}
          </div>
        }
        middle={
          <div className="flex w-full flex-wrap items-center gap-1.5">
            <InlineStatus
              value={issue.statusId}
              options={statuses ?? []}
              onChange={(statusId) => update.mutate({ id: issue.id, statusId })}
            />
            <InlinePriority
              value={issue.priority}
              onChange={(priority) => update.mutate({ id: issue.id, priority })}
            />
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
            <AgentChip current={issue.assignedAgent} onOpen={() => setAgentPickerOpen(true)} />
            {/* "What's the agent doing right now?" — only renders when
                there's an ACTIVE run on this issue. Lives next to the
                AgentChip so the operator's eye lands on agent + status
                together. */}
            <RunActivityChip issueId={issue.id} />
          </div>
        }
        actions={siblingScope ? <IssueSiblingNav issueId={issue.id} scope={siblingScope} /> : null}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[1600px] flex-col gap-5 p-3 sm:p-5 md:flex-row md:gap-8 md:p-6 xl:gap-10 xl:p-8">
          <div className="min-w-0 flex-1 md:max-w-3xl lg:max-w-4xl xl:max-w-5xl">
            <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Avatar name={issue.author.name} image={issue.author.image} size={16} />
              <span>{issue.author.name ?? "Unknown"}</span>
              <span>·</span>
              <span title={formatDate(issue.createdAt, timePrefs)}>
                {relativeTime(issue.createdAt)}
              </span>
              <span>·</span>
              <span title={formatDate(issue.updatedAt, timePrefs)}>
                updated {relativeTime(issue.updatedAt)}
              </span>
            </div>

            <AiTriageCard issue={issue} />

            <TerminalRunFailureBanner
              run={issue.agentRuns?.[0] ?? null}
              activityHref={`/w/${slug}/issues/${issue.id}?tab=activity`}
            />
            <RuntimePreflightBanner preflight={issue.runtimePreflight} />

            <IssueMain
              issueId={issue.id}
              description={issue.description}
              comments={issue.comments}
              currentRunId={issue.currentAgentRun?.id ?? null}
              kind={issue.kind}
              projectId={issue.projectId ?? null}
              parent={issue.parent ?? null}
              onDescriptionSave={(next) => update.mutate({ id: issue.id, description: next })}
              canResolveActions={(() => {
                if (!me?.id) return false;
                // Issue assignees see Accept/Decline because they own
                // execution. Watchers see them because they're already
                // signed up for the thread. (OWNER/ADMIN is layered on
                // inside ActionRequestCard via useWorkspace.)
                const isAssignee = issue.assignees.some(
                  (a) => a.user?.id === me.id || a.userId === me.id,
                );
                const isWatcher = watchers?.items.some((w) => w.userId === me.id) ?? false;
                return isAssignee || isWatcher;
              })()}
            />
          </div>

          <aside
            aria-label="Issue detail rail"
            className="min-w-0 shrink-0 md:sticky md:top-4 md:h-[calc(100svh-7rem)] md:w-[22rem] md:self-start xl:w-[26rem]"
          >
            <div className="flex min-h-0 overflow-hidden rounded-lg border border-border bg-card/30 md:h-full">
              <IssueRail
                issueId={issue.id}
                header={
                  <div className="space-y-3">
                    <IssueAgentPanel
                      issueId={issue.id}
                      assignedAgent={issue.assignedAgent ?? null}
                    />
                    <SidebarField label="Project">
                      <ProjectPickerField
                        value={issue.projectId ?? null}
                        projects={projects?.items ?? []}
                        onChange={(projectId) => update.mutate({ id: issue.id, projectId })}
                      />
                    </SidebarField>
                    <SidebarField label="Sprint">
                      <CyclePickerField
                        value={issue.cycleId ?? null}
                        cycles={cycles ?? []}
                        onChange={(cycleId) => update.mutate({ id: issue.id, cycleId })}
                      />
                    </SidebarField>
                    {issue.executionSteps && issue.executionSteps.length > 0 ? (
                      <SidebarField label="From plan">
                        {issue.executionSteps.map((step) => (
                          <a
                            key={step.id}
                            href={`/w/${slug}/plans/${step.plan.id}`}
                            className="flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 text-xs hover:bg-subtle"
                            title={`Materialized from step ${step.position + 1}: ${step.title}`}
                          >
                            <Workflow className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{step.plan.title}</span>
                            <span className="ml-auto shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                              step {step.position + 1}
                            </span>
                          </a>
                        ))}
                      </SidebarField>
                    ) : null}
                    <SidebarField label="Labels">
                      <LabelPicker
                        current={issue.labels.map((l) => ({
                          id: l.labelId,
                          name: l.label.name,
                          color: l.label.color,
                        }))}
                        all={allLabels ?? []}
                        onChange={(labelIds) => setLabels.mutate({ issueId: issue.id, labelIds })}
                      />
                    </SidebarField>
                    <SidebarField label="Due">
                      <input
                        type="date"
                        value={
                          issue.dueDate ? new Date(issue.dueDate).toISOString().slice(0, 10) : ""
                        }
                        onChange={(e) =>
                          update.mutate({
                            id: issue.id,
                            dueDate: e.target.value ? new Date(e.target.value) : null,
                          })
                        }
                        className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
                      />
                    </SidebarField>
                    <SidebarField label="Agent queue">
                      <label className="flex w-full flex-wrap items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-[0.6875rem]">
                        <input
                          type="checkbox"
                          checked={issue.queued}
                          onChange={(e) =>
                            setQueued.mutate({
                              id: issue.id,
                              queued: e.target.checked,
                            })
                          }
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-muted-foreground">Queue for agent</span>
                        <span className="ml-auto shrink-0">
                          <Badge
                            className={issue.queued ? "bg-success/10 text-success" : undefined}
                          >
                            {issue.queued ? "Queued" : "Not queued"}
                          </Badge>
                        </span>
                      </label>
                      <div className="text-[0.6875rem] text-muted-foreground">
                        Queued issues are available to{" "}
                        <span className="font-mono text-foreground">issues.claim</span>; assigned
                        issues can still sit unclaimed until an agent starts.
                      </div>
                      {issue.claimedAt && (
                        <div className="mt-2 rounded-md border border-border bg-card/60 p-2 text-[0.6875rem]">
                          <div className="text-muted-foreground">Claimed</div>
                          <div className="mt-0.5">
                            by <span className="font-mono">{issue.claimedById?.slice(0, 8)}</span>
                            {issue.claimExpiresAt && (
                              <> · expires {relativeTime(issue.claimExpiresAt)}</>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-1 w-full"
                            onClick={() => setReleaseOpen(true)}
                          >
                            Release claim
                          </Button>
                        </div>
                      )}
                    </SidebarField>
                  </div>
                }
              />
            </div>
          </aside>
        </div>
      </div>

      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={`Delete ${issueKey}?`}
        description="Soft-deletes the issue. History is retained but the issue is removed from lists, boards, and relations."
        primaryLabel="Delete issue"
        typeToConfirm={issueKey}
        loading={softDelete.isPending}
        onConfirm={() => softDelete.mutate({ id })}
      />
      <Confirm
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title="Release claim?"
        description="The current agent loses its exclusive hold and the issue returns to the queue."
        primaryLabel="Release claim"
        loading={releaseClaim.isPending}
        onConfirm={() => releaseClaim.mutate({ id: issue.id })}
      />

      <AgentPickerModal
        open={agentPickerOpen}
        onOpenChange={setAgentPickerOpen}
        currentAgentId={issue.assignedAgent?.id ?? null}
        defaultMode={
          (issue.assignedAgent?.engagementMode as EngagementModeValue | null) ??
          (ws?.assignmentEngagementMode as EngagementModeValue) ??
          "EXECUTE"
        }
        onSelect={(agentId, mode) => {
          // Reassignment-confirmation toast: when the assigned agent
          // *changes* (not on the initial assign), reassure the
          // operator that context is preserved. The standard
          // AGENT_ASSIGNED webhook already carries the issueSnapshot;
          // this toast just makes it visible. `eventCount` is the
          // last-7-day count from already-loaded data so the toast
          // doesn't trigger an extra fetch.
          const wasAssigned = !!issue.assignedAgent;
          const isReassign = wasAssigned && agentId !== issue.assignedAgent?.id;
          let nextAgentName: string | null = null;
          if (agentId) {
            const next = agentListData?.find((a) => a.id === agentId);
            if (next) nextAgentName = `@${next.profileKey}`;
          }
          update.mutate(
            // Only stamp the mode when actually assigning an agent;
            // unassign carries no engagement intent.
            {
              id: issue.id,
              assignedAgentId: agentId,
              ...(agentId ? { mode } : {}),
            },
            {
              onSuccess: () => {
                if (isReassign && nextAgentName) {
                  // 7-day activity count for the issue. Falls back to
                  // total events if the timeline isn't loaded.
                  const cutoff = Date.now() - 7 * 86_400_000;
                  const eventCount = recentEvents
                    ? recentEvents.filter((e) => new Date(e.createdAt).getTime() >= cutoff).length
                    : null;
                  toast.success(`Reassigned ${issueKey} to ${nextAgentName}`, {
                    description:
                      eventCount !== null
                        ? `Context preserved · ${eventCount} event${eventCount === 1 ? "" : "s"} shared via comment thread`
                        : "Context preserved · the new agent receives the full issue snapshot",
                  });
                } else if (!wasAssigned && nextAgentName) {
                  toast.success(`Assigned ${issueKey} to ${nextAgentName}`);
                } else if (!agentId && wasAssigned) {
                  toast.success(`Unassigned agent from ${issueKey}`);
                }
              },
            },
          );
          setAgentPickerOpen(false);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline selectors for the issue-topbar strip
// ---------------------------------------------------------------------------

function InlineStatus({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; name: string; color: string }[];
  onChange: (id: string) => void;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <label className="relative flex items-center">
      <span className="pointer-events-none inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[0.6875rem]">
        {current && (
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: current.color }}
          />
        )}
        <span>{current?.name ?? "Status"}</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Status"
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function InlinePriority({
  value,
  onChange,
}: {
  value: (typeof PRIORITIES)[number];
  onChange: (p: (typeof PRIORITIES)[number]) => void;
}) {
  return (
    <label className="relative flex items-center">
      <span className="pointer-events-none inline-flex items-center rounded-md border border-border bg-background px-2 py-1 font-mono text-[0.6875rem]">
        {value}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as (typeof PRIORITIES)[number])}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Priority"
      >
        {PRIORITIES.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Inline work-item-kind picker (Epic / Issue / Sub-task) for the issue
 * topbar. A bare glyph+label control that opens the shared `Picker`;
 * matches the InlineStatus / InlinePriority affordances beside it.
 */
function KindPicker({
  value,
  onChange,
}: {
  value: WorkItemKind | string;
  onChange: (kind: WorkItemKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const v = (value ?? "ISSUE") as WorkItemKindValue;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Type: ${KIND_LABEL[v]} — click to change`}
        className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 text-[0.6875rem] hover:bg-subtle"
      >
        <WorkItemKindGlyph kind={v} size={12} />
        <span className={v === "EPIC" ? "text-ember" : "text-muted-foreground"}>
          {KIND_LABEL[v]}
        </span>
      </button>
      <Picker<WorkItemKindValue>
        open={open}
        onOpenChange={setOpen}
        placeholder="Set work item type…"
        items={KIND_ORDER}
        getKey={(k) => k}
        emptyLabel="No types."
        onSelect={(k) => onChange(k as WorkItemKind)}
        renderItem={(k) => (
          <div className="flex items-center gap-2">
            <WorkItemKindGlyph kind={k} size={14} />
            <span>{KIND_LABEL[k]}</span>
            <span className="ml-auto text-[0.6875rem] text-muted-foreground">
              {KIND_SUBTITLE[k]}
            </span>
            {v === k && (
              <span className="ml-2 font-mono text-[0.6875rem] text-muted-foreground">current</span>
            )}
          </div>
        )}
      />
    </>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/** Shared trigger styling for the sidebar's searchable property pickers. */
function PickerTrigger({
  onClick,
  children,
  placeholder,
}: {
  onClick: () => void;
  children?: React.ReactNode;
  placeholder: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1 text-left text-xs hover:bg-subtle"
    >
      {children ?? <span className="text-muted-foreground">{placeholder}</span>}
      <span className="ml-auto text-muted-foreground">▾</span>
    </button>
  );
}

type ProjectRow =
  | { kind: "none"; key: string }
  | {
      kind: "project";
      key: string;
      id: string;
      name: string;
      color: string | null;
      icon: string | null;
      initiativeName: string | null;
      issueCount: number;
    };

/**
 * Searchable project picker for the issue sidebar. Replaces the native
 * `<select>` — each row surfaces the project's owning **initiative** (the
 * issue→initiative link is transitive via project, so this is where you
 * act on it) plus its issue count.
 */
function ProjectPickerField({
  value,
  projects,
  onChange,
}: {
  value: string | null;
  projects: Array<{
    id: string;
    name: string;
    color?: string | null;
    icon?: string | null;
    initiative?: { name: string } | null;
    _count?: { issues: number };
  }>;
  onChange: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = projects.find((p) => p.id === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = projects.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      (p.initiative?.name.toLowerCase().includes(q) ?? false),
  );
  const items: ProjectRow[] = [
    { kind: "none", key: "__none" },
    ...filtered.map((p) => ({
      kind: "project" as const,
      key: p.id,
      id: p.id,
      name: p.name,
      color: p.color ?? null,
      icon: p.icon ?? null,
      initiativeName: p.initiative?.name ?? null,
      issueCount: p._count?.issues ?? 0,
    })),
  ];
  return (
    <>
      <PickerTrigger onClick={() => setOpen(true)} placeholder="— none —">
        {current && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: current.color ?? "var(--muted)" }}
            />
            <span className="truncate">{current.name}</span>
            {current.initiative?.name && (
              <span className="shrink-0 rounded bg-subtle px-1 text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
                {current.initiative.name}
              </span>
            )}
          </span>
        )}
      </PickerTrigger>
      <Picker<ProjectRow>
        open={open}
        onOpenChange={setOpen}
        placeholder="Move to project… (name or initiative)"
        items={items}
        getKey={(it) => it.key}
        onQueryChange={setQuery}
        emptyLabel="No projects match."
        onSelect={(it) => onChange(it.kind === "none" ? null : it.id)}
        renderItem={(it) => {
          if (it.kind === "none") {
            return (
              <div className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted" />
                <span className="text-muted-foreground">No project</span>
                {value === null && (
                  <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                    current
                  </span>
                )}
              </div>
            );
          }
          return (
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: it.color ?? "var(--muted)" }}
              />
              <span className="truncate">{it.name}</span>
              {it.initiativeName && (
                <span className="shrink-0 rounded bg-subtle px-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {it.initiativeName}
                </span>
              )}
              <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                {value === it.id ? "current" : `${it.issueCount}`}
              </span>
            </div>
          );
        }}
      />
    </>
  );
}

type CycleRow =
  | { kind: "none"; key: string }
  | {
      kind: "cycle";
      key: string;
      id: string;
      name: string;
      status: string;
      issueCount: number;
    };

/** Searchable Sprint (cycle) picker for the issue sidebar. */
function CyclePickerField({
  value,
  cycles,
  onChange,
}: {
  value: string | null;
  cycles: Array<{ id: string; name: string; status: string; _count?: { issues: number } }>;
  onChange: (cycleId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = cycles.find((c) => c.id === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = cycles.filter((c) => !q || c.name.toLowerCase().includes(q));
  const items: CycleRow[] = [
    { kind: "none", key: "__none" },
    ...filtered.map((c) => ({
      kind: "cycle" as const,
      key: c.id,
      id: c.id,
      name: c.name,
      status: c.status,
      issueCount: c._count?.issues ?? 0,
    })),
  ];
  return (
    <>
      <PickerTrigger onClick={() => setOpen(true)} placeholder="— no sprint —">
        {current && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{current.name}</span>
            <span className="shrink-0 rounded bg-subtle px-1 text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
              {current.status.toLowerCase()}
            </span>
          </span>
        )}
      </PickerTrigger>
      <Picker<CycleRow>
        open={open}
        onOpenChange={setOpen}
        placeholder="Move to sprint…"
        items={items}
        getKey={(it) => it.key}
        onQueryChange={setQuery}
        emptyLabel="No sprints match."
        onSelect={(it) => onChange(it.kind === "none" ? null : it.id)}
        renderItem={(it) => {
          if (it.kind === "none") {
            return (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">No sprint</span>
                {value === null && (
                  <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                    current
                  </span>
                )}
              </div>
            );
          }
          return (
            <div className="flex items-center gap-2">
              <span className="truncate">{it.name}</span>
              <span className="shrink-0 rounded bg-subtle px-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                {it.status.toLowerCase()}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                {value === it.id ? "current" : `${it.issueCount}`}
              </span>
            </div>
          );
        }}
      />
    </>
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
    <div className="relative w-full">
      <div className="flex flex-wrap items-center gap-1">
        {current.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => toggle(l.id)}
            title="Remove label"
            className="focus-ring inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground hover:bg-subtle"
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.color }} />
            {l.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="focus-ring text-meta inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-[9px] w-[9px]" /> Add
        </button>
      </div>
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
              <li className="px-3 py-3 text-center text-[0.6875rem] text-muted-foreground">
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
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="focus-ring flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-left text-[0.6875rem] hover:bg-subtle"
      >
        {current.length === 0 ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          <>
            <div className="flex -space-x-1.5">
              {current.slice(0, 3).map((a) => (
                <Avatar key={a.userId} name={a.name} image={a.image} size={16} />
              ))}
            </div>
            <span className="ml-1 text-muted-foreground">{current.length}</span>
          </>
        )}
        <span className="ml-auto text-muted-foreground">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-20 mt-1 w-[min(14rem,calc(100vw-2rem))] rounded-md border border-border bg-card shadow-lg"
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
              <li className="px-3 py-4 text-center text-[0.6875rem] text-muted-foreground">
                No workspace members.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent assignment — sibling to the user assignee picker
// ---------------------------------------------------------------------------

type AssignedAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
  status: AgentStatus;
  engagementMode?: EngagementModeValue | null;
} | null;

function AgentChip({ current, onOpen }: { current: AssignedAgent; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Assign agent (shift+a)"
      className={
        "focus-ring flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-left text-[0.6875rem] hover:bg-subtle sm:max-w-[16rem] " +
        (current ? "border-border" : "border-dashed border-border text-muted-foreground")
      }
    >
      {current ? (
        <>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-subtle text-[0.6875rem]">
            {current.avatar ? (
              <span aria-hidden>{current.avatar}</span>
            ) : (
              <span className="font-medium text-muted-foreground">
                {current.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <AgentPresenceDot
            status={current.status}
            size="sm"
            availability={presenceAvailability(current)}
          />
          <span className="min-w-0 truncate">{current.name}</span>
          <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
            @{current.profileKey}
          </span>
        </>
      ) : (
        <>
          <Bot className="h-[11px] w-[11px]" />
          <span>Assign agent</span>
        </>
      )}
      <span className="ml-auto text-muted-foreground">▾</span>
    </button>
  );
}

type PickerRow =
  | { kind: "unassign"; key: string }
  | {
      kind: "agent";
      key: string;
      id: string;
      name: string;
      profileKey: string;
      avatar: string | null;
      status: AgentStatus;
      lastHeartbeatAt: Date | null;
      capabilities: string[];
    };

function AgentPickerModal({
  open,
  onOpenChange,
  currentAgentId,
  defaultMode,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentAgentId: string | null;
  /** Workspace `assignmentEngagementMode` — the picker's starting mode. */
  defaultMode: EngagementModeValue;
  onSelect: (agentId: string | null, mode: EngagementModeValue) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<EngagementModeValue>(defaultMode);
  // Re-seed the mode whenever the picker reopens or the workspace default
  // changes — operators pick the agent fresh each time.
  useEffect(() => {
    if (open) setMode(defaultMode);
  }, [open, defaultMode]);
  const { data: agents, isLoading } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: open },
  );

  const q = query.trim().toLowerCase();
  const filteredAgents = (agents ?? []).filter((a) => {
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      a.profileKey.toLowerCase().includes(q) ||
      a.capabilities.some((c) => c.toLowerCase().includes(q))
    );
  });

  const items: PickerRow[] = [
    { kind: "unassign", key: "__unassign" },
    ...filteredAgents.map((a) => ({
      kind: "agent" as const,
      key: a.id,
      id: a.id,
      name: a.name,
      profileKey: a.profileKey,
      avatar: a.avatar,
      status: a.status,
      lastHeartbeatAt: a.lastHeartbeatAt,
      capabilities: a.capabilities,
    })),
  ];

  return (
    <Picker<PickerRow>
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Assign agent… (name, @profileKey, capability)"
      items={items}
      getKey={(it) => it.key}
      onQueryChange={setQuery}
      loading={isLoading}
      emptyLabel="No active agents match."
      onSelect={(it) => {
        if (it.kind === "unassign") onSelect(null, mode);
        else onSelect(it.id, mode);
      }}
      footer={
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
            Engagement mode
          </span>
          <div role="radiogroup" aria-label="Engagement mode" className="flex flex-wrap gap-1">
            {MODE_ORDER.map((m) => {
              const activeMode = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={activeMode}
                  // Stop the keystroke from reaching the Picker's list
                  // navigation; this control is mouse-driven.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMode(m)}
                  title={MODE_SUBTITLE[m]}
                  className={
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors " +
                    (activeMode
                      ? "border-ember/60 bg-ember/10"
                      : "border-border bg-card/30 text-muted-foreground hover:text-foreground")
                  }
                >
                  <EngagementModeGlyph mode={m} size={11} />
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
        </div>
      }
      renderItem={(it) => {
        if (it.kind === "unassign") {
          const active = currentAgentId === null;
          return (
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-muted" />
              <span className="text-muted-foreground">Unassign</span>
              {active && (
                <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                  current
                </span>
              )}
            </div>
          );
        }
        const active = currentAgentId === it.id;
        return (
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-subtle text-[0.6875rem]">
              {it.avatar ? (
                <span aria-hidden>{it.avatar}</span>
              ) : (
                <span className="font-medium text-muted-foreground">
                  {it.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            <AgentPresenceDot
              status={it.status}
              size="md"
              lastHeartbeatAt={it.lastHeartbeatAt}
              availability={presenceAvailability(it)}
            />
            <span className="truncate">{it.name}</span>
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              @{it.profileKey}
            </span>
            {it.capabilities.length > 0 && (
              // Capability pills — warm ember tone, with the full
              // capability label exposed via the title attribute so
              // operators can hover to disambiguate cryptic tags
              // (`triage-urgent`, `code-review`, etc.).
              <span
                className="ml-2 hidden min-w-0 flex-wrap items-center gap-1 sm:inline-flex"
                aria-label="Capabilities"
              >
                {it.capabilities.slice(0, 3).map((cap) => (
                  <span
                    key={cap}
                    title={`Capability: ${cap}`}
                    className="inline-flex items-center rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-ember"
                  >
                    {cap}
                  </span>
                ))}
                {it.capabilities.length > 3 && (
                  <span
                    title={`More capabilities: ${it.capabilities.slice(3).join(", ")}`}
                    className="inline-flex items-center rounded bg-subtle/60 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
                  >
                    +{it.capabilities.length - 3}
                  </span>
                )}
              </span>
            )}
            {active && (
              <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                current
              </span>
            )}
          </div>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Narrow `Issue.dispatchReason` (a `Json?` Prisma column) into the
 * `DispatchReason` shape `<DispatchReasonChip />` accepts. Returns
 * null when the column is absent or the blob is malformed — the
 * caller skips rendering the chip in that case.
 */
function coerceDispatchReason(blob: unknown): DispatchReason | null {
  if (!blob || typeof blob !== "object") return null;
  const r = blob as Record<string, unknown>;
  const mode = typeof r.mode === "string" ? r.mode : null;
  const picked = typeof r.picked === "string" ? r.picked : null;
  const reasonText = typeof r.reasonText === "string" ? r.reasonText : null;
  const decidedAt = typeof r.decidedAt === "string" ? r.decidedAt : null;
  const candidatesConsidered = Array.isArray(r.candidatesConsidered)
    ? (r.candidatesConsidered.filter((c) => typeof c === "string") as string[])
    : [];
  if (!mode || !picked || !reasonText || !decidedAt) return null;
  return {
    mode,
    picked,
    reasonText,
    decidedAt,
    candidatesConsidered,
    ...(typeof r.ruleId === "string" ? { ruleId: r.ruleId } : {}),
  };
}
