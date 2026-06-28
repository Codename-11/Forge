"use client";
import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { Combobox } from "@/components/ui/combobox";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

interface SettingsPopoverProps {
  soundEnabled: boolean;
  onToggleSound: () => void;
}

// Only lightweight quick-access tabs belong in the floating dock. History,
// plans, and admin/run-control work have durable homes elsewhere.
type DefaultTabPref = "live" | "queue" | "agents" | "chat";

const TAB_OPTIONS: Array<{ id: DefaultTabPref; label: string }> = [
  { id: "live", label: "Live" },
  { id: "queue", label: "Queue" },
  { id: "agents", label: "Agents" },
  { id: "chat", label: "Chat" },
];

const DEFAULT_TAB_VALUES = new Set<DefaultTabPref>([
  "live",
  "queue",
  "agents",
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
                <Combobox
                  value={wsPref ?? "__inherit__"}
                  disabled={updatePrefs.isPending || !workspaceId}
                  onChange={(v) => {
                    const raw = v ?? "__inherit__";
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
                  options={[
                    { value: "__inherit__", label: `Inherit (${userPref})` },
                    ...TAB_OPTIONS.map((t) => ({ value: t.id, label: t.label })),
                  ]}
                  ariaLabel="Open on (this workspace)"
                />
              </div>
              <div className="flex items-center justify-between gap-2 px-2 py-1 text-[0.75rem]">
                <span className="text-muted-foreground">Open on (all workspaces)</span>
                <Combobox
                  value={userPref}
                  disabled={updatePrefs.isPending}
                  onChange={(v) => {
                    const next = normalizeDefaultTab(v);
                    updatePrefs.mutate({ missionControlDefaultTab: next });
                  }}
                  options={TAB_OPTIONS.map((t) => ({ value: t.id, label: t.label }))}
                  ariaLabel="Open on (all workspaces)"
                />
              </div>
              <p className="px-2 pb-1 pt-0.5 text-[0.625rem] text-muted-foreground">
                Per-workspace value wins. Activity will open on{" "}
                <span className="font-mono">{effectivePref}</span> here.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
