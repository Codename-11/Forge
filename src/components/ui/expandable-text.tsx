"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Keeps long card copy at a predictable two-line height until the operator
 * explicitly asks to read it. The expanded state is intentionally local and
 * ephemeral: collapsing the card restores the clean queue scan pattern.
 */
export function ExpandableText({ content, className }: { content: string; className?: string }) {
  const contentId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    if (expanded) return;
    const node = textRef.current;
    if (!node) return;

    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, expanded]);

  return (
    <div className="min-w-0">
      <div
        ref={textRef}
        id={contentId}
        className={cn("whitespace-pre-wrap break-words", expanded ? "" : "line-clamp-2", className)}
      >
        {content}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="focus-ring mt-1 inline-flex items-center gap-0.5 rounded text-[0.6875rem] font-medium text-muted-foreground hover:text-foreground"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <>
              Show less <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              Show full <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}
