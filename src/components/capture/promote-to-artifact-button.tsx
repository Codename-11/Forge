"use client";
import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ArtifactType } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

type SourceType = "chat-message" | "comment" | "note" | "agent-run" | "issue";

/**
 * Compact "promote to artifact" button. Drops into any source surface
 * that supports promotion — chat messages, comments, notes, agent run
 * summaries, issues. Opens a tiny inline picker for type, then routes
 * to the new artifact's detail page on success.
 *
 * Kept intentionally minimal: a full CaptureSheet (per the agentic
 * work OS plan) is a follow-up; this is the smallest viable promote
 * affordance that matches Wave 2's tRPC/MCP contract.
 */
export function PromoteToArtifactButton({
  sourceType,
  sourceId,
  defaultTitle,
  issueId,
  className,
  size = "sm",
}: {
  sourceType: SourceType;
  sourceId: string;
  defaultTitle?: string;
  issueId?: string;
  className?: string;
  size?: "sm" | "icon";
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ArtifactType>(ArtifactType.DOCUMENT);

  const promote = trpc.artifact.promoteFromSource.useMutation({
    onSuccess: ({ slug }) => {
      toast.success("Promoted to artifact");
      utils.artifact.list.invalidate();
      setOpen(false);
      window.location.href = `/w/${ws.slug}/artifacts/${slug}`;
    },
    onError: (e) => toast.error(e.message),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Promote to artifact"
        className={
          className ??
          `inline-flex items-center gap-1 rounded-md border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:border-ember/40 hover:bg-subtle ${
            size === "icon" ? "" : ""
          }`
        }
      >
        <FileText className="h-3 w-3" />
        {size === "icon" ? null : "Promote"}
      </button>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1 rounded-md border border-border bg-card/40 p-1">
      <select
        value={type}
        onChange={(e) => setType(e.target.value as ArtifactType)}
        className="rounded-sm bg-transparent text-[0.625rem]"
      >
        {Object.values(ArtifactType).map((t) => (
          <option key={t} value={t}>
            {t.toLowerCase()}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm bg-ember px-1.5 py-0.5 text-[0.625rem] font-medium text-ember-foreground hover:opacity-90"
        disabled={promote.isPending}
        onClick={() =>
          promote.mutate({
            sourceType,
            sourceId,
            type,
            title: defaultTitle,
            issueId,
          })
        }
      >
        {promote.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Save
      </button>
      <button
        type="button"
        className="rounded-sm px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-subtle"
        onClick={() => setOpen(false)}
      >
        ×
      </button>
    </div>
  );
}
