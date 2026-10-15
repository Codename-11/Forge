"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Inbox, Layers } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Section, SkeletonList } from "@/components/ui";
import { WorkspaceBadge, type GlobalShellWorkspace } from "./global-shell";

/** Personal entry point: uses the same permission-filtered assignments as operations. */
export function PersonalHome({ workspaces }: { workspaces: GlobalShellWorkspace[] }) {
  const work = trpc.global.work.useQuery();
  const [expanded, setExpanded] = useState(false);
  const assignments = work.data ?? [];
  const visible = expanded ? assignments : assignments.slice(0, 8);

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-4 sm:p-8 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <Section
        title="Assigned to you"
        hint="Open assignments, most recently updated first."
        actions={
          <Link
            href="/inbox"
            className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
          >
            Open inbox →
          </Link>
        }
      >
        <Card>
          {work.isLoading ? (
            <SkeletonList rows={5} />
          ) : work.isError ? (
            <EmptyState
              title="Assignments are unavailable"
              description="Your workspaces are still available. Try loading your assignments again."
              action={
                <Button size="sm" variant="outline" onClick={() => void work.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : assignments.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 />}
              title="No open assignments"
              description="Open a workspace to create work or pick up an issue."
            />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((issue) => (
                <li key={issue.id}>
                  <Link
                    href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
                    className="focus-ring flex min-w-0 items-start gap-3 px-4 py-3 hover:bg-subtle"
                  >
                    <WorkspaceBadge ws={issue.workspace} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{issue.title}</span>
                      <span className="text-meta mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        <span className="text-id">
                          {issue.workspace.key}-{issue.number}
                        </span>
                        <span>{issue.workspace.name}</span>
                        <span>{issue.status.name}</span>
                      </span>
                    </span>
                    <ArrowRight
                      aria-hidden
                      className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {assignments.length > 8 && (
            <div className="border-t border-border p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Show fewer" : `Show ${assignments.length - 8} more`}
              </Button>
            </div>
          )}
          {assignments.length === 30 && (
            <p className="text-meta border-t border-border px-4 py-2 text-muted-foreground">
              Showing your 30 most recent assignments. Open a workspace to see its full issue list.
            </p>
          )}
        </Card>
      </Section>
      <div className="min-w-0 space-y-6">
        <Section
          title="Your workspaces"
          actions={
            <Link
              href="/workspaces"
              className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
            >
              Browse all →
            </Link>
          }
        >
          <Card>
            {workspaces.length === 0 ? (
              <EmptyState
                icon={<Layers />}
                title="Make room for your work"
                description="Create a workspace or ask its owner for an invitation."
                action={
                  <Link href="/workspaces" className="focus-ring rounded text-sm text-ember">
                    Explore workspaces →
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <Link
                      href={`/w/${workspace.slug}`}
                      className="focus-ring flex items-center gap-3 px-4 py-3 hover:bg-subtle"
                    >
                      <WorkspaceBadge ws={workspace} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {workspace.name}
                      </span>
                      <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Section>
        <Section title="Catch up">
          <Card>
            <Link
              href="/inbox"
              className="focus-ring flex items-start gap-3 px-4 py-3 hover:bg-subtle"
            >
              <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">Inbox</span>
                <span className="text-meta text-muted-foreground">
                  Inspect your assignments and their latest context.
                </span>
              </span>
            </Link>
            <Link
              href="/activity"
              className="focus-ring block border-t border-border px-4 py-3 text-sm hover:bg-subtle"
            >
              Recent workspace activity →
            </Link>
          </Card>
        </Section>
      </div>
    </div>
  );
}
