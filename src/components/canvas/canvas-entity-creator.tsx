"use client";

import { useEffect, useRef, useState } from "react";
import { GitBranch, Loader2, StickyNote, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

// Inline entity-creation popover used by the canvas `entity-create`
// tool (W1.2). Mounts at a viewport-pixel position above the click
// site; commit fires `issue.create` or `note.create`, then asks the
// parent to drop a `CanvasNode` reference at the canvas-space anchor.
//
// We restrict v1 to issue + note — the two highest-frequency capture
// flows. Chat / plan / artifact need richer pickers (agent / steps /
// kind) so they're deferred to a later wave.

export type EntityCreatorAnchor = {
  /** Viewport-space pixel where the popover renders. */
  viewportX: number;
  viewportY: number;
  /** Canvas-space anchor where the resulting node should drop. */
  canvasX: number;
  canvasY: number;
};

export type EntityKind = "issue" | "note";

export type CreatedEntity = {
  kind: EntityKind;
  /** `Issue.id` or `Note.id`. */
  id: string;
  title: string;
  canvasX: number;
  canvasY: number;
};

type Props = {
  anchor: EntityCreatorAnchor;
  onClose: () => void;
  onCreated: (e: CreatedEntity) => void;
  initialKind?: EntityKind;
};

const POPOVER_WIDTH = 280;
const POPOVER_HEIGHT_HINT = 120;

export function CanvasEntityCreator({ anchor, onClose, onCreated, initialKind = "issue" }: Props) {
  const [kind, setKind] = useState<EntityKind>(initialKind);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [kind]);

  // Anchor: above the click by default; flip below if too high.
  const top =
    anchor.viewportY < POPOVER_HEIGHT_HINT + 12
      ? anchor.viewportY + 12
      : anchor.viewportY - POPOVER_HEIGHT_HINT - 12;
  const left = Math.max(12, anchor.viewportX - POPOVER_WIDTH / 2);

  const createIssue = trpc.issue.create.useMutation();
  const createNote = trpc.note.create.useMutation();

  const commit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    try {
      if (kind === "issue") {
        const row = await createIssue.mutateAsync({ title: trimmed });
        onCreated({
          kind: "issue",
          id: row.id,
          title: trimmed,
          canvasX: anchor.canvasX,
          canvasY: anchor.canvasY,
        });
      } else {
        const row = await createNote.mutateAsync({ body: trimmed, title: trimmed });
        onCreated({
          kind: "note",
          id: row.id,
          title: trimmed,
          canvasX: anchor.canvasX,
          canvasY: anchor.canvasY,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={cn(
        "absolute z-40 select-none rounded-md border border-border bg-card/95 p-2 shadow-lg backdrop-blur",
      )}
      style={{ top, left, width: POPOVER_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setKind("issue")}
            className={cn(
              "focus-ring inline-flex h-6 items-center gap-1 rounded px-2 text-[0.6875rem]",
              kind === "issue"
                ? "bg-ember/15 text-ember"
                : "text-muted-foreground hover:bg-subtle hover:text-foreground",
            )}
          >
            <GitBranch className="h-3 w-3" /> Issue
          </button>
          <button
            type="button"
            onClick={() => setKind("note")}
            className={cn(
              "focus-ring inline-flex h-6 items-center gap-1 rounded px-2 text-[0.6875rem]",
              kind === "note"
                ? "bg-ember/15 text-ember"
                : "text-muted-foreground hover:bg-subtle hover:text-foreground",
            )}
          >
            <StickyNote className="h-3 w-3" /> Note
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring h-5 w-5 rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          title="Close (Esc)"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={kind === "issue" ? "Issue title…" : "Note title…"}
        disabled={submitting}
        className="focus-ring h-7 w-full rounded border border-border bg-background px-2 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
          }
        }}
      />
      <div className="mt-1.5 flex items-center justify-between text-[0.6875rem] text-muted-foreground">
        <span>
          <kbd className="kbd">↩</kbd> create
        </span>
        {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
    </div>
  );
}
