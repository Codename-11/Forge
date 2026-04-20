"use client";
import { trpc } from "@/lib/trpc";
import type { TimePrefs } from "@/lib/utils";

/**
 * Pulls the current user's regional preferences from `workspace.me`.
 * Falls back to browser defaults if the user hasn't set any explicitly.
 */
export function useTimePrefs(): TimePrefs {
  const { data: me } = trpc.workspace.me.useQuery();
  return {
    timezone: me?.user.timezone ?? undefined,
    locale: me?.user.locale ?? undefined,
    timeFormat: me?.user.timeFormat ?? undefined,
  };
}
