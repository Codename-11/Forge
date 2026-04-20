"use client";
import Link from "next/link";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  CircleDashed,
  Clock3,
  Globe,
  KeyRound,
  Mail,
  Plus,
  Rocket,
  UserPlus,
  X,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { formatIssueId, relativeTime } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";

const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};
const PRIORITY_RANK: Record<string, number> = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};
const ONBOARDING_KEY = "forge:onboarding:dismissed";
const ONBOARDING_DONE_TOAST = "forge:onboarding:done-toast";

export default function DashboardPage() {
  const { data: me } = trpc.workspace.me.useQuery();
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({ archived: false, limit: 100 });
  const { data: access } = trpc.access.list.useQuery();
  const active = trpc.issue.list.useQuery({ includeDone: false, limit: 100 });
  const anyIssue = trpc.issue.list.useQuery({ includeDone: true, limit: 1 });

  const isAdmin = me?.role === "OWNER" || me?.role === "ADMIN";
  const events = trpc.admin.events.useQuery({ limit: 8 }, { enabled: !!isAdmin, retry: false });
  const prefs = useTimePrefs();

  const workspaceKey = ws?.key ?? "—";
  const firstName = (me?.user.name ?? me?.user.email ?? "").split(/[\s@]/)[0] || "there";
  const greeting = useGreeting();
  const myId = me?.user.id;

  const focus = useMemo(() => {
    const items = active.data?.items ?? [];
    if (!myId) return [];
    return items
      .filter((i) => i.assignees.some((a) => a.userId === myId))
      .sort((a, b) => {
        const pr = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
        if (pr !== 0) return pr;
        const ad = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
        const bd = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
        return ad - bd;
      })
      .slice(0, 6);
  }, [active.data, myId]);

  const statusRows = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of active.data?.items ?? []) map.set(i.statusId, (map.get(i.statusId) ?? 0) + 1);
    return (statuses ?? [])
      .filter((s) => s.category !== "DONE" && s.category !== "CANCELED")
      .map((s) => ({ status: s, count: map.get(s.id) ?? 0 }));
  }, [active.data, statuses]);

  const stalled = useMemo(() => {
    const threshold = Date.now() - 3 * 86_400_000;
    return (active.data?.items ?? [])
      .filter((i) => i.status.category === "IN_PROGRESS")
      .filter((i) => new Date(i.updatedAt).getTime() < threshold)
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .slice(0, 8);
  }, [active.data]);

  const recent = useMemo(
    () =>
      [...(active.data?.items ?? [])]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 6),
    [active.data],
  );

  return (
    <>
      <Topbar title="Dashboard" subtitle="A clear place to start the day." />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-6">
          <GreetingBar greeting={greeting} name={firstName} />

          <OnboardingCard
            projectsCount={projects?.items.length ?? 0}
            issuesCount={anyIssue.data?.items.length ?? 0}
            membersCount={members?.length ?? 0}
            apiKeysCount={access?.length ?? 0}
            hasTimezone={!!me?.user.timezone}
            ready={!!me && !!projects && !!access && !!members}
          />

          <section>
            <SectionHeader title="Focus today" hint="Assigned to you, priority first." />
            <FocusGrid
              issues={focus}
              isLoading={active.isLoading || !me}
              workspaceKey={workspaceKey}
              tz={prefs.timezone ?? null}
            />
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {isAdmin && !events.isError ? (
              <Column title="Recent activity" hint="Workspace events">
                <Rows loading={events.isLoading} empty="No activity yet.">
                  {(events.data?.items ?? []).slice(0, 8).map((e) => (
                    <li key={e.id} className="flex items-center gap-2 text-xs">
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {e.kind.replace(/_/g, " ").toLowerCase()}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {relativeTime(e.createdAt)}
                      </span>
                    </li>
                  ))}
                </Rows>
              </Column>
            ) : (
              <Column title="Recent issues" hint="Most recently touched">
                <Rows loading={active.isLoading} empty="No active issues.">
                  {recent.map((i) => (
                    <IssueRow
                      key={i.id}
                      id={i.id}
                      number={i.number}
                      title={i.title}
                      priority={i.priority}
                      trailing={relativeTime(i.updatedAt)}
                      workspaceKey={workspaceKey}
                    />
                  ))}
                </Rows>
              </Column>
            )}

            <Column title="By status" hint="Active work across the pipeline">
              <Rows loading={!statuses} empty="No statuses configured.">
                {statusRows.map(({ status, count }) => (
                  <li key={status.id}>
                    <Link
                      href="/issues"
                      className="flex items-center gap-2 text-xs hover:text-foreground"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: status.color }}
                      />
                      <span className="truncate">{status.name}</span>
                      <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                        {count}
                      </span>
                    </Link>
                  </li>
                ))}
              </Rows>
            </Column>

            <Column title="Stalled" hint="In progress, quiet 3+ days">
              <Rows loading={active.isLoading} empty="Nothing stalled. Momentum intact.">
                {stalled.map((i) => (
                  <IssueRow
                    key={i.id}
                    id={i.id}
                    number={i.number}
                    title={i.title}
                    trailing={relativeTime(i.updatedAt)}
                    trailingTone="warn"
                    workspaceKey={workspaceKey}
                  />
                ))}
              </Rows>
            </Column>
          </section>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function GreetingBar({ greeting, name }: { greeting: string; name: string }) {
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
      <div className="flex flex-wrap items-center gap-1.5">
        <Button data-quick-create variant="ember" size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New issue
        </Button>
        <Link href="/projects">
          <Button variant="outline" size="sm" className="gap-1.5">
            <Rocket className="h-3.5 w-3.5" />
            Browse templates
          </Button>
        </Link>
        <Link href="/settings/members">
          <Button variant="outline" size="sm" className="gap-1.5">
            <UserPlus className="h-3.5 w-3.5" />
            Invite member
          </Button>
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Focus grid
// ---------------------------------------------------------------------------

type FocusIssue = {
  id: string;
  number: number;
  title: string;
  priority: string;
  dueDate: Date | string | null;
  status: { name: string; color: string };
  project?: { key: string; color: string | null } | null;
};

function FocusGrid({
  issues,
  isLoading,
  workspaceKey,
  tz,
}: {
  issues: FocusIssue[];
  isLoading: boolean;
  workspaceKey: string;
  tz: string | null;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-card/40" />
        ))}
      </div>
    );
  }
  if (issues.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-center">
        <div className="text-sm font-medium">Nothing on your plate.</div>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Either you&apos;re all caught up, or nothing has found its way to you. Pick something up
          or open a new issue.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link href="/issues">
            <Button variant="outline" size="sm">
              Browse open issues
            </Button>
          </Link>
          <Button data-quick-create variant="ember" size="sm">
            New issue
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {issues.map((issue) => (
        <li key={issue.id}>
          <Link
            href={`/issues/${issue.id}`}
            className="group flex h-full flex-col rounded-lg border border-border bg-card/40 p-3 transition-colors hover:border-ember/40"
          >
            <div className="flex items-center gap-2">
              <span className="w-5 text-center font-mono text-[11px] text-muted-foreground">
                {PRIORITY_GLYPH[issue.priority]}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatIssueId(workspaceKey, issue.number)}
              </span>
              <Badge className="ml-auto" color={issue.status.color}>
                {issue.status.name}
              </Badge>
            </div>
            <div className="mt-2 line-clamp-2 text-sm">{issue.title}</div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              {issue.project && (
                <Badge color={issue.project.color ?? undefined}>{issue.project.key}</Badge>
              )}
              {issue.dueDate && (
                <span className="flex items-center gap-1">
                  <Clock3 className="h-3 w-3" />
                  {formatDueDate(issue.dueDate, tz)}
                </span>
              )}
              <ArrowRight className="ml-auto h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
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

function OnboardingCard({
  projectsCount,
  issuesCount,
  membersCount,
  apiKeysCount,
  hasTimezone,
  ready,
}: {
  projectsCount: number;
  issuesCount: number;
  membersCount: number;
  apiKeysCount: number;
  hasTimezone: boolean;
  ready: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(ONBOARDING_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  const steps: OnboardingStep[] = useMemo(
    () => [
      { id: "project", label: "Create your first project", hint: "Group related issues.", done: projectsCount > 0, href: "/projects", icon: Rocket },
      { id: "issue", label: "Create an issue", hint: "Capture work. Press C anywhere.", done: issuesCount > 0, action: "quick-create", icon: Plus },
      { id: "member", label: "Invite a teammate", hint: "Work is better with others.", done: membersCount > 1, href: "/settings/members", icon: Mail },
      { id: "api", label: "Create an API key", hint: "Wire Forge into Claude or Hermes.", done: apiKeysCount > 0, href: "/settings/access", icon: KeyRound },
      { id: "tz", label: "Set your timezone", hint: "Makes due dates sane.", done: hasTimezone, href: "/settings/account", icon: Globe },
    ],
    [projectsCount, issuesCount, membersCount, apiKeysCount, hasTimezone],
  );

  const total = steps.length;
  const completed = steps.filter((s) => s.done).length;
  const allDone = ready && completed === total;

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

  if (!ready || dismissed || allDone) return null;

  return (
    <section className="rounded-lg border border-border bg-card/40 p-5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Getting started</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {completed} of {total} steps complete.
          </div>
        </div>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            try {
              localStorage.setItem(ONBOARDING_KEY, "1");
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
          aria-label="Dismiss onboarding"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-ember transition-all"
          style={{ width: `${(completed / total) * 100}%` }}
        />
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id}>
            <OnboardingRow step={s} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OnboardingRow({ step }: { step: OnboardingStep }) {
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
        <div className="mt-0.5 text-[11px] text-muted-foreground">{step.hint}</div>
      </div>
      {!step.done && <ArrowRight className="mt-1 h-3 w-3 text-muted-foreground" />}
    </div>
  );
  if (step.done) return inner;
  if (step.action === "quick-create") {
    return (
      <button data-quick-create className="w-full text-left">
        {inner}
      </button>
    );
  }
  return <Link href={step.href ?? "#"}>{inner}</Link>;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function Column({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Rows({
  loading,
  empty,
  children,
}: {
  loading: boolean;
  empty: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <ul className="space-y-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex h-5 animate-pulse rounded bg-subtle/60" />
        ))}
      </ul>
    );
  }
  const kids = Array.isArray(children) ? children : [children];
  if (kids.length === 0 || (kids.length === 1 && !kids[0])) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <CircleDashed className="h-3.5 w-3.5" />
        <span>{empty}</span>
      </div>
    );
  }
  return <ul className="space-y-1.5">{children}</ul>;
}

function IssueRow({
  id,
  number,
  title,
  priority,
  trailing,
  trailingTone,
  workspaceKey,
}: {
  id: string;
  number: number;
  title: string;
  priority?: string;
  trailing: string;
  trailingTone?: "warn";
  workspaceKey: string;
}) {
  return (
    <li>
      <Link href={`/issues/${id}`} className="flex items-center gap-2 text-xs hover:text-foreground">
        {priority && (
          <span className="w-5 text-center font-mono text-[10px] text-muted-foreground">
            {PRIORITY_GLYPH[priority]}
          </span>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatIssueId(workspaceKey, number)}
        </span>
        <span className="truncate">{title}</span>
        <span
          className={
            "ml-auto text-[10px] " +
            (trailingTone === "warn" ? "text-warning" : "text-muted-foreground")
          }
        >
          {trailing}
        </span>
      </Link>
    </li>
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

function formatDueDate(d: Date | string, tz: string | null) {
  const date = typeof d === "string" ? new Date(d) : d;
  const diffDays = Math.round((date.getTime() - Date.now()) / 86_400_000);
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays === -1) return "due yesterday";
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays <= 7) return `in ${diffDays}d`;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: tz ?? undefined,
    }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}
