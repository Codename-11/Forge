"use client";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckSquare,
  Clock,
  FileText,
  Inbox,
  Shield,
  Workflow,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Command Center — single daily-operator surface. Aggregates the
 * things demanding attention right now: action requests targeting
 * me, pending review gates, active and stalled agent runs, recently
 * updated artifacts, and issues due soon. Each card links to its
 * canonical detail page so all writes happen there.
 */
export default function CommandCenterPage() {
  const ws = useWorkspace();
  const { data, isLoading } = trpc.commandCenter.summary.useQuery({
    dueWindowDays: 7,
    limit: 20,
  });

  return (
    <>
      <Topbar
        title="Command Center"
        subtitle={
          data
            ? `${data.counts.actionRequests} asks · ${data.counts.reviewGates} gates · ${data.counts.activeRuns} active runs`
            : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={6} />
        ) : !data ? (
          <EmptyState
            variant="page"
            title="Nothing to load"
            description="The command center couldn't fetch its summary."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Section
              icon={<Inbox className="h-3.5 w-3.5" />}
              title="Asks for you"
              empty="Nothing waiting on you."
              count={data.actionRequests.length}
            >
              {data.actionRequests.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/inbox?actionRequest=${row.id}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{row.title}</span>
                    <SeverityChip severity={row.severity} />
                  </div>
                  {row.body ? (
                    <p className="line-clamp-2 text-meta text-muted-foreground">
                      {row.body}
                    </p>
                  ) : null}
                  {row.issue ? (
                    <span className="text-meta text-muted-foreground">
                      {row.issue.workspace.key}-{row.issue.number} · {row.issue.title}
                    </span>
                  ) : null}
                </Link>
              ))}
            </Section>

            <Section
              icon={<Shield className="h-3.5 w-3.5" />}
              title="Review gates"
              empty="No pending gates."
              count={data.reviewGates.length}
            >
              {data.reviewGates.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2"
                >
                  <span className="text-sm font-medium">{row.prompt.slice(0, 80)}</span>
                  <span className="text-meta text-muted-foreground">
                    {row.targetType} · {row.targetId.slice(0, 12)}…
                  </span>
                </div>
              ))}
            </Section>

            <Section
              icon={<Workflow className="h-3.5 w-3.5" />}
              title="Active runs"
              empty="No agents running."
              count={data.activeRuns.length}
            >
              {data.activeRuns.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.issue.workspace.key}-${row.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex items-center gap-2">
                    <Bot className="h-3 w-3 text-ember" />
                    <span className="text-sm font-medium">
                      @{row.agent.profileKey}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground truncate">
                      {row.issue.workspace.key}-{row.issue.number}
                    </span>
                  </div>
                  {row.currentStep ? (
                    <span className="text-meta text-muted-foreground">
                      {row.currentStep}
                    </span>
                  ) : null}
                </Link>
              ))}
            </Section>

            <Section
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              title="Stalled runs"
              empty="No stalled runs."
              count={data.stalledRuns.length}
              tone="warning"
            >
              {data.stalledRuns.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.issue.workspace.key}-${row.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-2 hover:border-warning"
                >
                  <span className="text-sm font-medium">
                    {row.issue.workspace.key}-{row.issue.number}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    @{row.agent.profileKey} · last event {new Date(row.lastEventAt).toLocaleString()}
                  </span>
                </Link>
              ))}
            </Section>

            <Section
              icon={<CalendarClock className="h-3.5 w-3.5" />}
              title="Due soon"
              empty="Nothing due in the next week."
              count={data.dueIssues.length}
            >
              {data.dueIssues.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/i/${row.workspace.key}-${row.number}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{row.title}</span>
                    <PriorityChip priority={row.priority} />
                  </div>
                  <span className="text-meta text-muted-foreground">
                    {row.workspace.key}-{row.number} · due {row.dueDate ? new Date(row.dueDate).toLocaleDateString() : "—"}
                  </span>
                </Link>
              ))}
            </Section>

            <Section
              icon={<FileText className="h-3.5 w-3.5" />}
              title="Recent artifacts"
              empty="No artifacts yet."
              count={data.recentArtifacts.length}
            >
              {data.recentArtifacts.map((row) => (
                <Link
                  key={row.id}
                  href={`/w/${ws.slug}/artifacts/${row.slug}`}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-2 hover:border-ember/40"
                >
                  <span className="text-sm font-medium">{row.title}</span>
                  <span className="text-meta text-muted-foreground">
                    {row.type.toLowerCase()} · {row.status.replace("_", " ").toLowerCase()}
                  </span>
                </Link>
              ))}
            </Section>

            {data.runningTimer && data.runningTimer.issue ? (
              <Section
                icon={<Clock className="h-3.5 w-3.5" />}
                title="Timer"
                empty=""
                count={1}
              >
                <Link
                  href={`/w/${ws.slug}/i/${data.runningTimer.issue.workspace.key}-${data.runningTimer.issue.number}`}
                  className="flex flex-col gap-1 rounded-md border border-ember/40 bg-ember/5 p-2 hover:border-ember"
                >
                  <span className="text-sm font-medium">
                    {data.runningTimer.issue.workspace.key}-{data.runningTimer.issue.number}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    Started {new Date(data.runningTimer.startedAt).toLocaleTimeString()}
                  </span>
                </Link>
              </Section>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

function Section({
  icon,
  title,
  empty,
  count,
  tone,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  count: number;
  tone?: "warning";
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 text-meta uppercase tracking-wide text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {icon}
          {title}
        </div>
        {count > 0 ? (
          <span
            className={
              tone === "warning"
                ? "inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning"
                : "inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px]"
            }
          >
            {count}
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-2">
        {count === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card/20 p-3 text-meta text-muted-foreground">
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function SeverityChip({ severity }: { severity: string }) {
  const tone =
    severity === "CRITICAL"
      ? "bg-destructive/20 text-destructive"
      : severity === "ERROR"
        ? "bg-destructive/10 text-destructive"
        : severity === "WARNING"
          ? "bg-warning/10 text-warning"
          : severity === "SUCCESS"
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-subtle text-muted-foreground";
  return (
    <span className={`rounded px-1 py-0.5 text-[10px] uppercase ${tone}`}>
      {severity.toLowerCase()}
    </span>
  );
}

function PriorityChip({ priority }: { priority: string }) {
  if (priority === "NONE") return null;
  const tone =
    priority === "URGENT"
      ? "bg-destructive/15 text-destructive"
      : priority === "HIGH"
        ? "bg-warning/15 text-warning"
        : "bg-subtle text-muted-foreground";
  return (
    <span className={`rounded px-1 py-0.5 text-[10px] uppercase ${tone}`}>
      {priority.toLowerCase()}
    </span>
  );
}
