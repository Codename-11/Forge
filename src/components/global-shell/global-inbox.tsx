"use client";

import Link from "next/link";
import { CircleDot } from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { WsChip } from "./mission-control-home";

/**
 * Global inbox — issues assigned to the signed-in user across every
 * workspace they belong to, read-only, each row stamped with a workspace
 * chip. The cross-workspace counterpart to a workspace's `/inbox`
 * (per the design's global nav). Writes happen inside a workspace.
 */
export function GlobalInbox() {
  const work = trpc.global.work.useQuery();
  const rows = work.data ?? [];

  return (
    <div className="mx-auto w-full max-w-[1100px] px-8 py-6">
      {work.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CircleDot />}
          title="Your inbox is clear"
          description="Issues assigned to you across all your workspaces show up here. Enter a workspace to pick up work."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card/40">
          {rows.map((issue, i) => (
            <Link
              key={issue.id}
              href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
              className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-subtle ${
                i > 0 ? "border-t border-border/60" : ""
              }`}
            >
              <WsChip ws={issue.workspace} />
              <span className="text-id tabular-nums text-muted-foreground" style={{ minWidth: 64 }}>
                {issue.workspace.key}-{issue.number}
              </span>
              <span className="flex-1 truncate text-sm">{issue.title}</span>
              {issue.status && (
                <span className="inline-flex h-4 items-center rounded bg-subtle px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {issue.status.name}
                </span>
              )}
              <span
                className="text-meta tabular-nums text-muted-foreground/70"
                style={{ minWidth: 52, textAlign: "right" }}
              >
                {relativeTime(issue.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
