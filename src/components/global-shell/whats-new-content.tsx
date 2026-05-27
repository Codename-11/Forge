"use client";

import { useEffect } from "react";
import { Plus, Pencil, Wrench, Minus, type LucideIcon } from "lucide-react";
import { Spinner, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Global "What's New" — renders the canonical CHANGELOG.md (via
 * `system.changelogFull`) grouped per release (Version/date title +
 * Added / Changed / Fixed / Removed). Reachable from Mission Control and
 * Instance Admin. Marks the feed seen on mount (clears the unseen dot).
 */

const GROUPS: { type: "added" | "changed" | "fixed" | "removed"; label: string; icon: LucideIcon; cls: string }[] = [
  { type: "added", label: "Added", icon: Plus, cls: "text-emerald-600" },
  { type: "changed", label: "Changed", icon: Pencil, cls: "text-ember" },
  { type: "fixed", label: "Fixed", icon: Wrench, cls: "text-blue-600" },
  { type: "removed", label: "Removed", icon: Minus, cls: "text-muted-foreground" },
];

export function WhatsNewContent() {
  const { data, isLoading } = trpc.system.changelogFull.useQuery();
  const markSeen = trpc.user.markChangelogSeen.useMutation();
  const utils = trpc.useUtils();

  useEffect(() => {
    markSeen.mutate(undefined, {
      onSuccess: () => {
        void utils.system.changelog.invalidate();
      },
    });
    // once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = data?.entries ?? [];

  return (
    <div className="mx-auto w-full max-w-[820px] px-8 py-6">
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="No release notes yet" description="Shipped changes show up here, newest first." />
      ) : (
        <div className="flex flex-col gap-8">
          {entries.map((entry, i) => {
            // Heading format `## [YYYY-MM-DD] — vX.Y.Z · Title` → the release
            // name (version + title) lives after the em-dash; the bracket date
            // is the timestamp. Bare `## [YYYY-MM-DD]` falls back to the date.
            const dash = entry.heading?.indexOf(" — ") ?? -1;
            const title = dash >= 0 ? entry.heading.slice(dash + 3).trim() : entry.date ?? entry.version;
            return (
              <section key={`${entry.version}-${i}`} className="relative">
                <header className="mb-3 flex items-baseline gap-3 border-b border-border pb-2">
                  <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                  {entry.date && title !== entry.date && (
                    <span className="text-meta tabular-nums text-muted-foreground">{entry.date}</span>
                  )}
                  {i === 0 && (
                    <span className="ml-auto rounded-full border border-ember/30 bg-ember/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ember">
                      Latest
                    </span>
                  )}
                </header>
                <div className="flex flex-col gap-4">
                  {GROUPS.map((g) => {
                    const items = entry.items.filter((it) => it.type === g.type);
                    if (items.length === 0) return null;
                    const Ico = g.icon;
                    return (
                      <div key={g.type}>
                        <div className={cn("mb-1.5 inline-flex items-center gap-1.5 text-meta font-medium", g.cls)}>
                          <Ico size={12} />
                          {g.label}
                        </div>
                        <ul className="flex flex-col gap-1.5 pl-1">
                          {items.map((it, j) => (
                            <li key={j} className="flex gap-2 text-sm leading-snug">
                              <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                              <span className="text-foreground/90">{it.text}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
