"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, FilePlus, Lightbulb, Pin } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Ideas tile — surfaces the top IDEA-status notes on the dashboard so
 * fresh captures don't get buried inside QuickNotesWidget. Pinned rows
 * float first; remaining slots fill by `updatedAt desc`. Each row has a
 * one-click "promote to issue" affordance that calls `notes.promote`
 * and navigates to the new issue on success.
 *
 * Hidden entirely when there are no IDEA-status notes — the inbox /
 * focus surfaces already cover the "you have nothing to do" case.
 */
export function IdeasTile({ slug }: { slug: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const listQ = trpc.note.list.useQuery(
    { status: "IDEA", limit: 5 },
    { staleTime: 30_000 },
  );

  const promote = trpc.note.promote.useMutation({
    onSuccess: (res) => {
      utils.note.list.invalidate();
      if (res.target.kind === "issue") {
        toast.success(`Created ${res.target.key}`);
        router.push(`/w/${slug}/issues/${res.target.id}`);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  if (listQ.isLoading) {
    return (
      <section className="rounded-lg border border-border bg-card/40 p-4">
        <div className="h-16 animate-pulse rounded bg-subtle/40" />
      </section>
    );
  }

  const items = listQ.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Lightbulb className="h-3.5 w-3.5 text-ember" aria-hidden />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Ideas
        </span>
        <span className="min-w-0 text-meta text-muted-foreground/70">
          fresh captures · IDEA
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-subtle px-1.5 font-mono text-[0.6875rem] text-muted-foreground">
          {items.length}
        </span>
      </header>
      <ul className="flex flex-col">
        {items.map((n) => {
          const displayTitle =
            n.title?.trim() || n.body.split("\n")[0]?.trim() || "Untitled";
          const excerpt = n.body.split("\n").slice(0, 1).join(" ");
          return (
            <li
              key={n.id}
              className="group flex flex-wrap items-start gap-2 border-b border-border/60 px-4 py-2 last:border-b-0 sm:flex-nowrap"
            >
              {n.pinned ? (
                <Pin className="mt-1 h-3 w-3 shrink-0 fill-current text-ember" />
              ) : (
                <Lightbulb className="mt-1 h-3 w-3 shrink-0 text-muted-foreground/60" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{displayTitle}</div>
                {excerpt && excerpt !== displayTitle && (
                  <div className="mt-0.5 line-clamp-1 text-meta text-muted-foreground">
                    {excerpt}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => promote.mutate({ noteId: n.id, kind: "issue" })}
                disabled={promote.isPending}
                className={cn(
                  "focus-ring ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-meta text-muted-foreground transition-colors hover:border-ember/40 hover:text-foreground sm:ml-0",
                  promote.isPending && "opacity-40",
                )}
                title="Promote this idea to a new issue"
              >
                <FilePlus className="h-3 w-3" />
                <span>Issue</span>
              </button>
            </li>
          );
        })}
      </ul>
      <footer className="flex items-center justify-end gap-1 border-t border-border px-4 py-1.5">
        <Link
          href={`/w/${slug}/dashboard`}
          className="focus-ring inline-flex items-center gap-1 rounded text-meta text-muted-foreground hover:text-foreground"
        >
          <span>Open all notes</span>
          <ArrowRight className="h-3 w-3" />
        </Link>
      </footer>
    </section>
  );
}
