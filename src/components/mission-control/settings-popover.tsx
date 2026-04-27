"use client";
import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsPopoverProps {
  soundEnabled: boolean;
  onToggleSound: () => void;
}

export function SettingsPopover({ soundEnabled, onToggleSound }: SettingsPopoverProps) {
  const [open, setOpen] = useState(false);
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
            className="absolute right-0 top-7 z-40 w-56 rounded-md border border-border bg-card p-2 shadow-md"
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
            <p className="px-2 pt-1 text-[0.625rem] text-muted-foreground">
              Soft chime on run complete, lower on stall. Throttled per agent.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
