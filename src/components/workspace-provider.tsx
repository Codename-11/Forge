"use client";
import type { ReactNode } from "react";
import { WorkspaceContext, type WorkspaceContextValue } from "@/hooks/use-workspace";

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
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
