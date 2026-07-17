"use client";

import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import type { QuickCreateOverride } from "@/components/quick-create";
import { requestQuickCreate, subscribeQuickCreate } from "@/lib/workspace-surface-requests";

const LazyCommandPalette = lazy(() =>
  import("@/components/command-palette").then((module) => ({ default: module.CommandPalette })),
);
const LazyQuickCreate = lazy(() =>
  import("@/components/quick-create").then((module) => ({ default: module.QuickCreate })),
);
const LazyMissionControl = lazy(() =>
  import("@/components/mission-control/mission-control").then((module) => ({
    default: module.MissionControl,
  })),
);

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(
    element?.isContentEditable ||
    element?.closest('input, textarea, select, [contenteditable="true"]'),
  );
}

/**
 * Keeps closed global surfaces out of the workspace's critical hydration path.
 * The first matching shortcut/click mounts the requested overlay with that
 * opening intent preserved; subsequent interactions are owned by the surface.
 * Mission Control's persistent attention pill mounts after the initial route
 * has settled, then stays realtime through its SSE subscriptions.
 */
export function WorkspaceLazySurfaces() {
  const [paletteMounted, setPaletteMounted] = useState(false);
  const [quickCreateRequest, setQuickCreateRequest] = useState<QuickCreateOverride | null>(null);
  const [missionControlMounted, setMissionControlMounted] = useState(false);
  const [missionControlRequested, setMissionControlRequested] = useState(false);

  useEffect(() => {
    // requestIdleCallback alone can run between hydration tasks and pull the
    // full operations widget into the critical path. Give the primary route a
    // bounded quiet window first; once mounted, Mission Control remains live
    // through event-driven invalidation.
    const handle = window.setTimeout(() => setMissionControlMounted(true), 5_000);
    return () => window.clearTimeout(handle);
  }, []);

  useLayoutEffect(() => {
    const unsubscribeQuickCreate = subscribeQuickCreate((request) => {
      setQuickCreateRequest((current) => current ?? request);
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!paletteMounted && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteMounted(true);
        return;
      }
      if (
        !quickCreateRequest &&
        event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        requestQuickCreate();
        return;
      }
      if (
        !missionControlMounted &&
        (event.metaKey || event.ctrlKey) &&
        event.key === "'"
      ) {
        event.preventDefault();
        setMissionControlRequested(true);
        setMissionControlMounted(true);
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!paletteMounted && target?.closest("[data-command-palette]")) {
        setPaletteMounted(true);
      }
      if (!quickCreateRequest) {
        const trigger = target?.closest<HTMLElement>("[data-quick-create]");
        if (trigger) {
          requestQuickCreate(
            trigger.dataset.quickCreateProject
              ? { projectId: trigger.dataset.quickCreateProject }
              : {},
          );
        }
      }
    };
    const onQuickCreate = (event: Event) => {
      requestQuickCreate((event as CustomEvent<QuickCreateOverride>).detail ?? {});
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    window.addEventListener("forge:quick-create", onQuickCreate);
    return () => {
      unsubscribeQuickCreate();
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      window.removeEventListener("forge:quick-create", onQuickCreate);
    };
  }, [missionControlMounted, paletteMounted, quickCreateRequest]);

  return (
    <>
      <Suspense fallback={null}>
        {paletteMounted ? <LazyCommandPalette initialOpen /> : null}
      </Suspense>
      <Suspense fallback={null}>
        {quickCreateRequest ? <LazyQuickCreate initialOpen={quickCreateRequest} /> : null}
      </Suspense>
      <Suspense fallback={null}>
        {missionControlMounted ? (
          <LazyMissionControl initialOpen={missionControlRequested} />
        ) : null}
      </Suspense>
    </>
  );
}
