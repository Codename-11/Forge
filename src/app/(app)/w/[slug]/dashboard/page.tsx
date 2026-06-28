"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Globe,
  KeyRound,
  LayoutGrid,
  List as ListIcon,
  Mail,
  Plus,
  Rocket,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  UserPlus,
  X,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CycleChip } from "@/components/cycle-chip";
import { QuickNotesWidget } from "@/components/quick-notes-widget";
import { TodayWidget } from "@/components/dashboard/today-widget";
import { IdeasTile } from "@/components/dashboard/ideas-tile";
import { WhatsNewTile } from "@/components/dashboard/whats-new-tile";
import { AgentActivityTile } from "@/components/dashboard/agent-activity-tile";
import { NeedsYouTile } from "@/components/dashboard/needs-you-tile";
import { PulseTile } from "@/components/dashboard/pulse-tile";
import { IssueCard, type DashboardWorkCard } from "@/components/dashboard/issue-card";
import { AgentAttentionPanel } from "@/components/agent-attention-panel";
import { WorkspaceActivityTimeline } from "@/components/workspace-activity-timeline";
import {
  DashboardStack,
  type DashboardLayout,
  type DashboardWidget,
} from "@/components/dashboard/dashboard-stack";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";
import { useCountUp } from "@/lib/use-count-up";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * M6 (design spec): a metric that counts up from 0 once it scrolls into
 * view. rAF, no animation library; jumps straight to the value under
 * reduced-motion / motion-off, and tweens a given value only once per
 * mount (see {@link useCountUp}).
 */
function CountUp({ value, className }: { value: number; className?: string }) {
  const { value: n, ref } = useCountUp<HTMLSpanElement>(value);
  return (
    <span ref={ref} className={className}>
      {n}
    </span>
  );
}

const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};
const ONBOARDING_KEY = "forge:onboarding:dismissed";
const ONBOARDING_DONE_TOAST = "forge:onboarding:done-toast";

export default function DashboardPage() {
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const w = (p: string) => `/w/${slug}${p}`;
  const { data: me } = trpc.workspace.me.useQuery();
  const { data: account } = trpc.user.me.useQuery();
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: access } = trpc.access.list.useQuery();
  const active = trpc.issue.list.useQuery({ includeDone: false, limit: 100 });
  const anyIssue = trpc.issue.list.useQuery({ includeDone: true, limit: 1 });
  // "You" zone — Focus + Pick-up, enriched server-side into rich cards
  // (people / progress / activity / context). Replaces the old client-side
  // filter of the 100-issue `issue.list`.
  const myWork = trpc.dashboard.myWork.useQuery();

  const isAdmin = me?.role === "OWNER" || me?.role === "ADMIN";
  const prefs = useTimePrefs();

  const workspaceKey = ws?.key ?? "—";
  const firstName = (me?.user.name ?? me?.user.email ?? "").split(/[\s@]/)[0] || "there";
  const greeting = useGreeting();
  const focusCards = myWork.data?.focus ?? [];
  const resumeCards = myWork.data?.resume ?? [];
  const myWorkLoading = myWork.isLoading || !me;

  const statusRows = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of active.data?.items ?? []) map.set(i.statusId, (map.get(i.statusId) ?? 0) + 1);
    return (statuses ?? [])
      .filter((s) => s.category !== "DONE" && s.category !== "CANCELED")
      .map((s) => ({ status: s, count: map.get(s.id) ?? 0 }));
  }, [active.data, statuses]);

  const statusMax = useMemo(
    () => Math.max(1, ...statusRows.map((r) => r.count)),
    [statusRows],
  );


  // ---- Customizable widget stack -------------------------------------
  // Layout (order + hidden) persists on the user via `dashboardPrefs`.
  // Seeded once `user.me` lands; thereafter local state is authoritative
  // for the session and each change is pushed to the server.
  const setPrefsMut = trpc.user.setDashboardPrefs.useMutation();
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const layoutSeeded = useRef(false);
  useEffect(() => {
    if (layoutSeeded.current || !account) return;
    layoutSeeded.current = true;
    const p = account.dashboardPrefs as
      | { order?: string[]; hidden?: string[]; widths?: Record<string, "half" | "full"> }
      | null;
    setLayout({ order: p?.order ?? [], hidden: p?.hidden ?? [], widths: p?.widths ?? {} });
  }, [account]);
  const effLayout: DashboardLayout = layout ?? { order: [], hidden: [], widths: {} };
  const persistLayout = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      setPrefsMut.mutate({
        order: next.order,
        hidden: next.hidden,
        collapsed: [],
        widths: next.widths ?? {},
      });
    },
    [setPrefsMut],
  );

  // Zone-2 (Workspace & agents) widget stack. Agents lead the default
  // order; the rest stays user-reorderable/hideable via Customize. The
  // "Pick up where you left off" tile is gone — it's now a first-class
  // Zone-1 section rendered as rich cards.
  const widgets: DashboardWidget[] = useMemo(
    () => [
      {
        id: "agent-activity",
        title: "Agent activity",
        defaultWidth: "half",
        node: <AgentActivityTile slug={slug} />,
      },
      {
        id: "agent-attention",
        title: "Agent attention",
        defaultWidth: "half",
        node: <AgentAttentionPanel slug={slug} />,
      },
      {
        id: "today",
        title: "Today",
        defaultWidth: "half",
        node: <TodayWidget slug={slug} workspaceKey={workspaceKey} />,
      },
      { id: "pulse", title: "Pulse", defaultWidth: "half", node: <PulseTile slug={slug} /> },
      {
        id: "workspace-activity",
        title: "Workspace activity",
        defaultWidth: "full",
        node: <WorkspaceActivityTimeline limit={8} />,
      },
      { id: "standup", title: "Standup", defaultWidth: "half", node: <StandupTile slug={slug} /> },
      { id: "ideas", title: "Ideas", defaultWidth: "half", node: <IdeasTile slug={slug} /> },
      {
        id: "quick-notes",
        title: "Notes & journal",
        defaultWidth: "full",
        node: <QuickNotesWidget />,
      },
      {
        id: "whats-new",
        title: "What's new",
        defaultWidth: "half",
        node: (
          <WhatsNewTile slug={slug} seenAt={account?.changelogSeenAt ?? null} />
        ),
      },
    ],
    [slug, workspaceKey, account?.changelogSeenAt],
  );

  return (
    <>
      <Topbar
        title="Dashboard"
        subtitle="Workspace overview — onboarding, focus, recent done."
        actions={
          <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            <DashboardViewToggle slug={slug} />
            {editing && (
              <button
                type="button"
                onClick={() => persistLayout({ order: [], hidden: [], widths: {} })}
                className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
                title="Reset to the default layout"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className={cn(
                "focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem]",
                editing
                  ? "bg-ember/15 text-ember"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title="Reorder or hide dashboard widgets"
            >
              <SlidersHorizontal className="h-3 w-3" />
              {editing ? "Done" : "Customize"}
            </button>
            <ResumeSetupPill
              projectsCount={projects?.items.length ?? 0}
              issuesCount={anyIssue.data?.items.length ?? 0}
              membersCount={members?.length ?? 0}
              apiKeysCount={access?.length ?? 0}
              hasTimezone={!!me?.user.timezone}
              ready={!!me && !!projects && !!access && !!members}
              serverDismissedAt={account?.onboardingDismissedAt ?? null}
              skippedSteps={account?.onboardingSkippedSteps ?? []}
            />
            <Link
              href={`/w/${slug}/inbox`}
              className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
              title="Your action queue — pulse, queue, mentions, stalled (g i)"
            >
              Inbox
              <ChevronRight className="h-3 w-3" />
            </Link>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Ambient background now lives once in the app shell <main>
            (.forge-page-bg, driven by the per-user data-bg pref). */}
        <div className="relative isolate">
          <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
          <GreetingBar
            greeting={greeting}
            name={firstName}
            slug={slug}
            isAdmin={!!isAdmin}
            hasProjects={(projects?.items.length ?? 0) > 0}
          />

          <NeedsYouTile slug={slug} />

          <OnboardingCard
            projectsCount={projects?.items.length ?? 0}
            issuesCount={anyIssue.data?.items.length ?? 0}
            membersCount={members?.length ?? 0}
            apiKeysCount={access?.length ?? 0}
            hasTimezone={!!me?.user.timezone}
            ready={!!me && !!projects && !!access && !!members && !!account}
            slug={slug}
            serverDismissedAt={account?.onboardingDismissedAt ?? null}
            skippedSteps={account?.onboardingSkippedSteps ?? []}
          />

          {/* ── Zone 1 · YOU ─────────────────────────────────────────
              Focus (assigned, priority-first) + Pick-up (recent). Both
              render rich auto-height cards. If there's no personal work at
              all, Suggestions takes the slot as the primary handoff. */}
          {focusCards.length === 0 && resumeCards.length === 0 && !myWorkLoading ? (
            <SuggestionsStrip
              variant="primary"
              workspaceKey={workspaceKey}
              slug={slug}
            />
          ) : (
            <div className="space-y-5">
              {(focusCards.length > 0 || myWorkLoading) && (
                <section>
                  <SectionHeader
                    title="Focus today"
                    hint="Assigned to you, priority first."
                  />
                  <WorkCardGrid
                    cards={focusCards}
                    isLoading={myWorkLoading}
                    workspaceKey={workspaceKey}
                    tz={prefs.timezone ?? null}
                    slug={slug}
                  />
                </section>
              )}
              {resumeCards.length > 0 && (
                <section>
                  <SectionHeader
                    title="Pick up where you left off"
                    hint="Your most recently touched work."
                  />
                  <WorkCardGrid
                    cards={resumeCards}
                    isLoading={false}
                    workspaceKey={workspaceKey}
                    tz={prefs.timezone ?? null}
                    slug={slug}
                  />
                </section>
              )}
            </div>
          )}

          {/* ── Zone 2 · WORKSPACE & AGENTS ──────────────────────────
              Agents, attention, and the rest of the customizable stack;
              handoffs & stalled (the old under-Focus Suggestions, demoted
              here); and a by-status pipeline. */}
          <div className="space-y-5">
            <ZoneDivider label="Workspace & agents" />

            <DashboardStack
              widgets={widgets}
              layout={effLayout}
              editing={editing}
              onChange={persistLayout}
            />

            <SuggestionsStrip
              variant="secondary"
              workspaceKey={workspaceKey}
              slug={slug}
            />

            <section>
              <SectionHeader title="By status" hint="Active work across the pipeline" />
              <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                {statusRows.map(({ status, count }) => (
                  <li key={status.id}>
                    <Link
                      href={w("/issues")}
                      className="flex items-center gap-2 text-xs hover:text-foreground"
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: status.color }}
                      />
                      <span className="truncate">{status.name}</span>
                      <div className="mx-1 h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (count / statusMax) * 100)}%`,
                            backgroundColor: status.color,
                          }}
                        />
                      </div>
                      <CountUp
                        value={count}
                        className="font-mono tabular-nums text-muted-foreground"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function GreetingBar({
  greeting,
  name,
  slug,
  isAdmin,
  hasProjects,
}: {
  greeting: string;
  name: string;
  slug: string;
  isAdmin: boolean;
  hasProjects: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold tracking-tight">
          {greeting}, {name}.
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Decide what to move forward today. Small steps count.
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end">
        <Button data-quick-create variant="ember" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New issue
        </Button>
        {/* Templates matter when you're starting out; once the workspace
            has projects, the more useful CTA is a fresh project. */}
        {hasProjects ? (
          <Link href={`/w/${slug}/projects?new`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              New project
            </Button>
          </Link>
        ) : (
          <Link href={`/w/${slug}/projects?templates=1`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Rocket className="h-3.5 w-3.5" />
              Browse templates
            </Button>
          </Link>
        )}
        {/* Only admins/owners can actually invite — hide the dead button
            for everyone else instead of showing it unconditionally. */}
        {isAdmin && (
          <Link href={`/w/${slug}/settings/members`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Invite member
            </Button>
          </Link>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Zone helpers — rich work-card grid + zone divider
// ---------------------------------------------------------------------------

function WorkCardGrid({
  cards,
  isLoading,
  workspaceKey,
  tz,
  slug,
}: {
  cards: DashboardWorkCard[];
  isLoading: boolean;
  workspaceKey: string;
  tz: string | null;
  slug: string;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-card/40" />
        ))}
      </div>
    );
  }
  if (cards.length === 0) return null;
  // `items-start` so each card sizes to its own content instead of
  // stretching to the tallest sibling in the row — that stretch was the
  // source of the empty space between sparse cards.
  return (
    <ul className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <li key={card.id}>
          <IssueCard card={card} workspaceKey={workspaceKey} tz={tz} slug={slug} />
        </li>
      ))}
    </ul>
  );
}

/** Labeled hairline divider that opens a dashboard zone. */
function ZoneDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="shrink-0 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

type OnboardingStep = {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  icon: ComponentType<{ className?: string }>;
  href?: string;
  action?: "quick-create";
};

/**
 * Subscribe to the dismissed-flag in localStorage. The `forge:onboarding-dismissed`
 * window event lets the OnboardingCard and the Topbar pill stay in sync without
 * lifting state up to the page (which would force a re-render of every section).
 */
function useOnboardingDismissed(): [boolean, (next: boolean) => void] {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(ONBOARDING_KEY) === "1");
    } catch {
      /* ignore */
    }
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setDismissed(!!detail);
    };
    window.addEventListener("forge:onboarding-dismissed", onChange);
    return () => window.removeEventListener("forge:onboarding-dismissed", onChange);
  }, []);

  const update = useCallback((next: boolean) => {
    setDismissed(next);
    try {
      if (next) localStorage.setItem(ONBOARDING_KEY, "1");
      else localStorage.removeItem(ONBOARDING_KEY);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent("forge:onboarding-dismissed", { detail: next }),
    );
  }, []);

  return [dismissed, update];
}

function OnboardingCard({
  projectsCount,
  issuesCount,
  membersCount,
  apiKeysCount,
  hasTimezone,
  ready,
  slug,
  serverDismissedAt,
  skippedSteps,
}: {
  projectsCount: number;
  issuesCount: number;
  membersCount: number;
  apiKeysCount: number;
  hasTimezone: boolean;
  ready: boolean;
  slug: string;
  serverDismissedAt: Date | string | null;
  skippedSteps: string[];
}) {
  const [dismissed, setDismissed] = useOnboardingDismissed();
  const utils = trpc.useUtils();

  const dismissPermanently = trpc.user.dismissOnboarding.useMutation({
    onMutate: async () => {
      await utils.user.me.cancel();
      const prev = utils.user.me.getData();
      utils.user.me.setData(undefined, (cur) =>
        cur ? { ...cur, onboardingDismissedAt: new Date() } : cur,
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) utils.user.me.setData(undefined, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => utils.user.me.invalidate(),
  });

  const skipStep = trpc.user.skipOnboardingStep.useMutation({
    onMutate: async ({ stepId }) => {
      await utils.user.me.cancel();
      const prev = utils.user.me.getData();
      utils.user.me.setData(undefined, (cur) =>
        cur && !cur.onboardingSkippedSteps.includes(stepId)
          ? { ...cur, onboardingSkippedSteps: [...cur.onboardingSkippedSteps, stepId] }
          : cur,
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) utils.user.me.setData(undefined, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => utils.user.me.invalidate(),
  });

  const allSteps: OnboardingStep[] = useMemo(
    () => [
      { id: "project", label: "Create your first project", hint: "Group related issues.", done: projectsCount > 0, href: `/w/${slug}/projects`, icon: Rocket },
      { id: "issue", label: "Create an issue", hint: "Capture work. Press C anywhere.", done: issuesCount > 0, action: "quick-create", icon: Plus },
      { id: "member", label: "Invite a teammate", hint: "Work is better with others.", done: membersCount > 1, href: `/w/${slug}/settings/members`, icon: Mail },
      { id: "api", label: "Create an API key", hint: "Wire Forge into Hermes, Claude, or Codex.", done: apiKeysCount > 0, href: `/w/${slug}/settings/access`, icon: KeyRound },
      { id: "tz", label: "Set your timezone", hint: "Makes due dates sane.", done: hasTimezone, href: `/w/${slug}/settings/account`, icon: Globe },
    ],
    [projectsCount, issuesCount, membersCount, apiKeysCount, hasTimezone, slug],
  );

  const steps = useMemo(
    () => allSteps.filter((s) => !skippedSteps.includes(s.id)),
    [allSteps, skippedSteps],
  );

  const total = steps.length;
  const completed = steps.filter((s) => s.done).length;
  const allDone = ready && total > 0 && completed === total;

  useEffect(() => {
    if (!allDone) return;
    try {
      if (localStorage.getItem(ONBOARDING_DONE_TOAST) === "1") return;
      localStorage.setItem(ONBOARDING_DONE_TOAST, "1");
      toast.success("Nice — your workspace is set up.");
    } catch {
      /* ignore */
    }
  }, [allDone]);

  if (!ready) return null;
  if (serverDismissedAt) return null;
  if (dismissed || allDone) return null;

  function handleSkipPermanently() {
    dismissPermanently.mutate();
    // Mirror to localStorage so the Resume pill stays consistent within
    // this session even before the server roundtrip lands.
    setDismissed(true);
    toast.success("Onboarding skipped — resume from Settings → Account if you change your mind.");
  }

  function handleSkipStep(stepId: "member") {
    skipStep.mutate({ stepId });
    if (stepId === "member") {
      toast.success("Skipped — you can invite later from Settings → Members.");
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card/40 p-5">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Getting started</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {completed} of {total} steps complete.
          </div>
        </div>
        <button
          type="button"
          onClick={handleSkipPermanently}
          className="focus-ring rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
          title="Hide onboarding across every device. Re-enable from Settings → Account."
        >
          Skip permanently
        </button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss onboarding"
          title="Dismiss — you can resume from the pill in the topbar."
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-ember transition-all"
          style={{ width: total === 0 ? "100%" : `${(completed / total) * 100}%` }}
        />
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id}>
            <OnboardingRow
              step={s}
              onSkip={s.id === "member" ? () => handleSkipStep("member") : undefined}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Tiny pill rendered in the dashboard topbar when the user has dismissed
 * the OnboardingCard but onboarding isn't actually complete. Clicking it
 * clears the dismissed flag so the full card re-appears on the same page
 * load.
 */
function ResumeSetupPill({
  projectsCount,
  issuesCount,
  membersCount,
  apiKeysCount,
  hasTimezone,
  ready,
  serverDismissedAt,
  skippedSteps,
}: {
  projectsCount: number;
  issuesCount: number;
  membersCount: number;
  apiKeysCount: number;
  hasTimezone: boolean;
  ready: boolean;
  serverDismissedAt: Date | string | null;
  skippedSteps: string[];
}) {
  const [dismissed, setDismissed] = useOnboardingDismissed();
  const memberDone = membersCount > 1 || skippedSteps.includes("member");
  const allDone =
    ready &&
    projectsCount > 0 &&
    issuesCount > 0 &&
    memberDone &&
    apiKeysCount > 0 &&
    hasTimezone;
  if (!ready || serverDismissedAt || !dismissed || allDone) return null;
  return (
    <button
      type="button"
      onClick={() => setDismissed(false)}
      title="Re-open the getting-started checklist"
      className="text-meta inline-flex items-center gap-1 rounded-full border border-ember/30 bg-ember/10 px-2 py-0.5 text-[0.6875rem] uppercase tracking-wider text-ember hover:bg-ember/15"
    >
      <ArrowRight className="h-3 w-3" />
      <span>Resume setup</span>
    </button>
  );
}

function OnboardingRow({
  step,
  onSkip,
}: {
  step: OnboardingStep;
  onSkip?: () => void;
}) {
  const Icon = step.icon;
  const inner = (
    <div
      className={
        "flex h-full items-start gap-3 rounded-md border border-border bg-background/40 p-3 transition-colors " +
        (step.done ? "opacity-70" : "hover:border-ember/40")
      }
    >
      <div
        className={
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full " +
          (step.done
            ? "bg-ember text-ember-foreground"
            : "border border-border text-muted-foreground")
        }
      >
        {step.done ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{step.label}</div>
        <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">{step.hint}</div>
      </div>
      {!step.done && <ArrowRight className="mt-1 h-3 w-3 text-muted-foreground" />}
    </div>
  );
  const body = step.done ? (
    inner
  ) : step.action === "quick-create" ? (
    <button data-quick-create className="w-full text-left">
      {inner}
    </button>
  ) : (
    <Link href={step.href ?? "#"}>{inner}</Link>
  );
  if (!onSkip || step.done) return body;
  return (
    <div className="relative">
      {body}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSkip();
        }}
        className="focus-ring absolute right-2 top-2 rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:text-foreground"
        title="Skip this step. Re-enable from Settings → Account."
      >
        Skip
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h2 className="shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {hint && <span className="min-w-0 text-[0.6875rem] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useGreeting() {
  const [greeting, setGreeting] = useState("Hello");
  useEffect(() => {
    const h = new Date().getHours();
    if (h < 5) setGreeting("Still up");
    else if (h < 12) setGreeting("Good morning");
    else if (h < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);
  return greeting;
}

// ---------------------------------------------------------------------------
// Standup tile
// ---------------------------------------------------------------------------

/**
 * Compact dashboard tile for the standup draft. Replaces the dedicated
 * sidebar entry — the full page (`/standup`) still exists for editing
 * + copy-paste, but most of the time a glance + a copy button is all
 * the operator needs.
 */
function StandupTile({ slug }: { slug: string }) {
  const { data, isLoading } = trpc.standup.draft.useQuery({ sinceHours: 24 });
  const empty =
    !!data &&
    !data.groups.closed.length &&
    !data.groups.opened.length &&
    !data.groups.inProgress.length &&
    !data.groups.blocked.length;

  const total = data
    ? data.counts.closed +
      data.counts.opened +
      data.counts.inProgress +
      data.counts.blocked
    : 0;

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">Standup — last 24h</span>
        {data && total > 0 && (
          <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.6875rem] text-muted-foreground">
            {total}
          </span>
        )}
        <Link
          href={`/w/${slug}/standup`}
          className="ml-auto shrink-0 text-[0.75rem] text-muted-foreground hover:text-foreground"
        >
          Open →
        </Link>
      </header>
      <div className="p-4 text-[0.8125rem]">
        {isLoading || !data ? (
          <div className="text-muted-foreground">Composing…</div>
        ) : empty ? (
          <div className="text-muted-foreground">
            Quiet 24 hours. Close issues, leave comments, or move tickets and
            it&apos;ll fill in.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
            <StandupCount label="Closed" n={data.counts.closed} tone="success" />
            <StandupCount label="Opened" n={data.counts.opened} tone="info" />
            <StandupCount
              label="Continuing"
              n={data.counts.inProgress}
              tone="warning"
            />
            <StandupCount label="Blocked" n={data.counts.blocked} tone="danger" />
          </div>
        )}
      </div>
    </section>
  );
}

function StandupCount({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone: "success" | "info" | "warning" | "danger";
}) {
  const dot = {
    success: "bg-success",
    info: "bg-sky-400",
    warning: "bg-warning",
    danger: "bg-danger",
  }[tone];
  return (
    <div className="flex items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{n}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestions strip (Phase 1C)
// ---------------------------------------------------------------------------

/**
 * "What should I do next" — three buckets surfaced from
 * `dashboard.suggestions`: current sprint slice, unassigned-in-my-projects,
 * and stalled.
 *
 * Two visual modes:
 *   - `primary`   — Focus Today is empty, Suggestions takes the top slot.
 *                   Larger header, normal card tint, top of page.
 *   - `secondary` — Focus Today has items, Suggestions stays below as a
 *                   discoverability strip. Smaller header, dimmer cards,
 *                   wrapped in a `<details>` so a busy operator can collapse
 *                   it. Defaults to open so it actually surfaces work.
 *
 * Empty groups render nothing (no "no items" stub clutter). All three
 * buckets empty + `primary` → a single "you're caught up" CTA pointing at
 * the project create flow.
 *
 * The fetch limit comes from the server defaults (top-N per bucket) — no
 * `take`/`limit` magic number passed from the client. This way bumping the
 * server default scales every consumer.
 */
function SuggestionsStrip({
  variant,
  workspaceKey,
  slug,
}: {
  variant: "primary" | "secondary";
  workspaceKey: string;
  slug: string;
}) {
  const { data, isLoading } = trpc.dashboard.suggestions.useQuery();

  if (isLoading || !data) {
    if (variant === "secondary") return null;
    return (
      <section>
        <SectionHeader title="Suggestions" hint="Pick something to start." />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg border border-border bg-card/40"
            />
          ))}
        </div>
      </section>
    );
  }

  const sprint = data.currentSprintSlice;
  const unassigned = data.unassignedInMyProjects;
  const stalled = data.stalled;
  const allEmpty = sprint.length === 0 && unassigned.length === 0 && stalled.length === 0;

  if (allEmpty) {
    if (variant === "secondary") return null;
    return (
      <section className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-center">
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-subtle text-muted-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="mt-3 text-sm font-medium">You&apos;re caught up.</div>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          No assigned work, no orphan issues in your projects, nothing
          stalled. Start a new project to keep momentum.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href={`/w/${slug}/projects`}>
            <Button variant="ember" size="sm" className="gap-1.5">
              <Rocket className="h-3.5 w-3.5" />
              Start a new project
            </Button>
          </Link>
          <Button data-quick-create variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New issue
          </Button>
        </div>
      </section>
    );
  }

  if (variant === "secondary") {
    // Dimmer, collapsible. Subordinate to Focus Today.
    return (
      <details className="group rounded-lg border border-border bg-card/30" open>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          <Sparkles className="h-3 w-3" />
          <span>Suggestions</span>
          <span className="min-w-0 truncate font-mono normal-case tracking-normal text-muted-foreground/70">
            sprint · projects · stalled
          </span>
          <ChevronRight className="ml-auto h-3 w-3 transition-transform group-open:rotate-90" />
        </summary>
        <div className="grid grid-cols-1 gap-3 border-t border-border p-4 lg:grid-cols-3">
          {sprint.length > 0 && (
            <SuggestionsCard
              header={
                data.activeCycle ? (
                  <CycleChip
                    cycle={{
                      id: data.activeCycle.id,
                      name: data.activeCycle.name,
                      status: "ACTIVE",
                    }}
                    slug={slug}
                  />
                ) : (
                  <FallbackHeader label="Current sprint" />
                )
              }
              items={sprint}
              workspaceKey={workspaceKey}
              slug={slug}
              dim
            />
          )}
          {unassigned.length > 0 && (
            <SuggestionsCard
              header={<FallbackHeader label="Unassigned in your projects" />}
              items={unassigned}
              workspaceKey={workspaceKey}
              slug={slug}
              showProjectChip
              dim
            />
          )}
          {stalled.length > 0 && (
            <SuggestionsCard
              header={
                <FallbackHeader
                  label="Stalled"
                  hint={
                    data.stalledThresholdDays
                      ? `> ${data.stalledThresholdDays}d quiet`
                      : undefined
                  }
                />
              }
              items={stalled}
              workspaceKey={workspaceKey}
              slug={slug}
              showStalledTimestamp
              dim
            />
          )}
        </div>
      </details>
    );
  }

  // Primary mode — Focus is empty, Suggestions IS the page's top content.
  return (
    <section>
      <SectionHeader
        title="Pick something to start"
        hint="Suggestions from the active sprint, your projects, and stalled work."
      />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {sprint.length > 0 && (
          <SuggestionsCard
            header={
              data.activeCycle ? (
                <CycleChip
                  cycle={{
                    id: data.activeCycle.id,
                    name: data.activeCycle.name,
                    status: "ACTIVE",
                  }}
                  slug={slug}
                />
              ) : (
                <FallbackHeader label="Current sprint" />
              )
            }
            items={sprint}
            workspaceKey={workspaceKey}
            slug={slug}
          />
        )}
        {unassigned.length > 0 && (
          <SuggestionsCard
            header={<FallbackHeader label="Unassigned in your projects" />}
            items={unassigned}
            workspaceKey={workspaceKey}
            slug={slug}
            showProjectChip
          />
        )}
        {stalled.length > 0 && (
          <SuggestionsCard
            header={
              <FallbackHeader
                label="Stalled"
                hint={
                  data.stalledThresholdDays
                    ? `> ${data.stalledThresholdDays}d quiet`
                    : undefined
                }
              />
            }
            items={stalled}
            workspaceKey={workspaceKey}
            slug={slug}
            showStalledTimestamp
          />
        )}
      </div>
    </section>
  );
}

type SuggestionItem = {
  id: string;
  number: number;
  title: string;
  priority: string;
  updatedAt: Date | string;
  status: { id: string; name: string; category: string; color: string };
  project: { id: string; key: string; name: string; color: string | null; icon: string | null } | null;
};

function FallbackHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-xs font-semibold text-foreground/90">
        {label}
      </span>
      {hint && <span className="text-meta text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function SuggestionsCard({
  header,
  items,
  workspaceKey,
  slug,
  showProjectChip = false,
  showStalledTimestamp = false,
  dim = false,
}: {
  header: React.ReactNode;
  items: SuggestionItem[];
  workspaceKey: string;
  slug: string;
  showProjectChip?: boolean;
  showStalledTimestamp?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border p-3",
        dim ? "bg-card/30" : "bg-card/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{header}</div>
      <ul className="flex flex-col">
        {items.map((issue) => (
          <li key={issue.id}>
            <Link
              href={`/w/${slug}/issues/${issue.id}`}
              className="group flex min-w-0 items-center gap-2 rounded-md py-1 hover:bg-subtle/50"
            >
              <span className="w-5 shrink-0 text-center font-mono text-[0.6875rem] text-muted-foreground">
                {PRIORITY_GLYPH[issue.priority] ?? "—"}
              </span>
              {showProjectChip && issue.project ? (
                <Badge className="shrink-0 px-1.5 py-0.5" color={issue.project.color ?? undefined}>
                  {issue.project.key}
                </Badge>
              ) : null}
              <span className="text-id shrink-0 text-muted-foreground">
                {formatIssueId(workspaceKey, issue.number)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs">{issue.title}</span>
              {showStalledTimestamp ? (
                <span className="text-meta shrink-0 text-muted-foreground">
                  {relativeTime(issue.updatedAt)}
                </span>
              ) : (
                <Badge
                  className="ml-auto shrink-0"
                  color={issue.status.color}
                >
                  {issue.status.name}
                </Badge>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DashboardViewToggle({ slug }: { slug: string }) {
  const router = useRouter();
  const personalCanvas = trpc.user.personalCanvas.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const setView = trpc.user.setDashboardView.useMutation({
    onError: () => {/* silent — view toggle is best-effort persistence */},
  });
  const onCanvas = useCallback(() => {
    const id = personalCanvas.data?.id;
    if (!id) {
      toast.message("Preparing your canvas…");
      return;
    }
    setView.mutate({ view: "canvas" });
    router.push(`/w/${slug}/canvas/${id}`);
  }, [personalCanvas.data?.id, router, setView, slug]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      onCanvas();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCanvas]);
  return (
    <div
      className="inline-flex shrink-0 items-center rounded-md border border-border bg-card/40 p-0.5 text-[0.6875rem]"
      role="tablist"
      aria-label="Dashboard view"
    >
      <button
        type="button"
        role="tab"
        aria-selected="true"
        className="inline-flex items-center gap-1 rounded-sm bg-card px-2 py-1 text-foreground shadow-sm"
        title="List view (current)"
      >
        <ListIcon className="h-3 w-3" />
        List
      </button>
      <button
        type="button"
        role="tab"
        aria-selected="false"
        className="focus-ring inline-flex items-center gap-1 rounded-sm px-2 py-1 text-muted-foreground hover:text-foreground"
        onClick={onCanvas}
        disabled={personalCanvas.isLoading}
        title="Switch to your Personal canvas"
      >
        <LayoutGrid className="h-3 w-3" />
        Canvas
      </button>
    </div>
  );
}
