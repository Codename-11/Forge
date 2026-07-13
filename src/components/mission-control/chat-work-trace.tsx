"use client";

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  ListTree,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatMarkdown } from "./chat-markdown";

export type ChatTraceToolStatus = "pending" | "approved" | "declined" | "executed" | "error";

export type ChatTraceToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ChatTraceToolStatus;
  requiresConfirm?: boolean;
  summary?: string;
  result?: unknown;
};

type ToolGroup = {
  key: string;
  label: string;
  calls: ChatTraceToolCall[];
  hasApproval: boolean;
};

export function ChatWorkTrace({
  thinking,
  tools = [],
  elapsedMs,
  live = false,
  threadId,
  onApprove,
  onDecline,
  className,
}: {
  thinking?: string;
  tools?: ChatTraceToolCall[];
  elapsedMs?: number | null;
  live?: boolean;
  threadId?: string;
  onApprove?: (callId: string, alwaysAllow?: boolean) => void;
  onDecline?: (callId: string) => void;
  className?: string;
}) {
  const hasThinking = Boolean(thinking?.trim());
  const hasTools = tools.length > 0;
  const pendingApprovals = tools.filter(
    (call) => call.status === "pending" && Boolean(call.requiresConfirm),
  ).length;
  const [open, setOpen] = useState(() => live || pendingApprovals > 0);
  const [thinkingOpen, setThinkingOpen] = useState(() => live && hasThinking);

  useEffect(() => {
    if (pendingApprovals > 0) setOpen(true);
  }, [pendingApprovals]);

  useEffect(() => {
    if (live && hasThinking) setThinkingOpen(true);
  }, [hasThinking, live]);

  const skillTools = useMemo(() => tools.filter((call) => isSkillCall(call.name)), [tools]);
  const runtimeTools = useMemo(() => tools.filter((call) => !isSkillCall(call.name)), [tools]);
  const skillGroups = useMemo(() => groupToolCalls(skillTools), [skillTools]);
  const runtimeGroups = useMemo(() => groupToolCalls(runtimeTools), [runtimeTools]);
  const doneCount = tools.filter((call) => call.status === "executed").length;
  const runningCount = tools.filter(
    (call) => call.status === "pending" || call.status === "approved",
  ).length;
  const errorCount = tools.filter(
    (call) => call.status === "error" || call.status === "declined",
  ).length;

  if (!hasThinking && !hasTools) return null;

  const elapsedLabel =
    typeof elapsedMs === "number" && elapsedMs > 0
      ? `Thought for ${formatElapsed(elapsedMs)}`
      : live
        ? "Thinking"
        : hasThinking
          ? "Thinking trace"
          : null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded border border-border/60 bg-subtle/25 text-[0.6875rem]",
        className,
      )}
      data-testid="chat-work-trace"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-subtle/45 hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <ListTree className={cn("h-3 w-3 text-ember", live && "motion-safe:animate-pulse")} />
        <span className="font-medium text-foreground">Work trace</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted-foreground">
          {[
            elapsedLabel,
            skillTools.length
              ? `${skillTools.length} skill${skillTools.length === 1 ? "" : "s"}`
              : null,
            runtimeTools.length
              ? `${runtimeTools.length} tool${runtimeTools.length === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" / ")}
        </span>
        {pendingApprovals > 0 && (
          <TraceChip tone="warning" title={`${pendingApprovals} approval request`}>
            {pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"}
          </TraceChip>
        )}
        {runningCount > 0 && (
          <TraceChip tone="info" title={`${runningCount} running`}>
            {runningCount} running
          </TraceChip>
        )}
        {doneCount > 0 && (
          <TraceChip tone="success" title={`${doneCount} done`}>
            {doneCount} done
          </TraceChip>
        )}
        {errorCount > 0 && (
          <TraceChip tone="danger" title={`${errorCount} failed or declined`}>
            {errorCount} issue{errorCount === 1 ? "" : "s"}
          </TraceChip>
        )}
      </button>

      {open && (
        <div className="space-y-1 border-t border-border/45 px-1.5 py-1.5">
          {hasThinking && (
            <div className="rounded border border-border/45 bg-background/35">
              <button
                type="button"
                onClick={() => setThinkingOpen((value) => !value)}
                className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground hover:text-foreground"
              >
                {thinkingOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <Brain className={cn("h-3 w-3 text-ember", live && "motion-safe:animate-pulse")} />
                <span className="font-mono">
                  {elapsedLabel ?? (live ? "Thinking" : "Thinking trace")}
                </span>
              </button>
              {thinkingOpen && (
                <div className="border-t border-border/35 px-2 py-1.5 italic text-muted-foreground">
                  <ChatMarkdown body={thinking ?? ""} className="text-muted-foreground" />
                </div>
              )}
            </div>
          )}
          {skillGroups.length > 0 && (
            <TraceToolSection
              title="Skills"
              groups={skillGroups}
              icon="skill"
              threadId={threadId}
              onApprove={onApprove}
              onDecline={onDecline}
            />
          )}
          {runtimeGroups.length > 0 && (
            <TraceToolSection
              title="Tools"
              groups={runtimeGroups}
              icon="tool"
              threadId={threadId}
              onApprove={onApprove}
              onDecline={onDecline}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TraceToolSection({
  title,
  groups,
  icon,
  threadId,
  onApprove,
  onDecline,
}: {
  title: string;
  groups: ToolGroup[];
  icon: "skill" | "tool";
  threadId?: string;
  onApprove?: (callId: string, alwaysAllow?: boolean) => void;
  onDecline?: (callId: string) => void;
}) {
  const [showAll, setShowAll] = useState(() => groups.some((group) => group.hasApproval));
  const visibleGroups = showAll ? groups : groups.slice(0, 4);
  const hiddenCount = Math.max(0, groups.length - visibleGroups.length);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 px-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {icon === "skill" ? (
          <Brain className="h-3 w-3 text-ember" />
        ) : (
          <Wrench className="h-3 w-3 text-ember" />
        )}
        <span>{title}</span>
        <span className="font-mono text-muted-foreground/55">{countCalls(groups)}</span>
      </div>
      <div className="space-y-1">
        {visibleGroups.map((group) => (
          <TraceToolGroupRow
            key={group.key}
            group={group}
            threadId={threadId}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex w-full items-center justify-center gap-1 rounded border border-border/45 bg-background/30 px-1.5 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:bg-subtle/45 hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" />
          Show {hiddenCount} more
        </button>
      )}
      {showAll && groups.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="flex w-full items-center justify-center gap-1 rounded border border-border/45 bg-background/30 px-1.5 py-1 text-[0.625rem] text-muted-foreground transition-colors hover:bg-subtle/45 hover:text-foreground"
        >
          <ChevronRight className="h-3 w-3" />
          Collapse list
        </button>
      )}
    </div>
  );
}

function TraceToolGroupRow({
  group,
  threadId,
  onApprove,
  onDecline,
}: {
  group: ToolGroup;
  threadId?: string;
  onApprove?: (callId: string, alwaysAllow?: boolean) => void;
  onDecline?: (callId: string) => void;
}) {
  const [open, setOpen] = useState(group.hasApproval);
  useEffect(() => {
    if (group.hasApproval) setOpen(true);
  }, [group.hasApproval]);

  const statusCounts = countStatuses(group.calls);
  return (
    <div className="overflow-hidden rounded border border-border/45 bg-background/35">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-left text-muted-foreground transition-colors hover:bg-subtle/40 hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <ToolStatusIcon calls={group.calls} />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{group.label}</span>
        {group.calls.length > 1 && (
          <span className="rounded border border-border/45 bg-card/35 px-1 py-0 font-mono text-[0.5625rem] text-muted-foreground">
            x{group.calls.length}
          </span>
        )}
        <StatusSummary counts={statusCounts} />
      </button>
      {open && (
        <div className="space-y-1 border-t border-border/35 px-2 py-1.5">
          {group.calls.map((call) => (
            <TraceToolCallDetail
              key={call.id}
              call={call}
              showName={group.calls.length > 1}
              threadId={threadId}
              onApprove={onApprove}
              onDecline={onDecline}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceToolCallDetail({
  call,
  showName,
  threadId,
  onApprove,
  onDecline,
}: {
  call: ChatTraceToolCall;
  showName: boolean;
  threadId?: string;
  onApprove?: (callId: string, alwaysAllow?: boolean) => void;
  onDecline?: (callId: string) => void;
}) {
  const [argsOpen, setArgsOpen] = useState(call.status === "pending" && call.requiresConfirm);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const awaitingConfirm = call.status === "pending" && Boolean(call.requiresConfirm);
  const running = call.status === "pending" || call.status === "approved";
  const canvasPreview = useMemo(() => renderCanvasToolPreview(call), [call]);
  const hasArgs = useMemo(() => hasToolArguments(call.args), [call.args]);
  const json = useMemo(() => stringifyToolValue(call.args), [call.args]);

  return (
    <div className="space-y-1">
      {showName && (
        <div className="flex items-center justify-between gap-2 text-[0.625rem]">
          <span className="truncate font-mono text-foreground">{call.id}</span>
          <span className={cn("shrink-0 uppercase tracking-wider", statusTone(call.status))}>
            {statusLabel(call)}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={() => setArgsOpen((value) => !value)}
        className="flex w-full items-center gap-1 text-left text-[0.625rem] text-muted-foreground hover:text-foreground"
      >
        {argsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{hasArgs || canvasPreview ? "Input" : "No input arguments"}</span>
        {!showName && (
          <span className={cn("ml-auto uppercase tracking-wider", statusTone(call.status))}>
            {statusLabel(call)}
          </span>
        )}
      </button>
      {argsOpen && (
        <div className="rounded border border-border/35 bg-card/25 px-1.5 py-1">
          {canvasPreview ??
            (hasArgs ? (
              <ChatMarkdown body={"```json\n" + json + "\n```"} />
            ) : (
              <p className="text-[0.625rem] text-muted-foreground">No input arguments.</p>
            ))}
        </div>
      )}
      {awaitingConfirm && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onApprove?.(call.id, alwaysAllow)}
              className="rounded border border-ember/40 bg-ember/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-ember transition-colors hover:bg-ember/25"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onDecline?.(call.id)}
              className="rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground transition-colors hover:text-foreground"
            >
              Decline
            </button>
          </div>
          {threadId && (
            <label className="flex cursor-pointer items-center gap-1.5 text-[0.5625rem] text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                checked={alwaysAllow}
                onChange={(event) => setAlwaysAllow(event.target.checked)}
                className="h-3 w-3 rounded border-border bg-card/40 text-ember focus:ring-ember/40"
              />
              Always allow <span className="font-mono">{displayToolName(call.name)}</span> here
            </label>
          )}
        </div>
      )}
      {running && !awaitingConfirm && (
        <p className="text-[0.5625rem] italic text-muted-foreground/60">Running tool...</p>
      )}
      {(call.status === "executed" || call.status === "error" || call.status === "declined") &&
        call.summary && (
          <p
            className={cn(
              "text-[0.625rem]",
              call.status === "executed" ? "text-foreground" : "text-destructive",
            )}
          >
            <span className="mr-1 font-mono">{call.status === "executed" ? "ok" : "fail"}</span>
            {call.summary}
          </p>
        )}
    </div>
  );
}

function TraceChip({
  tone,
  title,
  children,
}: {
  tone: "success" | "warning" | "danger" | "info";
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "hidden shrink-0 rounded border px-1 py-0 font-mono text-[0.5625rem] sm:inline-flex",
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "info" && "border-ember/30 bg-ember/10 text-ember",
      )}
    >
      {children}
    </span>
  );
}

function ToolStatusIcon({ calls }: { calls: ChatTraceToolCall[] }) {
  const counts = countStatuses(calls);
  if (counts.error > 0 || counts.declined > 0) {
    return <XCircle className="text-destructive h-3 w-3" />;
  }
  if (counts.approvals > 0) {
    return <ShieldCheck className="h-3 w-3 text-amber-700 dark:text-amber-300" />;
  }
  if (counts.pending > 0 || counts.approved > 0) {
    return <Clock3 className="h-3 w-3 text-ember motion-safe:animate-pulse" />;
  }
  if (counts.executed > 0) {
    return <CheckCircle2 className="h-3 w-3 text-emerald-700 dark:text-emerald-300" />;
  }
  return <CircleDot className="h-3 w-3 text-muted-foreground" />;
}

function StatusSummary({ counts }: { counts: ReturnType<typeof countStatuses> }) {
  const items = [
    counts.approvals > 0
      ? { label: `${counts.approvals} approval`, tone: "text-amber-700 dark:text-amber-300" }
      : null,
    counts.pending + counts.approved > 0
      ? { label: `${counts.pending + counts.approved} running`, tone: "text-ember" }
      : null,
    counts.executed > 0
      ? { label: `${counts.executed} done`, tone: "text-muted-foreground/70" }
      : null,
    counts.error + counts.declined > 0
      ? { label: `${counts.error + counts.declined} issue`, tone: "text-destructive" }
      : null,
  ].filter(Boolean) as Array<{ label: string; tone: string }>;
  if (items.length === 0) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1 sm:inline-flex">
      {items.map((item) => (
        <span key={item.label} className={cn("font-mono text-[0.5625rem]", item.tone)}>
          {item.label}
        </span>
      ))}
    </span>
  );
}

function renderCanvasToolPreview(call: ChatTraceToolCall): ReactElement | null {
  const a = call.args as Record<string, unknown>;
  switch (call.name) {
    case "canvases.addNode":
    case "canvases_addNode": {
      const targetType = String(a.targetType ?? "node");
      const targetId = a.targetId ? String(a.targetId) : null;
      const x = typeof a.x === "number" ? Math.round(a.x) : 0;
      const y = typeof a.y === "number" ? Math.round(a.y) : 0;
      return (
        <div className="space-y-1">
          <p className="text-[0.625rem] text-muted-foreground">
            Add <span className="text-foreground">{targetType}</span>
            {targetId && <span className="ml-1 font-mono text-foreground/80">{targetId}</span>}
            <span className="ml-1">at</span>
            <span className="ml-1 font-mono">
              ({x}, {y})
            </span>
          </p>
          <div className="flex h-12 w-full items-center justify-center rounded border border-dashed border-border bg-card/40 text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
            preview / {targetType}
          </div>
        </div>
      );
    }
    case "canvases.addEdge":
    case "canvases_addEdge": {
      const from = a.fromNodeId ? String(a.fromNodeId).slice(-6) : "?";
      const to = a.toNodeId ? String(a.toNodeId).slice(-6) : "?";
      const label = a.label ? String(a.label) : null;
      return (
        <div className="space-y-1">
          <p className="text-[0.625rem] text-muted-foreground">
            Connect <span className="font-mono text-foreground">{from}</span>
            <span className="mx-1">to</span>
            <span className="font-mono text-foreground">{to}</span>
            {label && <span className="ml-1 italic">&quot;{label}&quot;</span>}
          </p>
          <svg viewBox="0 0 200 40" className="h-10 w-full">
            <defs>
              <marker
                id={`chat-trace-arrow-${call.id}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0,0 L10,5 L0,10 z" className="fill-foreground/60" />
              </marker>
            </defs>
            <path
              d="M 20,20 C 80,20 120,20 180,20"
              className="fill-none stroke-foreground/60"
              strokeWidth={1.5}
              markerEnd={`url(#chat-trace-arrow-${call.id})`}
            />
          </svg>
        </div>
      );
    }
    case "canvases.shapeAdd":
    case "canvases_shapeAdd": {
      const kind = String(a.kind ?? "box");
      const w = typeof a.width === "number" ? a.width : 120;
      const h = typeof a.height === "number" ? a.height : 60;
      const x = typeof a.x === "number" ? Math.round(a.x) : 0;
      const y = typeof a.y === "number" ? Math.round(a.y) : 0;
      return (
        <div className="space-y-1">
          <p className="text-[0.625rem] text-muted-foreground">
            Add <span className="text-foreground">{kind}</span>
            <span className="ml-1">at</span>
            <span className="ml-1 font-mono">
              ({x}, {y})
            </span>
          </p>
          <svg viewBox="0 0 200 80" className="h-16 w-full">
            {kind === "ellipse" ? (
              <ellipse
                cx={100}
                cy={40}
                rx={Math.min(80, w / 2)}
                ry={Math.min(30, h / 2)}
                className="fill-transparent stroke-foreground/60"
                strokeWidth={1.5}
              />
            ) : kind === "line" || kind === "arrow" ? (
              <line
                x1={20}
                y1={40}
                x2={180}
                y2={40}
                className="stroke-foreground/60"
                strokeWidth={1.5}
              />
            ) : kind === "text" ? (
              <text x={100} y={45} textAnchor="middle" className="fill-foreground/80 text-[14px]">
                {String(a.text ?? "Text")}
              </text>
            ) : (
              <rect
                x={20}
                y={10}
                width={160}
                height={60}
                rx={6}
                className="fill-transparent stroke-foreground/60"
                strokeWidth={1.5}
              />
            )}
          </svg>
        </div>
      );
    }
    case "canvases.bulkAddShapes":
    case "canvases_bulkAddShapes": {
      const shapes = Array.isArray(a.shapes) ? (a.shapes as Array<Record<string, unknown>>) : [];
      const counts: Record<string, number> = {};
      for (const shape of shapes) {
        const kind = String(shape.kind ?? "?");
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return (
        <p className="text-[0.625rem] text-muted-foreground">
          <span className="text-foreground">{shapes.length}</span> shape
          {shapes.length === 1 ? "" : "s"}
          {Object.keys(counts).length > 0 && (
            <span className="ml-1">
              (
              {Object.entries(counts)
                .map(([kind, count]) => `${kind}:${count}`)
                .join(", ")}
              )
            </span>
          )}
        </p>
      );
    }
    case "canvases.applyTemplate":
    case "canvases_applyTemplate": {
      const template = String(a.templateId ?? "?");
      return (
        <p className="text-[0.625rem] text-muted-foreground">
          Apply template <span className="font-mono text-foreground">{template}</span>
        </p>
      );
    }
    case "canvases.layout":
    case "canvases_layout": {
      const algo = String(a.algorithm ?? "topological");
      return (
        <p className="text-[0.625rem] text-muted-foreground">
          Re-layout using <span className="font-mono text-foreground">{algo}</span>
        </p>
      );
    }
    default:
      return null;
  }
}

function groupToolCalls(calls: ChatTraceToolCall[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const call of calls) {
    const label = displayToolName(call.name);
    const existing = groups.get(label);
    const hasApproval = call.status === "pending" && Boolean(call.requiresConfirm);
    if (existing) {
      existing.calls.push(call);
      existing.hasApproval ||= hasApproval;
    } else {
      groups.set(label, {
        key: label,
        label,
        calls: [call],
        hasApproval,
      });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.hasApproval !== b.hasApproval) return a.hasApproval ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function countCalls(groups: ToolGroup[]): number {
  return groups.reduce((sum, group) => sum + group.calls.length, 0);
}

function countStatuses(calls: ChatTraceToolCall[]) {
  return calls.reduce(
    (acc, call) => {
      acc[call.status] += 1;
      if (call.status === "pending" && call.requiresConfirm) acc.approvals += 1;
      return acc;
    },
    {
      pending: 0,
      approved: 0,
      declined: 0,
      executed: 0,
      error: 0,
      approvals: 0,
    } satisfies Record<ChatTraceToolStatus | "approvals", number>,
  );
}

function isSkillCall(name: string): boolean {
  return (
    name === "todo" ||
    name === "delegate_task" ||
    name.startsWith("skill_") ||
    name.startsWith("skill.") ||
    name.includes(".skill.")
  );
}

function displayToolName(name: string): string {
  if (name.includes(".")) return name;
  return name.replace(/^mcp_forge_/, "forge_").replace(/_/g, ".");
}

function statusLabel(call: ChatTraceToolCall): string {
  if (call.status === "pending" && call.requiresConfirm) return "approval";
  if (call.status === "pending" || call.status === "approved") return "running";
  if (call.status === "executed") return "done";
  if (call.status === "declined") return "declined";
  return "error";
}

function statusTone(status: ChatTraceToolStatus): string {
  if (status === "error" || status === "declined") return "text-destructive";
  if (status === "pending" || status === "approved") return "text-ember";
  return "text-muted-foreground/70";
}

function hasToolArguments(args: unknown): boolean {
  if (args == null) return false;
  if (Array.isArray(args)) return args.length > 0;
  if (typeof args === "object") return Object.keys(args).length > 0;
  return true;
}

function stringifyToolValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
