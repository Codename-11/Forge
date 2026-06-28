"use client";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

/**
 * Contextual AI button next to the issue Description label. Draft (when the
 * description is empty) or Enhance (when it has one). The result is handed back
 * via `onResult` for a review/diff panel — this never writes the issue itself;
 * Apply happens in the parent. Hidden entirely when the workspace has AI off.
 */
export function DescriptionAiAssist({
  issueId,
  hasDescription,
  onResult,
}: {
  issueId: string;
  hasDescription: boolean;
  onResult: (r: { markdown: string; original: string | null }) => void;
}) {
  const { data: ws } = trpc.workspace.current.useQuery();
  const draftM = trpc.ai.draftDescription.useMutation({
    onSuccess: (r) => onResult({ markdown: r.markdown, original: null }),
    onError: (e) => toast.error(e.message),
  });
  const enhanceM = trpc.ai.enhanceDescription.useMutation({
    onSuccess: (r) => onResult({ markdown: r.markdown, original: r.original }),
    onError: (e) => toast.error(e.message),
  });
  const pending = draftM.isPending || enhanceM.isPending;

  if (!ws?.aiEnabled) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => (hasDescription ? enhanceM : draftM).mutate({ issueId })}
      title={
        hasDescription
          ? "Improve this description with AI"
          : "Draft a description from the title"
      }
      className="focus-ring inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
    >
      <Sparkles
        className={"h-3 w-3 text-amber-300" + (pending ? " animate-pulse" : "")}
      />
      {pending ? "Working…" : hasDescription ? "Enhance" : "Draft with AI"}
    </button>
  );
}
