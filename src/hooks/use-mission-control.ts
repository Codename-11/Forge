"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Persisted state + drag for the Mission Control widget.
 *
 * State lives per-user in `localStorage` (workspace-scoped via the slug
 * key suffix) so collapsed/tab/pinned/position survive reloads but
 * don't leak across workspaces.
 *
 * Position model: a corner anchor (`tl`/`tr`/`bl`/`br`) plus a small
 * (x,y) offset. We snap to the nearest corner on drag-end so the widget
 * never drifts mid-page or covers the sidebar; the offset is just a
 * bias from that corner so users can nudge it a few pixels off the
 * edge if they want.
 */

export type MissionControlTab = "live" | "queue" | "agents" | "history";
export type MissionControlSize = "pill" | "panel" | "expanded";
export type MissionControlCorner = "tl" | "tr" | "bl" | "br";

export interface MissionControlState {
  size: MissionControlSize;
  tab: MissionControlTab;
  corner: MissionControlCorner;
  offsetX: number;
  offsetY: number;
  pinnedRunIds: string[];
  /** When true, panel doesn't auto-collapse on outside click. */
  pinned: boolean;
}

const DEFAULT_STATE: MissionControlState = {
  size: "pill",
  tab: "live",
  corner: "br",
  offsetX: 16,
  offsetY: 16,
  pinnedRunIds: [],
  pinned: false,
};

const STORAGE_PREFIX = "forge.mission-control";

function storageKey(slug: string): string {
  return `${STORAGE_PREFIX}.${slug}`;
}

function loadState(slug: string): MissionControlState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<MissionControlState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(slug: string, state: MissionControlState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(state));
  } catch {
    /* localStorage full or unavailable — best-effort. */
  }
}

/**
 * Mission Control state hook. SSR-safe: returns the default state until
 * mount, then hydrates from localStorage in an effect to avoid a hydration
 * mismatch between server-rendered shell and the persisted client state.
 */
export function useMissionControl(slug: string): {
  state: MissionControlState;
  setSize: (size: MissionControlSize) => void;
  setTab: (tab: MissionControlTab) => void;
  setCorner: (corner: MissionControlCorner) => void;
  setOffset: (x: number, y: number) => void;
  togglePin: () => void;
  toggleCollapse: () => void;
  pinRun: (runId: string) => void;
  unpinRun: (runId: string) => void;
  isPinned: (runId: string) => boolean;
} {
  const [state, setState] = useState<MissionControlState>(DEFAULT_STATE);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  // Hydrate from localStorage on mount + on slug change.
  useEffect(() => {
    setState(loadState(slug));
  }, [slug]);

  // Persist on every state change. Slight debounce (rAF) keeps this off
  // the hot path when drags fire many setOffset calls per frame.
  const persistRaf = useRef<number | null>(null);
  useEffect(() => {
    if (persistRaf.current != null) cancelAnimationFrame(persistRaf.current);
    persistRaf.current = requestAnimationFrame(() => {
      saveState(slugRef.current, state);
    });
    return () => {
      if (persistRaf.current != null) cancelAnimationFrame(persistRaf.current);
    };
  }, [state]);

  const setSize = useCallback((size: MissionControlSize) => {
    setState((s) => ({ ...s, size }));
  }, []);
  const setTab = useCallback((tab: MissionControlTab) => {
    setState((s) => ({ ...s, tab, size: s.size === "pill" ? "panel" : s.size }));
  }, []);
  const setCorner = useCallback((corner: MissionControlCorner) => {
    setState((s) => ({ ...s, corner }));
  }, []);
  const setOffset = useCallback((offsetX: number, offsetY: number) => {
    setState((s) => ({ ...s, offsetX, offsetY }));
  }, []);
  const togglePin = useCallback(() => {
    setState((s) => ({ ...s, pinned: !s.pinned }));
  }, []);
  const toggleCollapse = useCallback(() => {
    setState((s) => {
      // pill → panel, panel → expanded? No: that would skip collapse.
      // Cycle: pill → panel → pill (Esc cycles back to pill).
      if (s.size === "pill") return { ...s, size: "panel" };
      return { ...s, size: "pill" };
    });
  }, []);
  const pinRun = useCallback((runId: string) => {
    setState((s) => {
      if (s.pinnedRunIds.includes(runId)) return s;
      return { ...s, pinnedRunIds: [...s.pinnedRunIds, runId].slice(-20) };
    });
  }, []);
  const unpinRun = useCallback((runId: string) => {
    setState((s) => ({
      ...s,
      pinnedRunIds: s.pinnedRunIds.filter((id) => id !== runId),
    }));
  }, []);
  const isPinned = useCallback(
    (runId: string) => state.pinnedRunIds.includes(runId),
    [state.pinnedRunIds],
  );

  return {
    state,
    setSize,
    setTab,
    setCorner,
    setOffset,
    togglePin,
    toggleCollapse,
    pinRun,
    unpinRun,
    isPinned,
  };
}

/**
 * Drag handle. Pass the ref to the element you want to act as the
 * drag affordance (header / pill body); pass `onDragEnd` so the parent
 * can snap to the nearest corner + persist.
 *
 * Uses pointer events (works for mouse, pen, touch). We don't update
 * the React tree on every move — the element is positioned via direct
 * style mutation during drag, then the final position is committed via
 * `onDragEnd` so the next render is consistent.
 */
export function useDragHandle({
  containerRef,
  onDragEnd,
  disabled = false,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onDragEnd: (corner: MissionControlCorner, offsetX: number, offsetY: number) => void;
  disabled?: boolean;
}): {
  onPointerDown: (e: React.PointerEvent) => void;
  isDragging: boolean;
} {
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);
  const startRef = useRef<{
    pointerX: number;
    pointerY: number;
    boxLeft: number;
    boxTop: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      const node = containerRef.current;
      if (!node) return;
      // Don't start a drag on interactive elements inside the handle —
      // buttons and links should still click.
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, textarea, [data-no-drag]")) return;
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      startRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        boxLeft: rect.left,
        boxTop: rect.top,
      };
      draggingRef.current = true;
      setIsDragging(true);

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current || !startRef.current) return;
        const dx = ev.clientX - startRef.current.pointerX;
        const dy = ev.clientY - startRef.current.pointerY;
        node.style.transition = "none";
        node.style.left = `${startRef.current.boxLeft + dx}px`;
        node.style.top = `${startRef.current.boxTop + dy}px`;
        node.style.right = "auto";
        node.style.bottom = "auto";
      };
      const onUp = (ev: PointerEvent) => {
        draggingRef.current = false;
        setIsDragging(false);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        const finalRect = node.getBoundingClientRect();
        // Snap to the nearest viewport corner, biased by current
        // distance to each corner. Offsets are reset to 16px.
        const w = window.innerWidth;
        const h = window.innerHeight;
        const cx = finalRect.left + finalRect.width / 2;
        const cy = finalRect.top + finalRect.height / 2;
        const left = cx < w / 2;
        const top = cy < h / 2;
        const corner: MissionControlCorner = top
          ? left
            ? "tl"
            : "tr"
          : left
            ? "bl"
            : "br";
        // Clear inline transforms so the parent can re-render against
        // its corner classes without an awkward animation jump.
        node.style.left = "";
        node.style.top = "";
        node.style.right = "";
        node.style.bottom = "";
        node.style.transition = "";
        onDragEnd(corner, 16, 16);
        startRef.current = null;
        ev.stopPropagation();
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [containerRef, onDragEnd, disabled],
  );

  return { onPointerDown, isDragging };
}

/**
 * Map a corner + offset to Tailwind absolute-positioning classes.
 * Used by the widget shell so the renderer doesn't have to think about
 * which corner is which.
 */
export function cornerToClass(corner: MissionControlCorner): string {
  switch (corner) {
    case "tl":
      return "top-4 left-4";
    case "tr":
      return "top-4 right-4";
    case "bl":
      return "bottom-4 left-4";
    case "br":
    default:
      return "bottom-4 right-4";
  }
}
