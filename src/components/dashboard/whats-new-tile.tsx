"use client";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * What's New tile — a compact list of the most recent CHANGELOG
 * entries, surfaced on the dashboard. Source of truth is
 * `/CHANGELOG.md` at the repo root, parsed by `system.changelog`.
 *
 * Visual: tight card with one or two entries shown by default
 * (limit=5 from the proc, but only the first row's items expand;
 * subsequent versions render as collapsed headings). "View all"
 * link at the bottom routes to the full /whats-new page which
 * renders the changelog body verbatim.
 */
export function WhatsNewTile({
  slug,
  seenAt = null,
}: {
  slug: string;
  /** User's `changelogSeenAt`. When the latest dated entry is newer (or
   *  this is null), an "unseen" dot shows until they open /whats-new. */
  seenAt?: string | Date | null;
}) {
  const { data, isLoading } = trpc.system.changelog.useQuery({ limit: 5 });

  // Newest dated entry vs. last-seen timestamp → "unseen" indicator.
  const latestDate = data?.entries.find((e) => e.date)?.date ?? null;
  const hasUnseen = !!latestDate && (!seenAt || new Date(latestDate) > new Date(seenAt));

  if (isLoading || !data) {
    return (
      <div className="rounded-lg border border-border bg-card/40 p-4">
        <div className="h-16 animate-pulse rounded bg-subtle/40" />
      </div>
    );
  }

  if (data.entries.length === 0) {
    return null;
  }

  // The first entry is rendered fully (heading + bullets); subsequent
  // entries are listed as collapsed heading rows so the rail signals
  // there's more without taking the whole tile.
  const [first, ...rest] = data.entries;
  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-card/40 p-4"
      data-testid="dashboard-whats-new"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-ember" aria-hidden />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          What&apos;s new
        </span>
        {hasUnseen && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-ember"
            title="New since you last looked"
            aria-label="New changes since you last looked"
          />
        )}
        <span className="text-meta min-w-0 text-muted-foreground/70">recent changes</span>
      </header>

      <div className="text-meta mb-2 line-clamp-2 font-medium text-foreground">{first.heading}</div>
      <ul className="flex flex-col gap-1">
        {first.items.slice(0, 4).map((item, i) => (
          <li
            key={i}
            className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground"
            data-whats-new-item
          >
            <ItemTypeChip type={item.type} />
            <span className="line-clamp-2 min-w-0 flex-1 leading-snug text-foreground/90">
              {item.text}
            </span>
          </li>
        ))}
      </ul>

      {rest.length > 0 && (
        <ul className="mt-3 flex flex-col gap-0.5 border-t border-border pt-2">
          {rest.slice(0, 3).map((entry, i) => (
            <li
              key={`${entry.version}-${entry.heading}-${i}`}
              className="text-meta truncate text-muted-foreground"
              title={entry.heading}
              data-whats-new-history
            >
              {entry.heading}
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/w/${slug}/whats-new`}
        className="text-meta mt-3 inline-block text-muted-foreground hover:text-foreground"
      >
        View all →
      </Link>
    </div>
  );
}

const TYPE_TONE: Record<"added" | "changed" | "fixed" | "removed", string> = {
  added: "border-success/40 bg-success/10 text-success",
  changed: "border-ember/40 bg-ember/10 text-ember",
  fixed: "border-border bg-subtle text-muted-foreground",
  removed: "border-danger/40 bg-danger/10 text-danger",
};

function ItemTypeChip({ type }: { type: "added" | "changed" | "fixed" | "removed" }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex shrink-0 items-center rounded border px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wider",
        TYPE_TONE[type] ?? "border-border bg-subtle text-muted-foreground",
      )}
    >
      {type}
    </span>
  );
}
