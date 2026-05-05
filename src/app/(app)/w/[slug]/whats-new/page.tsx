"use client";
import { Sparkles } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Full changelog page — renders every parsed entry from
 * `system.changelogFull`. Uses the workspace shell layout (Topbar +
 * scroll wrapper) and respects `text-meta` / density utilities. We
 * keep the renderer simple: heading + grouped sublists by item type.
 * The full raw body is available on the response for future markdown
 * rendering, but for now we render the structured entries directly so
 * styling stays consistent with the dashboard tile.
 */
export default function WhatsNewPage() {
  const { data, isLoading } = trpc.system.changelogFull.useQuery();

  return (
    <>
      <Topbar
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-ember" />
            What&apos;s new
          </span>
        }
        subtitle="Recent changes — sourced from the repo CHANGELOG.md."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          {isLoading || !data ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-lg border border-border bg-card/40"
                />
              ))}
            </div>
          ) : data.entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/30 p-8 text-center text-sm text-muted-foreground">
              The CHANGELOG.md is empty or missing.
            </div>
          ) : (
            data.entries.map((entry) => (
              <section key={entry.version} className="space-y-3">
                <header className="flex items-baseline gap-2 border-b border-border pb-1">
                  <h2 className="text-base font-semibold tracking-tight">
                    {entry.heading}
                  </h2>
                </header>
                {entry.items.length === 0 ? (
                  <div className="text-meta italic text-muted-foreground">
                    No structured items recorded.
                  </div>
                ) : (
                  <ItemGroups items={entry.items} />
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}

const TYPE_ORDER: Array<"added" | "changed" | "fixed" | "removed"> = [
  "added",
  "changed",
  "fixed",
  "removed",
];

const TYPE_TONE: Record<string, string> = {
  added: "border-success/40 bg-success/10 text-success",
  changed: "border-ember/40 bg-ember/10 text-ember",
  fixed: "border-border bg-subtle text-muted-foreground",
  removed: "border-danger/40 bg-danger/10 text-danger",
};

function ItemGroups({
  items,
}: {
  items: Array<{
    type: "added" | "changed" | "fixed" | "removed";
    text: string;
  }>;
}) {
  const grouped = TYPE_ORDER.map((t) => ({
    type: t,
    items: items.filter((i) => i.type === t),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="space-y-3">
      {grouped.map((g) => (
        <div key={g.type}>
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center rounded border px-1.5 py-0 font-mono text-[0.625rem] uppercase tracking-wider",
                TYPE_TONE[g.type],
              )}
            >
              {g.type}
            </span>
          </div>
          <ul className="ml-1 space-y-1">
            {g.items.map((item, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm leading-relaxed text-foreground/90"
              >
                <span
                  className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
