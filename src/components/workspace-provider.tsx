"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  WorkspaceContext,
  WorkspaceContextUpdater,
  type WorkspaceContextValue,
} from "@/hooks/use-workspace";

/**
 * Thin client wrapper that seeds the workspace context with values resolved
 * by the RSC shell. Split out from the hook module so the hook file can stay
 * "use client" without forcing a re-render of server routes that import it.
 */
export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(value);

  // Keep client context aligned when a server navigation supplies a new
  // workspace snapshot (workspace switch, refresh, or membership update).
  useEffect(() => setCurrent(value), [value]);

  const update = useCallback((patch: Partial<WorkspaceContextValue>) => {
    setCurrent((existing) => ({ ...existing, ...patch }));
  }, []);

  return (
    <WorkspaceContextUpdater.Provider value={update}>
      <WorkspaceContext.Provider value={current}>{children}</WorkspaceContext.Provider>
    </WorkspaceContextUpdater.Provider>
  );
}
