"use client";
import { createContext, useContext } from "react";
import type { Role } from "@prisma/client";

/**
 * Shape exposed to the client tree under `/w/[slug]/*`. The shell layout
 * resolves the workspace on the server, then seeds this provider so client
 * components can access the current workspace without a round-trip.
 */
export type WorkspaceContextValue = {
  id: string;
  slug: string;
  key: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
  /** Number of workspaces the user has access to — gates the switcher UI. */
  membershipCount: number;
  cycleLengthDays: number;
  cycleCooldownDays: number;
  timeTrackingEnabled: boolean;
  attachmentQuotaMb: number;
  /** Requested cadence for human-facing agent progress checkpoints. */
  agentProgressUpdateMinutes: number;
  /** Non-terminal quiet threshold used by live run surfaces. */
  agentRunQuietMinutes: number;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * Reads the current workspace from the provider seeded by the RSC shell.
 * Throws when used outside `/w/[slug]/*` — that's intentional: account-level
 * pages have no workspace to read.
 */
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider.");
  }
  return ctx;
}

export function useMaybeWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

/** Build a URL under the current workspace. Pass `/foo/bar` (leading slash). */
export function workspacePath(slug: string, path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return `/w/${slug}${path}`;
}

/**
 * Convenience wrapper around `workspacePath` bound to the current workspace.
 * `wsHref("/issues/42")` → `/w/<slug>/issues/42`.
 */
export function useWsHref() {
  const ws = useWorkspace();
  return (path: string) => workspacePath(ws.slug, path);
}
