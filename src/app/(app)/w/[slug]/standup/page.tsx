"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CheckCircle2,
  CircleDot,
  Clock,
  Copy,
  Moon,
  RefreshCw,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

type Group = {
  id: string;
  number: number;
  title: string;
  key: string;
};

const RANGES = [
  { hours: 24, label: "1d" },
  { hours: 72, label: "3d" },
  { hours: 168, label: "7d" },
] as const;

export default function StandupPage() {
  const ws = useWorkspace();
  const [since, setSince] = useState(24);
  const { data, isLoading, refetch, isFetching } = trpc.standup.draft.useQuery({
    sinceHours: since,
  });

  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!data?.markdown) return;
    await navigator.clipboard.writeText(data.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
    toast.success("Markdown copied — paste anywhere.");
  }

  const empty =
    !!data &&
    !data.groups.closed.length &&
    !data.groups.opened.length &&
    !data.groups.inProgress.length &&
    !data.groups.blocked.length;

  return (
    <>
      <Topbar
        title="Standup"
        subtitle="Auto-generated from your activity. Edit + paste wherever you report."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex h-8 items-center gap-0.5 rounded-md border border-border bg-card p-0.5 text-[0.6875rem]">
              {RANGES.map((r) => (
                <button
                  key={r.hours}
                  onClick={() => setSince(r.hours)}
                  className={cn(
                    "focus-ring rounded px-2 py-0.5 transition-colors",
                    since === r.hours
                      ? "bg-subtle text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={cn(
                  "mr-1 h-3 w-3",
                  isFetching && "motion-safe:animate-spin",
                )}
              />
              Refresh
            </Button>
            <Button size="sm" variant="ember" onClick={copy} disabled={!data}>
              <Copy className="mr-1 h-3 w-3" />
              {copied ? "Copied" : "Copy markdown"}
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 p-6">
          {isLoading || !data ? (
            <div className="rounded-lg border border-border bg-card/40 p-6 text-sm text-muted-foreground">
              Composing draft…
            </div>
          ) : empty ? (
            <div className="rounded-lg border border-border bg-card/30">
              <EmptyState
                variant="page"
                icon={<Moon />}
                title="Quiet window."
                description="Close issues, leave comments, or move tickets and the standup writes itself."
              />
            </div>
          ) : (
            <>
              {/* Counts strip — quick scan of the volume in this window
                  without scanning the bullet detail below. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <CountChip
                  Icon={CheckCircle2}
                  tone="closed"
                  label="closed"
                  n={data.counts.closed}
                />
                <CountChip
                  Icon={CircleDot}
                  tone="opened"
                  label="opened"
                  n={data.counts.opened}
                />
                <CountChip
                  Icon={CircleDot}
                  tone="continuing"
                  label="continuing"
                  n={data.counts.inProgress}
                />
                <CountChip
                  Icon={Clock}
                  tone="blocked"
                  label="blocked"
                  n={data.counts.blocked}
                />
                <span className="ml-auto text-meta text-muted-foreground">
                  Window: {data.sinceHours}h ·{" "}
                  <span className="font-mono">{data.workspaceKey}</span>
                </span>
              </div>

              <Section
                title="Closed"
                count={data.counts.closed}
                items={data.groups.closed}
                slug={ws.slug}
                tone="closed"
              />
              <Section
                title="Opened"
                count={data.counts.opened}
                items={data.groups.opened}
                slug={ws.slug}
                tone="opened"
              />
              <Section
                title="Continuing"
                count={data.counts.inProgress}
                items={data.groups.inProgress}
                slug={ws.slug}
                tone="continuing"
              />
              <Section
                title="Blocked / stalled"
                count={data.counts.blocked}
                items={data.groups.blocked}
                slug={ws.slug}
                tone="blocked"
                meta="No movement in 3d+"
              />

              <details className="rounded-lg border border-border bg-card/30">
                <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
                  Show raw markdown
                </summary>
                <pre className="whitespace-pre-wrap border-t border-border bg-background/50 p-4 font-mono text-[0.75rem] leading-relaxed">
                  {data.markdown}
                </pre>
              </details>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const TONE: Record<
  "closed" | "opened" | "continuing" | "blocked",
  { dot: string; chipBg: string; chipText: string }
> = {
  closed: {
    dot: "bg-success",
    chipBg: "bg-success/10",
    chipText: "text-success",
  },
  opened: { dot: "bg-sky-400", chipBg: "bg-sky-400/10", chipText: "text-sky-300" },
  continuing: {
    dot: "bg-warning",
    chipBg: "bg-warning/10",
    chipText: "text-warning",
  },
  blocked: {
    dot: "bg-danger",
    chipBg: "bg-danger/10",
    chipText: "text-danger",
  },
};

function CountChip({
  Icon,
  tone,
  label,
  n,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  tone: keyof typeof TONE;
  label: string;
  n: number;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
        TONE[tone].chipBg,
        TONE[tone].chipText,
        n === 0 && "opacity-50",
      )}
    >
      <Icon className="h-3 w-3" />
      <span className="font-mono">{n}</span>
      <span>{label}</span>
    </span>
  );
}

function Section({
  title,
  count,
  items,
  slug,
  tone,
  meta,
}: {
  title: string;
  count: number;
  items: Group[];
  slug: string;
  tone: keyof typeof TONE;
  meta?: string;
}) {
  if (count === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", TONE[tone].dot)} />
        <span className="text-sm font-medium">{title}</span>
        <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          {count}
        </span>
      </header>
      <ul className="divide-y divide-border/60">
        {items.map((it) => (
          <li key={it.id}>
            <Link
              href={`/w/${slug}/issues/${it.id}`}
              className="flex items-baseline gap-3 px-4 py-2 hover:bg-subtle/40"
            >
              <span className="shrink-0 font-mono text-[0.75rem] text-muted-foreground">
                {it.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {it.title}
              </span>
              {meta && (
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                  {meta}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
