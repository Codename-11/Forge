"use client";
import Link from "next/link";
import { ArrowRight, AtSign, Inbox, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IssueReference } from "@/components/issue-reference";
import { trpc } from "@/lib/trpc";

/**
 * "Needs you" — the dashboard's nudge toward decisions waiting on the
 * operator. Renders the top few open action-requests (incl. unassigned
 * plan-approval asks) and pending review gates as inline decision cards:
 * requester agent avatar/@handle + the quoted ask + a Resolve / Review
 * action.
 *
 * Resolve/Review deep-link to where the item is acted on rather than
 * mutating inline — the full accept/decline/answer + gate-resolve flows
 * live on the Command Center (action requests) and the gate target page
 * (review gates). Pulling the small list (cap ~3) here keeps the tile a
 * real prompt; the "View all" link carries the operator to the Command
 * Center for everything else.
 *
 * Renders nothing when the queue is empty, so it only ever appears as a
 * real prompt (no "all clear" clutter).
 */
const INLINE_CAP = 3;

export function NeedsYouTile({ slug }: { slug: string }) {
  // Reuse the same query Command Center renders from. `limit` caps the
  // server fetch; we slice to INLINE_CAP across both buckets below.
  const { data } = trpc.commandCenter.summary.useQuery(
    { limit: INLINE_CAP },
    { refetchOnWindowFocus: true, staleTime: 60_000 },
  );

  if (!data) return null;

  const actionRequests = data.actionRequests;
  const reviewGates = data.reviewGates;
  const total = data.counts.actionRequests + data.counts.reviewGates;
  if (total === 0) return null;

  // Build a single ordered list of inline cards: asks first, then gates,
  // capped at INLINE_CAP so the dashboard stays a glance, not a queue.
  type Card =
    | {
        kind: "ask";
        id: string;
        title: string;
        handle: string | null;
        avatar: string | null;
        issue: {
          id: string;
          number: number;
          title: string;
          workspace: { key: string; slug: string };
        } | null;
        completionIntent: "COMPLETE" | "RECOVER" | null;
      }
    | {
        kind: "gate";
        id: string;
        prompt: string;
        targetType: string;
        href: string | null;
      };

  const cards: Card[] = [];
  for (const r of actionRequests) {
    cards.push({
      kind: "ask",
      id: r.id,
      title: r.title,
      handle: r.requestedByAgent?.profileKey ?? null,
      avatar: r.requestedByAgent?.avatar ?? null,
      issue: r.issue,
      completionIntent: readCompletionIntent(r.payload),
    });
  }
  for (const g of reviewGates) {
    cards.push({
      kind: "gate",
      id: g.id,
      prompt: g.prompt,
      targetType: g.targetType,
      href: gateTargetHref(slug, g.targetType, g.targetId),
    });
  }
  const shown = cards.slice(0, INLINE_CAP);

  const commandCenterHref = `/w/${slug}/command-center`;

  return (
    <section className="rounded-lg border border-ember/30 bg-ember/5 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <Inbox className="h-3.5 w-3.5 text-ember" />
        <h3 className="text-sm font-semibold">Needs you</h3>
        <Badge className="bg-ember/15 text-ember">
          {total} {total === 1 ? "decision" : "decisions"}
        </Badge>
        <Link
          href={commandCenterHref}
          className="focus-ring text-meta ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </header>
      <ul className="flex flex-col gap-1.5">
        {shown.map((card) =>
          card.kind === "ask" ? (
            <li
              key={`ask-${card.id}`}
              className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-background p-2 sm:flex-nowrap"
            >
              {card.completionIntent ? (
                <span className="mt-1 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-ember motion-safe:animate-pulse motion-reduce:animate-none" />
              ) : card.avatar ? (
                <span className="mt-0.5 text-[0.875rem] leading-none">{card.avatar}</span>
              ) : (
                <AtSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  {card.completionIntent ? (
                    <span className="font-medium text-foreground">
                      {card.completionIntent === "COMPLETE"
                        ? "Ready to close"
                        : "Needs PR recovery"}
                    </span>
                  ) : card.handle ? (
                    <span className="font-medium text-foreground">@{card.handle}</span>
                  ) : (
                    <span className="font-medium text-foreground">An agent</span>
                  )}{" "}
                  {!card.completionIntent && "asks: "}
                  <span className="text-muted-foreground">&ldquo;{card.title}&rdquo;</span>
                </div>
                {card.issue ? (
                  <IssueReference
                    issue={card.issue}
                    href={`/w/${card.issue.workspace.slug}/i/${card.issue.workspace.key}-${card.issue.number}`}
                    className="text-meta mt-1 max-w-full"
                  />
                ) : (
                  <div className="text-meta mt-0.5 text-muted-foreground">
                    Workspace action request
                  </div>
                )}
              </div>
              <Link href={commandCenterHref} className="ml-auto shrink-0 sm:ml-0">
                <Button variant="ember" size="sm">
                  {card.completionIntent === "COMPLETE"
                    ? "Review close"
                    : card.completionIntent === "RECOVER"
                      ? "Recover"
                      : "Resolve"}
                </Button>
              </Link>
            </li>
          ) : (
            <li
              key={`gate-${card.id}`}
              className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-background p-2 sm:flex-nowrap"
            >
              <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  Review gate ·{" "}
                  <span className="text-muted-foreground">{card.prompt.slice(0, 80)}</span>
                </div>
                <div className="text-meta mt-0.5 text-muted-foreground">
                  {card.targetType.replace(/-/g, " ")} · awaiting your sign-off
                </div>
              </div>
              <Link href={card.href ?? commandCenterHref} className="ml-auto shrink-0 sm:ml-0">
                <Button variant="outline" size="sm">
                  Review
                </Button>
              </Link>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function readCompletionIntent(payload: unknown): "COMPLETE" | "RECOVER" | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const intent = (payload as Record<string, unknown>).intent;
  return intent === "COMPLETE" || intent === "RECOVER" ? intent : null;
}

/**
 * Resolve a review-gate target to a deep link where it can be acted on.
 * Mirrors the Command Center's resolver; returns null for target types we
 * can't route from id alone (those fall back to the Command Center link).
 */
function gateTargetHref(slug: string, targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "execution-plan":
      return `/w/${slug}/plans/${targetId}`;
    case "goal":
      return `/w/${slug}/goals/${targetId}`;
    case "issue":
      return `/w/${slug}/issues/${targetId}`;
    default:
      return null;
  }
}
