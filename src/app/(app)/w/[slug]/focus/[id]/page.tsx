"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, Pause, Play, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Fullscreen deep-work surface for a single issue. Rendered under
 * `/w/[slug]/focus/[id]`, so workspace context + tRPC are seeded by the
 * workspace shell layout. To still feel chromeless the view overlays the
 * sidebar via `fixed inset-0 z-40`; pressing "Exit focus" just navigates
 * back to the issue detail which re-renders the normal shell.
 */
export default function FocusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const slug = workspace.slug;
  const { data: issue, isLoading } = trpc.issue.byId.useQuery({ id });
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: ws } = trpc.workspace.current.useQuery();
  const utils = trpc.useUtils();

  const update = trpc.issue.update.useMutation({
    onSuccess: () => utils.issue.byId.invalidate({ id }),
    onError: (e) => toast.error(e.message),
  });
  const createComment = trpc.comment.create.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id });
      setNote("");
    },
  });

  // Session timer
  const [running, setRunning] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const i = setInterval(() => setElapsed((t) => t + 1), 1000);
    return () => clearInterval(i);
  }, [running]);

  const [note, setNote] = useState("");

  if (isLoading || !issue)
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  function markDone() {
    const done = statuses?.find((s) => s.category === "DONE");
    if (!done) return toast.error("No 'Done' status defined.");
    update.mutate({ id: issue!.id, statusId: done.id });
    toast.success("Marked done.");
    setTimeout(() => router.push(`/w/${slug}/dashboard`), 400);
  }

  return (
    <main className="fixed inset-0 z-40 flex h-svh flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6 text-xs">
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" /> Exit focus
        </Button>
        <span className="font-mono text-muted-foreground">
          {ws ? formatIssueId(ws.key, issue.number) : issue.number}
        </span>
        <Badge color={issue.status.color}>{issue.status.name}</Badge>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[13px] tabular-nums">
            {mm}:{ss}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRunning((r) => !r)}
            aria-label={running ? "Pause" : "Resume"}
          >
            {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setElapsed(0)}
            aria-label="Reset timer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ember" size="sm" onClick={markDone} className="gap-1.5">
            <Check className="h-3.5 w-3.5" /> Mark done
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-8 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{issue.title}</h1>
        <article className="prose prose-sm mt-6 max-w-none whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/90">
          {issue.description || (
            <span className="text-muted-foreground">No description.</span>
          )}
        </article>

        <div className="mt-auto pt-8">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) return;
              createComment.mutate({ issueId: id, body: note.trim() });
            }}
            className="flex gap-2"
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Drop a progress note…"
            />
            <Button type="submit" disabled={!note.trim() || createComment.isPending}>
              Note
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
