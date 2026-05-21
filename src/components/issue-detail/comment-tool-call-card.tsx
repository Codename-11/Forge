"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * `CommentToolCallCard` — collapsible tool-call summary rendered inline
 * inside an agent comment body. Visual + behavioural parity with the
 * `ToolCallCard` used by Mission Control's chat surface
 * (`src/components/mission-control/chat-message.tsx`). The chat card is
 * a private (non-exported) function and the constraints for this slice
 * forbid editing `chat-message.tsx`, so the look is duplicated here
 * verbatim — any visual tweak should land in both places.
 *
 * Source data: agent comments can embed one or more tool-call summaries
 * by emitting a fenced `:::tool` directive in the comment body:
 *
 *     :::tool
 *     {
 *       "name": "issues.transition",
 *       "args": { "issueId": "...", "statusId": "..." },
 *       "status": "executed",
 *       "summary": "Marked AXI-42 as Done"
 *     }
 *     :::
 *
 * The body parser (`splitToolDirectives` below) lifts each block out of
 * the body and renders one card per block above/below/between the
 * remaining markdown segments.
 */

export type CommentToolCallStatus =
  | "pending"
  | "approved"
  | "declined"
  | "executed"
  | "error";

export interface CommentToolCall {
  name: string;
  args: Record<string, unknown>;
  status: CommentToolCallStatus;
  summary?: string;
  result?: unknown;
}

const VALID_STATUSES: ReadonlyArray<CommentToolCallStatus> = [
  "pending",
  "approved",
  "declined",
  "executed",
  "error",
];

/**
 * Parse a comment body into an ordered list of markdown text segments
 * and embedded tool-call cards. Tolerates malformed JSON inside a
 * `:::tool … :::` block by surfacing the raw text as a markdown segment
 * — better to render the literal directive than to silently drop the
 * content the agent emitted.
 *
 * The fence pattern must live on its own line: a leading `:::tool` line
 * (case-insensitive, optional trailing whitespace) and a closing `:::`
 * line. Anything between is treated as JSON.
 */
export function splitToolDirectives(
  body: string,
): Array<{ kind: "md"; text: string } | { kind: "tool"; call: CommentToolCall }> {
  if (!body || !body.includes(":::tool")) {
    return [{ kind: "md", text: body ?? "" }];
  }
  const out: Array<
    { kind: "md"; text: string } | { kind: "tool"; call: CommentToolCall }
  > = [];
  const lines = body.split("\n");
  let buf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*:::\s*tool\s*$/i.test(ln)) {
      // Flush the markdown buffer accumulated so far.
      if (buf.length > 0) {
        out.push({ kind: "md", text: buf.join("\n") });
        buf = [];
      }
      // Capture lines until the closing fence.
      const jsonLines: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (/^\s*:::\s*$/.test(lines[j])) {
          closed = true;
          break;
        }
        jsonLines.push(lines[j]);
        j++;
      }
      const raw = jsonLines.join("\n").trim();
      const parsed = safeParseToolCall(raw);
      if (parsed) {
        out.push({ kind: "tool", call: parsed });
      } else {
        // Bad JSON — fall back to rendering the literal block as markdown
        // so the operator can still see what the agent emitted.
        out.push({
          kind: "md",
          text: ["```", raw, "```"].join("\n"),
        });
      }
      i = closed ? j + 1 : j;
      continue;
    }
    buf.push(ln);
    i++;
  }
  if (buf.length > 0) {
    out.push({ kind: "md", text: buf.join("\n") });
  }
  return out;
}

function safeParseToolCall(raw: string): CommentToolCall | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const name = typeof obj.name === "string" ? obj.name : null;
    if (!name) return null;
    const status: CommentToolCallStatus =
      typeof obj.status === "string" &&
      (VALID_STATUSES as readonly string[]).includes(obj.status)
        ? (obj.status as CommentToolCallStatus)
        : "executed";
    const args =
      obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
        ? (obj.args as Record<string, unknown>)
        : {};
    return {
      name,
      args,
      status,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      result: obj.result,
    };
  } catch {
    return null;
  }
}

export function CommentToolCallCard({ call }: { call: CommentToolCall }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(call.args, null, 2);
    } catch {
      return String(call.args);
    }
  }, [call.args]);
  let statusLabel: string;
  switch (call.status) {
    case "executed":
      statusLabel = "done";
      break;
    case "declined":
      statusLabel = "declined";
      break;
    case "error":
      statusLabel = "error";
      break;
    case "approved":
      statusLabel = "approved";
      break;
    case "pending":
    default:
      statusLabel = "pending";
      break;
  }
  const statusIsBad = call.status === "error" || call.status === "declined";
  return (
    <div className="my-1.5 rounded border border-border/60 bg-subtle/30 text-[0.6875rem]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3 text-ember" />
        <span className="font-mono text-foreground">{call.name}</span>
        {call.summary && !open && (
          <span className="truncate text-muted-foreground/80">
            — {call.summary}
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 text-[0.5625rem] uppercase tracking-wider",
            statusIsBad ? "text-destructive" : "text-muted-foreground/70",
          )}
        >
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/40 px-2 py-1.5">
          <pre className="overflow-x-auto rounded-sm bg-background/60 px-2 py-1 font-mono text-[0.6875rem] leading-relaxed text-foreground">
            <code>{json}</code>
          </pre>
          {call.summary && (
            <p
              className={cn(
                "text-[0.625rem]",
                call.status === "executed"
                  ? "text-foreground"
                  : statusIsBad
                    ? "text-destructive"
                    : "text-muted-foreground",
              )}
            >
              <span className="mr-1 font-mono">
                {call.status === "executed" ? "ok" : call.status}
              </span>
              {call.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
