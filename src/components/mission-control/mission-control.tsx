"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ChevronUp, ChevronDown, MessageSquare, AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { useHotkey, useChord } from "@/lib/keyboard";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";
import { STALE_RUN_MS } from "@/lib/agent-stale";
import {
  CHAT_LAST_SEEN_EVENT,
  chatLastSeenStorageKey,
  readChatLastSeen,
  type ChatLastSeenEventDetail,
} from "@/lib/chat-read-state";
import {
  cornerToClass,
  useDragHandle,
  useMissionControl,
  type MissionControlTab,
} from "@/hooks/use-mission-control";
import { playRunCompletedSound, playRunStalledSound } from "@/lib/mission-control-sound";
import { LiveTab } from "./live-tab";
import { QueueTab } from "./queue-tab";
import { AgentsTab } from "./agents-tab";
import { GlanceView } from "./glance-view";
import { SettingsPopover } from "./settings-popover";
import { PillSparkline } from "./pill-sparkline";
import { ChatPreviewTab } from "./chat-preview-tab";
import { Kbd } from "@/components/ui/kbd";
import { useModKeyLabel } from "@/lib/platform";

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
 *   - panel: quick-access UI (Live / Queue / Agents / Chat). Durable
 *     run control, activity history, planning, and admin configuration
 *     live on their canonical pages and are deep-linked from here.
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

const BASE_TABS: { id: MissionControlTab; label: string; chord: string }[] = [
  { id: "live", label: "Live", chord: "1" },
  { id: "queue", label: "Queue", chord: "2" },
  { id: "agents", label: "Agents", chord: "3" },
  { id: "chat", label: "Chat", chord: "4" },
];

export function MissionControl() {
  const workspace = useMaybeWorkspace();
  const slug = workspace?.slug ?? "";
  const pathname = usePathname();
  const TABS = BASE_TABS;
  const {
    state,
    setSize,
    setTab,
    setCorner,
    toggleSound,
    toggleCollapse,
    pinRun,
    unpinRun,
    isPinned,
  } = useMissionControl(slug);
  const modKey = useModKeyLabel();
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

  const { data: sparkPoints } = trpc.agentRun.recentEventCounts.useQuery(
    { windowMinutes: 30, bucketSeconds: 60 },
    { enabled: Boolean(slug), staleTime: 30_000 },
  );

  // Chat threads (used for unread bubble + preview on the pill). Only
  // refetch occasionally; the realtime fan-out below invalidates this
  // on CHAT_MESSAGE_POSTED so the pill stays honest.
  const { data: chatThreads } = trpc.chat.threads.useQuery(undefined, {
    enabled: Boolean(slug),
    staleTime: 30_000,
  });

  // Per-user pref: default Mission Control tab.
  const { data: me } = trpc.user.me.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const activeCount = activeRuns?.length ?? 0;
  // Runs blocked on a human approve/reject — surfaced as an amber badge on
  // the Live tab so it's actionable from any tab, not just inside Live.
  const approvalCount = activeRuns?.filter((r) => r.awaitingApprovalAt != null).length ?? 0;
  const queueCount = queue?.length ?? 0;
  const nextQueueIssue = (queue ?? []).find((issue) => !issue.assignedAgent) ?? null;
  const stalledRuns = useMemo(() => {
    // Detect runs that haven't ticked in >5min — even if the watchdog
    // hasn't flipped them yet, the pill should warn.
    const now = Date.now();
    return (activeRuns ?? []).filter((r) => now - new Date(r.lastEventAt).getTime() > STALE_RUN_MS);
  }, [activeRuns]);
  const hasStalled = stalledRuns.length > 0;

  // Ref so the realtime callback can read the latest soundEnabled without
  // becoming stale (the callback is registered once and can't be updated
  // cheaply without re-subscribing).
  const soundEnabledRef = useRef(state.soundEnabled);
  soundEnabledRef.current = state.soundEnabled;

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
      void utils.agentRun.recentEventCounts.invalidate();
    }
    if (k === "AGENT_ASSIGNED" || k === "ISSUE_QUEUED" || k === "ISSUE_UPDATED") {
      void utils.issue.queue.invalidate();
      void utils.agentRun.activeAll.invalidate();
    }
    if (k === "AGENT_STATUS_CHANGED" || evt.subjectType === "agent") {
      void utils.agent.list.invalidate();
    }
    if (k === "CHAT_MESSAGE_POSTED" || evt.subjectType === "chat-thread") {
      void utils.chat.threads.invalidate();
    }
    if (k.startsWith("COMMENT_")) {
      // Status-comment upserts surface as comment events; refresh runs
      // so the headline current-step stays fresh.
      void utils.agentRun.activeAll.invalidate();
    }
    // Sound notifications — only fire when user has opted in.
    if (soundEnabledRef.current) {
      const agentId = (evt.payload as Record<string, string> | undefined)?.agentId;
      if (k === "AGENT_RUN_COMPLETED") {
        playRunCompletedSound(agentId);
      } else if (k === "AGENT_RUN_STALLED") {
        playRunStalledSound(agentId);
      }
    }
  });

  // ---------- Default-tab pref (per-workspace override → user global) ----------
  // Apply once per (slug, pref) combo: if the persisted tab is still
  // the built-in default ("live") and the resolved pref points
  // elsewhere, hydrate it. We don't override after the user has
  // manually switched tabs in this workspace.
  const workspaceId = workspace?.id ?? null;
  const { data: tabResolved } = trpc.user.missionControlDefaultTabFor.useQuery(
    { workspaceId: workspaceId ?? "" },
    {
      enabled: Boolean(workspaceId),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const resolvedDefaultTab = tabResolved?.resolved ?? me?.missionControlDefaultTab ?? null;
  const appliedDefaultRef = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) return;
    if (!resolvedDefaultTab || resolvedDefaultTab === "live") return;
    const key = `${slug}:${resolvedDefaultTab}`;
    if (appliedDefaultRef.current === key) return;
    if (state.tab !== "live") {
      appliedDefaultRef.current = key;
      return;
    }
    appliedDefaultRef.current = key;
    if (!TABS.some((t) => t.id === resolvedDefaultTab)) return;
    setTab(resolvedDefaultTab as MissionControlTab);
  }, [slug, resolvedDefaultTab, state.tab, setTab, TABS]);

  // ---------- Unread chat tracking ----------
  // Per-thread "last seen" timestamp. Bumped whenever the user has the
  // active chat thread open in either /chat or Mission Control. Threads
  // with `latestMessage.createdAt` newer than `lastSeen` and
  // `role === "AGENT"` count as unread.
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  useEffect(() => {
    if (typeof window === "undefined" || !slug) return;
    const refresh = () => setLastSeen(readChatLastSeen(slug));
    refresh();
    const onRead = (event: Event) => {
      const detail = (event as CustomEvent<ChatLastSeenEventDetail>).detail;
      if (detail?.slug !== slug) return;
      refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== chatLastSeenStorageKey(slug)) return;
      refresh();
    };
    window.addEventListener(CHAT_LAST_SEEN_EVENT, onRead);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHAT_LAST_SEEN_EVENT, onRead);
      window.removeEventListener("storage", onStorage);
    };
  }, [slug]);

  const { unreadCount, unreadPreview } = useMemo(() => {
    if (!chatThreads) return { unreadCount: 0, unreadPreview: null as null | string };
    let count = 0;
    let latestUnreadAt = 0;
    let latestUnreadBody: string | null = null;
    for (const t of chatThreads) {
      const last = t.latestMessage;
      if (!last) continue;
      if (last.role !== "AGENT") continue;
      const lastMs = new Date(last.createdAt).getTime();
      const serverReadMs = t.lastReadAt ? new Date(t.lastReadAt).getTime() : 0;
      const seenMs = Math.max(lastSeen[t.id] ?? 0, serverReadMs);
      if (lastMs <= seenMs) continue;
      count++;
      if (lastMs > latestUnreadAt) {
        latestUnreadAt = lastMs;
        latestUnreadBody = last.body;
      }
    }
    return {
      unreadCount: count,
      unreadPreview: latestUnreadBody,
    };
  }, [chatThreads, lastSeen]);

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
  // Glance remains a transient popover. The full operations shelf stays
  // open while the operator works elsewhere in the workspace and only
  // collapses through its explicit control or Escape.
  useEffect(() => {
    if (state.size !== "glance") return;
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
      setTab("chat");
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

  // `g 5` (and the legacy `g m`) chord opens the panel from anywhere —
  // same shell pattern as the sidebar nav chords. Doesn't take focus.
  // `g 5` matches the summon affordance shown on the pill ("G 5");
  // `g m` is kept as a back-compat alias for existing muscle memory.
  useChord("g", { "5": () => setSize("panel"), m: () => setSize("panel") });

  // Global `/` shortcut: open Mission Control directly to the chat preview.
  // Full compose/control lives on the workspace Chat page.
  useHotkey(
    "/",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setTab("chat");
    },
    [setTab],
  );

  if (!workspace) return null;

  // Common position class — corner anchors. The drag hook directly
  // mutates inline styles during a drag, then we reset to corner-anchor
  // mode on drop.
  const cornerClass = cornerToClass(state.corner);
  const isFullChatRoute = Boolean(slug && pathname?.startsWith(`/w/${slug}/chat`));
  const usesBottomCorner = state.corner === "br" || state.corner === "bl";
  const pillCornerClass =
    isFullChatRoute && usesBottomCorner
      ? cn(cornerClass, "bottom-24")
      : cn(cornerClass, usesBottomCorner && "max-md:bottom-24");
  const glanceCornerClass = cn(cornerClass, usesBottomCorner && "max-md:bottom-24");

  // Pill summary: agent presence dots (up to 3) + count + first row's
  // current step if there is one.
  const dots = (activeRuns ?? []).slice(0, 3);
  const firstStep =
    activeRuns?.[0]?.currentStep ?? activeRuns?.[0]?.statusComment?.currentStep ?? null;

  if (state.size === "pill") {
    const previewLine = unreadPreview
      ? unreadPreview.replace(/\s+/g, " ").slice(0, 80).trim()
      : null;
    const chatTitle =
      unreadCount > 0
        ? `${unreadCount} new agent ${unreadCount === 1 ? "reply" : "replies"}${previewLine ? ` — ${previewLine}` : ""}`
        : "Open chat";
    return (
      <div
        ref={containerRef}
        data-mission-control-root
        className={cn(
          "group fixed z-40 flex select-none items-center gap-1",
          pillCornerClass,
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
              : `Mission Control (${modKey}')`
          }
          className={cn(
            "group flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1.5 text-[0.75rem] shadow-sm backdrop-blur",
            hasStalled
              ? "border-warning/40 hover:border-warning/60"
              : "border-border hover:border-ember/40",
          )}
        >
          {hasStalled ? (
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          ) : activeCount > 0 ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
            </span>
          ) : (
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {dots.length > 0 && (
            <span className="flex -space-x-1">
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
          {/* Sparkline: recent 30-minute event activity. Hidden on small screens. */}
          <PillSparkline
            points={sparkPoints ?? []}
            windowMinutes={30}
            bucketSeconds={60}
            width={48}
            height={12}
            className="hidden text-ember sm:block"
          />
          {queueCount > 0 && (
            <span className="rounded-md border border-border bg-subtle px-1 py-0 font-mono text-[0.625rem] text-muted-foreground">
              {queueCount} queued
            </span>
          )}
          {firstStep && activeCount === 1 && (
            <span className="text-meta ml-1 max-w-32 truncate text-muted-foreground">
              · {firstStep}
            </span>
          )}
          {/* Summon-chord hint: `G 5` opens Activity. Mirrors the keybinding
              wiring below (`useChord("g", { 5, m })`). Hover-only so the
              resting pill stays compact. */}
          <span className="ml-0.5 hidden items-center gap-0.5 group-hover:inline-flex">
            <Kbd>G</Kbd>
            <Kbd>5</Kbd>
          </span>
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        </button>
        <button
          type="button"
          onClick={() => {
            setTab("chat");
          }}
          title={chatTitle}
          aria-label="Open chat"
          data-testid="mission-control-pill-chat"
          className={cn(
            "relative flex h-7 w-7 items-center justify-center rounded-full border bg-card/90 shadow-sm backdrop-blur transition-colors",
            unreadCount > 0
              ? "border-ember/40 text-ember hover:border-ember/60"
              : "border-border text-muted-foreground hover:border-ember/40 hover:text-foreground",
          )}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {unreadCount > 0 && (
            <span
              className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-ember px-1 font-mono text-[0.5625rem] text-ember-foreground"
              aria-label={`${unreadCount} unread`}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
        {unreadCount > 0 && previewLine && (
          <span className="text-meta pointer-events-none ml-1 hidden max-w-[16rem] truncate rounded-md border border-border bg-card/80 px-2 py-0.5 text-muted-foreground shadow-sm backdrop-blur group-hover:block">
            {previewLine}
          </span>
        )}
      </div>
    );
  }

  // ---------- Glance mode (mid-size: agents + heartbeats) ----------
  if (state.size === "glance") {
    return (
      <div
        ref={containerRef}
        data-mission-control-root
        className={cn(
          "fixed z-40 flex flex-col rounded-lg border border-border bg-card shadow-md backdrop-blur",
          glanceCornerClass,
          isDragging && "opacity-90",
        )}
        style={{
          width: "min(320px, calc(100vw - 1rem))",
          height: "min(380px, calc(100svh - 1rem))",
        }}
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

  // ---------- Operations shelf ----------
  return (
    <div
      ref={containerRef}
      data-mission-control-root
      role="region"
      aria-label="Mission Control"
      className="fixed inset-x-2 bottom-20 z-40 flex h-[calc(100svh-6rem)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl md:relative md:inset-auto md:z-30 md:mx-3 md:mb-3 md:h-[21rem] md:w-auto md:shrink-0 md:shadow-md"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/70 bg-card/80 px-3 py-2">
        <Activity className="h-4 w-4 shrink-0 text-ember" />
        <span className="text-[0.75rem] font-semibold text-foreground">Mission Control</span>
        {hasStalled && (
          <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[0.625rem] text-warning">
            {stalledRuns.length} stalled
          </span>
        )}

        <nav
          role="tablist"
          aria-label="Mission Control views"
          className="order-3 flex w-full items-center gap-0.5 overflow-x-auto md:order-none md:ml-3 md:w-auto"
        >
          {TABS.map((t) => {
            const isActive = state.tab === t.id;
            const count =
              t.id === "live"
                ? activeCount
                : t.id === "queue"
                  ? queueCount
                  : t.id === "chat"
                    ? unreadCount
                    : null;
            return (
              <button
                key={t.id}
                id={`mission-control-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`mission-control-panel-${t.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setTab(t.id)}
                title={`${t.label} (${t.chord})`}
                className={cn(
                  "focus-ring flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-3 py-1 text-[0.75rem] md:min-h-8 md:px-2.5 md:text-[0.6875rem]",
                  isActive
                    ? "border-ember/50 bg-ember/10 text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-subtle/50 hover:text-foreground",
                )}
              >
                {t.label}
                {count != null && count > 0 && (
                  <span
                    className={cn(
                      "rounded-md px-1 font-mono text-[0.625rem]",
                      isActive ? "bg-ember/15 text-ember" : "bg-subtle text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                )}
                {t.id === "live" && approvalCount > 0 && (
                  <span
                    title={`${approvalCount} run${approvalCount === 1 ? "" : "s"} awaiting approval`}
                    className="rounded-md bg-warning/20 px-1 font-mono text-[0.625rem] text-warning"
                  >
                    {approvalCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <span className="ml-auto flex items-center gap-1">
          {state.tab === "queue" && nextQueueIssue && (
            <Link
              href={`/w/${slug}/issues/${nextQueueIssue.id}`}
              title="Open the next unassigned issue"
              className="focus-ring inline-flex min-h-9 items-center rounded-md bg-ember px-3 text-[0.6875rem] font-semibold text-ember-foreground hover:bg-ember/90"
            >
              Assign next
            </Link>
          )}
          <SettingsPopover soundEnabled={state.soundEnabled} onToggleSound={toggleSound} />
          <button
            type="button"
            onClick={() => setSize("pill")}
            aria-label="Collapse Mission Control"
            title="Collapse (Esc)"
            className="focus-ring flex h-11 min-w-11 items-center justify-center gap-1 rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground md:h-8 md:min-w-8"
          >
            <ChevronDown className="h-3 w-3" />
            <span className="hidden text-[0.6875rem] md:inline">Collapse</span>
          </button>
        </span>
      </header>

      <div
        id={`mission-control-panel-${state.tab}`}
        role="tabpanel"
        aria-labelledby={`mission-control-tab-${state.tab}`}
        className="min-h-0 flex-1"
      >
        {state.tab === "live" && (
          <LiveTab
            pinnedIds={state.pinnedRunIds}
            onTogglePin={(id) => (isPinned(id) ? unpinRun(id) : pinRun(id))}
            activeRunId={activeRunId}
            setActiveRunId={setActiveRunId}
            commandCenterHref={`/w/${slug}/command-center`}
          />
        )}
        {state.tab === "queue" && (
          <QueueTab slug={slug} workspaceKey={workspace.key} variant="shelf" />
        )}
        {state.tab === "agents" && <AgentsTab slug={slug} />}
        {state.tab === "chat" && <ChatPreviewTab slug={slug} />}
      </div>
    </div>
  );
}
