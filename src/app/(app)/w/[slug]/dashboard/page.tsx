"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Circle, Inbox, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { OperatorHome } from "@/components/dashboard/operator-home";
import { PersonalDashboard } from "@/components/dashboard/personal-dashboard";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";

export default function DashboardPage() {
  const workspace = useWorkspace();
  return workspace.experienceProfile === "PERSONAL" ? <PersonalDashboard /> : <TeamDashboard />;
}

function TeamDashboard() {
  const workspace = useWorkspace();

  return (
    <>
      <Topbar
        title="Dashboard"
        subtitle="Your work, decisions, agents, and workspace health."
        actions={
          <Link
            href={`/w/${workspace.slug}/inbox`}
            className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
            title="Open your action queue"
          >
            <Inbox className="h-3 w-3" />
            Inbox
            <ChevronRight className="h-3 w-3" />
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative isolate">
          <div
            className="mx-auto max-w-[100rem] space-y-4 p-4 sm:p-6"
            data-testid="dashboard-content"
          >
            <DashboardOnboarding slug={workspace.slug} />
            <OperatorHome />
          </div>
        </div>
      </div>
    </>
  );
}

function DashboardOnboarding({ slug }: { slug: string }) {
  const utils = trpc.useUtils();
  const { data: account } = trpc.user.me.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();
  const projects = trpc.project.list.useQuery({ archived: false, limit: 1 });
  const issues = trpc.issue.list.useQuery({ includeDone: true, limit: 1 });
  const members = trpc.workspace.members.useQuery();
  const canManageAccess = me?.role === "OWNER" || me?.role === "ADMIN";
  const access = trpc.access.list.useQuery(undefined, { enabled: canManageAccess });
  const dismiss = trpc.user.dismissOnboarding.useMutation({
    onSuccess: () => utils.user.me.invalidate(),
    onError: (error) => toast.error(error.message),
  });

  const ready = Boolean(
    account &&
    me &&
    projects.data &&
    issues.data &&
    members.data &&
    (!canManageAccess || access.data),
  );
  if (!ready || account?.onboardingDismissedAt) return null;

  const steps = [
    {
      label: "Project",
      hint: "Create a home for related work",
      done: (projects.data?.items.length ?? 0) > 0,
      href: `/w/${slug}/projects?new=1`,
    },
    {
      label: "Issue",
      hint: "Capture your first actionable item",
      done: (issues.data?.items.length ?? 0) > 0,
      href: `/w/${slug}/issues?new=1`,
    },
    {
      label: "Teammate",
      hint: "Invite another workspace member",
      done: (members.data?.length ?? 0) > 1 || account?.onboardingSkippedSteps.includes("member"),
      href: `/w/${slug}/settings/members`,
    },
    ...(canManageAccess
      ? [
          {
            label: "Agent access",
            hint: "Create an API key or MCP client",
            done: (access.data?.length ?? 0) > 0,
            href: `/w/${slug}/settings/access`,
          },
        ]
      : []),
  ];
  const remaining = steps.filter((step) => !step.done);
  if (remaining.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-ember/25 bg-ember/5 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ember/10 text-ember">
          <Rocket className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Finish setting up Forge</h2>
          <p className="text-meta truncate text-muted-foreground">
            {remaining.length} {remaining.length === 1 ? "step" : "steps"} left before the dashboard
            is fully connected.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {steps.map((step) => (
          <Link
            key={step.label}
            href={step.href}
            title={step.hint}
            className="focus-ring text-meta inline-flex items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 py-1 hover:border-ember/40"
          >
            {step.done ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Circle className="h-3 w-3 text-muted-foreground" />
            )}
            {step.label}
          </Link>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dismiss.mutate()}
          className="text-meta h-7 gap-1 text-muted-foreground"
        >
          Hide <ArrowRight className="h-3 w-3" />
        </Button>
      </div>
    </section>
  );
}
