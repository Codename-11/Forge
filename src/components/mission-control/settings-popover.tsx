"use client";
import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

interface SettingsPopoverProps {
  soundEnabled: boolean;
  onToggleSound: () => void;
}

// Only user-selectable defaults; Control is admin-only and never a sensible
// landing tab so it's excluded here.
type DefaultTabPref = "live" | "queue" | "agents" | "history" | "chat";

const TAB_OPTIONS: Array<{ id: DefaultTabPref; label: string }> = [
  { id: "live", label: "Live" },
  { id: "queue", label: "Queue" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "chat", label: "Chat" },
];

const DEFAULT_TAB_VALUES = new Set<DefaultTabPref>([
  "live",
  "queue",
  "agents",
  "history",
  "chat",
]);

function normalizeDefaultTab(value: string | null | undefined): DefaultTabPref {
  if (value && DEFAULT_TAB_VALUES.has(value as DefaultTabPref)) {
    return value as DefaultTabPref;
  }
  return "live";
}

export function SettingsPopover({ soundEnabled, onToggleSound }: SettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const workspace = useMaybeWorkspace();
  const workspaceId = workspace?.id ?? null;
  const { data: me } = trpc.user.me.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: resolved } = trpc.user.missionControlDefaultTabFor.useQuery(
    { workspaceId: workspaceId ?? "" },
    {
      enabled: Boolean(workspaceId),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const updatePrefs = trpc.user.updateMissionControlPrefs.useMutation({
    onSuccess: () => {
      void utils.user.me.invalidate();
      if (workspaceId) {
        void utils.user.missionControlDefaultTabFor.invalidate({ workspaceId });
      }
    },
  });

  const userPref = normalizeDefaultTab(me?.missionControlDefaultTab);
  const wsPrefRaw = resolved?.membership ?? null;
  const wsPref = wsPrefRaw ? normalizeDefaultTab(wsPrefRaw) : null;
  const effectivePref = wsPref ?? userPref;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Settings"
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground",
        )}
      >
        <SettingsIcon className="h-3 w-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-7 z-40 w-64 rounded-md border border-border bg-card p-2 shadow-md"
            onClick={(e) => e.stopPropagation()}
          >
            <label className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-[0.75rem] hover:bg-subtle">
              <span className="text-foreground">Sound notifications</span>
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={onToggleSound}
                className="h-3 w-3"
              />
            </label>
            <p className="px-2 pb-2 pt-1 text-[0.625rem] text-muted-foreground">
              Soft chime on run complete, lower on stall. Throttled per agent.
            </p>
            <div className="border-t border-border/60 pt-1.5">
              <div className="flex items-center justify-between gap-2 px-2 py-1 text-[0.75rem]">
                <span className="text-foreground">Open on (this workspace)</span>
                <select
                  value={wsPref ?? "__inherit__"}
                  disabled={updatePrefs.isPending || !workspaceId}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "__inherit__") {
                      updatePrefs.mutate({
                        missionControlDefaultTab: null,
                        workspaceId: workspaceId ?? undefined,
                      });
                      return;
                    }
                    const next = normalizeDefaultTab(raw);
                    updatePrefs.mutate({
                      missionControlDefaultTab: next,
                      workspaceId: workspaceId ?? undefined,
                    });
                  }}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[0.6875rem] outline-none focus:border-ember/50"
                >
                  <option value="__inherit__">
                    Inherit ({userPref})
                  </option>
                  {TAB_OPTIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2 px-2 py-1 text-[0.75rem]">
                <span className="text-muted-foreground">Open on (all workspaces)</span>
                <select
                  value={userPref}
                  disabled={updatePrefs.isPending}
                  onChange={(e) => {
                    const next = normalizeDefaultTab(e.target.value);
                    updatePrefs.mutate({ missionControlDefaultTab: next });
                  }}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[0.6875rem] outline-none focus:border-ember/50"
                >
                  {TAB_OPTIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="px-2 pb-1 pt-0.5 text-[0.625rem] text-muted-foreground">
                Per-workspace value wins. Mission Control will open on{" "}
                <span className="font-mono">{effectivePref}</span> here.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
