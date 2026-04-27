"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ChevronUp,
  ChevronDown,
  GripHorizontal,
  Pin,
  PinOff,
  X as XIcon,
  AlertTriangle,
  Hourglass,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useHotkey, useChord } from "@/lib/keyboard";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import {
  cornerToClass,
  useDragHandle,
  useMissionControl,
  type MissionControlTab,
} from "@/hooks/use-mission-control";
import { LiveTab } from "./live-tab";
import { QueueTab } from "./queue-tab";
import { AgentsTab } from "./agents-tab";
import { HistoryTab } from "./history-tab";
import { GlanceView } from "./glance-view";

/**
 * Mission Control — the global agent ops widget.
 *
 * Anchored to a viewport corner (default bottom-right), draggable to
 * any other corner, persists collapsed/tab/position/pinned state in
 * localStorage per workspace.
 *
 * Two visual modes:
 *   - pill: a small ambient indicator with active count + first
 *     active run's current step. Stalled runs swap the dot for an
 *     amber glyph so you can spot trouble at a glance.
 *   - panel: full tabbed UI (Live / Queue / Agents / History). All
 *     four tabs hydrate independently so flipping tabs is instant
 *     after the first visit.
 *
 * SSE wiring: subscribes to the workspace channel and invalidates the
 * relevant tRPC queries on AGENT_RUN_*, AGENT_ASSIGNED, ISSUE_QUEUED,
 * COMMENT_CREATED. No polling.
 *
 * Keyboard:
 *   - mod+'  → toggle pill ↔ panel
 *   - 1..4   → switch tab (when expanded)
 *   - j / k  → next / prev run in Live tab (when expanded)
 *   - Enter  → expand the active run's timeline
 *   - p      → pin / unpin the active run
 *   - Esc    → collapse to pill (when expanded and not text-focused)
 */

const TABS: { id: MissionControlTab; label: string; chord: string }[] = [
  { id: "live", label: "Live", chord: "1" },
  { id: "queue", label: "Queue", chord: "2" },
  { id: "agents", label: "Agents", chord: "3" },
  { id: "history", label: "History", chord: "4" },
];

export function MissionControl() {
  const workspace = useMaybeWorkspace();
  const slug = workspace?.slug ?? "";
  const {
    state,
    setSize,
    setTab,
    setCorner,
    togglePin,
    toggleCollapse,
    pinRun,
    unpinRun,
    isPinned,
  } = useMissionControl(slug);
  const utils = trpc.useUtils();

  // Live data for the pill (always fetched even when collapsed so the
  // ambient indicator is honest). Cheap query — bounded at 25.
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery(
    { limit: 25 },
    { enabled: Boolean(slug), staleTime: 3_000 },
  );

  const { data: queue } = trpc.issue.queue.useQuery(
    { includeClaimed: false, limit: 30 },
    { enabled: Boolean(slug), staleTime: 5_000 },
  );

  const activeCount = activeRuns?.length ?? 0;
  const queueCount = (queue ?? []).filter((q) => !q.assignedAgent).length;
  const stalledRuns = useMemo(() => {
    // Detect runs that haven't ticked in >5min — even if the watchdog
    // hasn't flipped them yet, the pill should warn.
    const now = Date.now();
    return (activeRuns ?? []).filter(
      (r) => now - new Date(r.lastEventAt).getTime() > 5 * 60_000,
    );
  }, [activeRuns]);
  const hasStalled = stalledRuns.length > 0;

  // Realtime fan-out: every AGENT_RUN_*, AGENT_ASSIGNED, ISSUE_QUEUED,
  // COMMENT_CREATED reshapes some tab's data. Invalidate broadly —
  // the cost is a refetch, the win is "no polling, no stale UI."
  useRealtime((evt) => {
    const k = evt.kind ?? "";
    if (k.startsWith("AGENT_RUN_") || evt.subjectType === "agent-run") {
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.recentTerminal.invalidate();
      void utils.agentRun.heatmap.invalidate();
      void utils.agentRun.eventsInRange.invalidate();
    }
    if (k === "AGENT_ASSIGNED" || k === "ISSUE_QUEUED" || k === "ISSUE_UPDATED") {
      void utils.issue.queue.invalidate();
      void utils.agentRun.activeAll.invalidate();
    }
    if (k === "AGENT_STATUS_CHANGED" || evt.subjectType === "agent") {
      void utils.agent.list.invalidate();
    }
    if (k.startsWith("COMMENT_")) {
      // Status-comment upserts surface as comment events; refresh runs
      // so the headline current-step stays fresh.
      void utils.agentRun.activeAll.invalidate();
    }
  });

  // ---------- Drag handle ----------
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { onPointerDown, isDragging } = useDragHandle({
    containerRef,
    onDragEnd: (corner, x, y) => {
      setCorner(corner);
      // Offsets are reset to 16/16 by the hook; just commit the corner.
      void x;
      void y;
    },
  });

  // ---------- Click-outside auto-collapse ----------
  // When the panel is open and not pinned, clicking anywhere outside
  // the widget collapses it back to pill. Respects `state.pinned` so a
  // pinned widget stays open while the user clicks around the app.
  // Uses pointerdown instead of click so the collapse fires before the
  // outside element handles its own click — feels more responsive.
  useEffect(() => {
    if (state.size === "pill") return;
    if (state.pinned) return;
    const handler = (ev: PointerEvent) => {
      const node = containerRef.current;
      if (!node) return;
      const target = ev.target as Node | null;
      if (target && node.contains(target)) return;
      setSize("pill");
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [state.size, state.pinned, setSize]);

  // ---------- Keyboard ----------
  // Toggle pill ↔ panel. mod+' = cmd+' on Mac, ctrl+' elsewhere.
  useHotkey("cmd+'", () => toggleCollapse(), [toggleCollapse]);

  // Tab switch chords work only when expanded; otherwise they'd compete
  // with the rest of the app.
  const expanded = state.size !== "pill";
  useHotkey(
    "1",
    (e) => {
      if (!expanded) return;
      // Ignore typing into form fields.
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setTab("live");
    },
    [expanded, setTab],
  );
  useHotkey(
    "2",
    (e) => {
      if (!expanded) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setTab("queue");
    },
    [expanded, setTab],
  );
  useHotkey(
    "3",
    (e) => {
      if (!expanded) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setTab("agents");
    },
    [expanded, setTab],
  );
  useHotkey(
    "4",
    (e) => {
      if (!expanded) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setTab("history");
    },
    [expanded, setTab],
  );

  // Esc collapses panel to pill (unless caller is in a field).
  useHotkey(
    "escape",
    (e) => {
      if (!expanded) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      setSize("pill");
      e.preventDefault();
    },
    [expanded, setSize],
  );

  // ---------- j/k row navigation in Live tab ----------
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const runIds = useMemo(() => (activeRuns ?? []).map((r) => r.id), [activeRuns]);

  // Keep activeRunId valid when the underlying list shifts.
  useEffect(() => {
    if (activeRunId && !runIds.includes(activeRunId)) {
      setActiveRunId(runIds[0] ?? null);
    }
  }, [activeRunId, runIds]);

  // j/k/p only meaningful when the panel is rendering the Live tab —
  // glance has no run list, so the keys stay free for the rest of the
  // app (e.g. issue list keyboard nav).
  const inLivePanel = state.size === "panel" && state.tab === "live";
  useHotkey(
    "j",
    (e) => {
      if (!inLivePanel) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      const idx = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const next = runIds[Math.min(runIds.length - 1, idx + 1)] ?? runIds[0];
      if (next) setActiveRunId(next);
    },
    [inLivePanel, activeRunId, runIds],
  );
  useHotkey(
    "k",
    (e) => {
      if (!inLivePanel) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      const idx = activeRunId ? runIds.indexOf(activeRunId) : -1;
      const prev = runIds[Math.max(0, idx - 1)] ?? runIds[0];
      if (prev) setActiveRunId(prev);
    },
    [inLivePanel, activeRunId, runIds],
  );

  // p toggles pin on the active row. The row itself also has a button.
  useHotkey(
    "p",
    (e) => {
      if (!inLivePanel) return;
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if (!activeRunId) return;
      e.preventDefault();
      if (isPinned(activeRunId)) unpinRun(activeRunId);
      else pinRun(activeRunId);
    },
    [inLivePanel, activeRunId, isPinned, pinRun, unpinRun],
  );

  // `g m` chord opens the panel from anywhere — same shell pattern as
  // the sidebar nav chords. Doesn't take focus.
  useChord("g", { m: () => setSize("panel") });

  if (!workspace) return null;

  // Common position class — corner anchors. The drag hook directly
  // mutates inline styles during a drag, then we reset to corner-anchor
  // mode on drop.
  const cornerClass = cornerToClass(state.corner);

  // Pill summary: agent presence dots (up to 3) + count + first row's
  // current step if there is one.
  const dots = (activeRuns ?? []).slice(0, 3);
  const firstStep =
    activeRuns?.[0]?.currentStep ??
    activeRuns?.[0]?.statusComment?.currentStep ??
    null;

  if (state.size === "pill") {
    return (
      <div
        ref={containerRef}
        className={cn(
          "fixed z-40 select-none",
          cornerClass,
          isDragging && "cursor-grabbing",
        )}
      >
        <button
          type="button"
          onPointerDown={onPointerDown}
          onClick={(e) => {
            // If we just dragged, don't trigger the click. The hook
            // already cleared isDragging by the time click fires, but
            // pointer events fire first — guard with a small timeout
            // pattern via target check.
            if (isDragging) {
              e.preventDefault();
              return;
            }
            // Click goes to the glance (agents + heartbeat) view, not
            // straight to the full panel. Users who want tabs can hit
            // mod+' twice or click "Open panel" inside glance.
            setSize("glance");
          }}
          title={
            hasStalled
              ? `${stalledRuns.length} stalled ${stalledRuns.length === 1 ? "run" : "runs"} · open Mission Control`
              : "Mission Control (⌘')"
          }
          className={cn(
            "group flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1.5 text-[0.75rem] shadow-sm backdrop-blur",
            hasStalled
              ? "border-amber-500/40 hover:border-amber-500/60"
              : "border-border hover:border-ember/40",
          )}
        >
          {hasStalled ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          ) : activeCount > 0 ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
            </span>
          ) : (
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {dots.length > 0 && (
            <span className="-space-x-1 flex">
              {dots.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-card bg-ember/15 font-mono text-[0.5625rem] uppercase text-ember"
                  title={r.agent.name}
                >
                  {r.agent.profileKey.slice(0, 2)}
                </span>
              ))}
            </span>
          )}
          <span className="font-mono text-[0.6875rem] text-foreground">
            {activeCount > 0 ? `${activeCount} active` : "idle"}
          </span>
          {queueCount > 0 && (
            <span className="rounded-md border border-border bg-subtle px-1 py-0 font-mono text-[0.625rem] text-muted-foreground">
              {queueCount} queued
            </span>
          )}
          {firstStep && activeCount === 1 && (
            <span className="ml-1 max-w-32 truncate text-meta text-muted-foreground">
              · {firstStep}
            </span>
          )}
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  // ---------- Glance mode (mid-size: agents + heartbeats) ----------
  if (state.size === "glance") {
    return (
      <div
        ref={containerRef}
        className={cn(
          "fixed z-40 flex flex-col rounded-lg border border-border bg-card shadow-md backdrop-blur",
          cornerClass,
          isDragging && "opacity-90",
        )}
        style={{ width: 320, height: 380 }}
      >
        <GlanceView
          slug={slug}
          onExpand={() => setSize("panel")}
          onCollapse={() => setSize("pill")}
          onPointerDownDrag={onPointerDown}
          isDragging={isDragging}
          hasStalled={hasStalled}
          stalledCount={stalledRuns.length}
        />
      </div>
    );
  }

  // ---------- Panel mode ----------
  return (
    <div
      ref={containerRef}
      className={cn(
        "fixed z-40 flex flex-col rounded-lg border border-border bg-card shadow-md backdrop-blur",
        cornerClass,
        isDragging && "opacity-90",
      )}
      style={{
        width: 460,
        height: 560,
      }}
    >
      <header
        onPointerDown={onPointerDown}
        className={cn(
          "flex items-center gap-2 rounded-t-lg border-b border-border/70 bg-card/80 px-3 py-2",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Mission Control
        </span>
        {hasStalled && (
          <span className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[0.625rem] text-amber-600">
            <Hourglass className="h-2.5 w-2.5" /> {stalledRuns.length} stalled
          </span>
        )}
        <span className="ml-auto flex items-center gap-1" data-no-drag>
          <button
            type="button"
            onClick={togglePin}
            title={state.pinned ? "Unpin (auto-collapse on outside click)" : "Pin (stay open)"}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground",
              state.pinned && "text-ember hover:text-ember",
            )}
          >
            {state.pinned ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => setSize("pill")}
            title="Collapse (Esc)"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setSize("pill")}
            title="Close"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      </header>

      <nav
        className="flex items-center gap-0.5 border-b border-border/70 bg-card/40 px-2 py-1"
        data-no-drag
      >
        {TABS.map((t) => {
          const isActive = state.tab === t.id;
          const count =
            t.id === "live"
              ? activeCount
              : t.id === "queue"
                ? queueCount
                : null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              title={`${t.label} (${t.chord})`}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem]",
                isActive
                  ? "bg-subtle text-foreground"
                  : "text-muted-foreground hover:bg-subtle/50 hover:text-foreground",
              )}
            >
              {t.label}
              {count != null && count > 0 && (
                <span
                  className={cn(
                    "rounded-md px-1 font-mono text-[0.625rem]",
                    isActive ? "bg-ember/15 text-ember" : "bg-card text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1" data-no-drag>
        {state.tab === "live" && (
          <LiveTab
            pinnedIds={state.pinnedRunIds}
            onTogglePin={(id) => (isPinned(id) ? unpinRun(id) : pinRun(id))}
            activeRunId={activeRunId}
            setActiveRunId={setActiveRunId}
          />
        )}
        {state.tab === "queue" && <QueueTab slug={slug} />}
        {state.tab === "agents" && <AgentsTab slug={slug} />}
        {state.tab === "history" && <HistoryTab slug={slug} />}
      </div>
    </div>
  );
}
