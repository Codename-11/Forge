"use client";
import { useRouter } from "next/navigation";
import { Pin as PinIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Cross-workspace personal pins strip, rendered in the workspace shell
 * header-ish area. Up to 3 slots; empty slots render a subtle placeholder
 * so users can see the surface is pinnable. Clicking a slot navigates to
 * the issue in its *own* workspace (pins are workspace-agnostic).
 */
const MAX_SLOTS = 3;

export function PinsStrip() {
  const router = useRouter();
  const { data } = trpc.pin.list.useQuery();
  const pins = data ?? [];
  const slots = [...pins];
  while (slots.length < MAX_SLOTS) slots.push(null as unknown as (typeof pins)[number]);

  return (
    <div className="hidden items-center gap-1 md:flex">
      {slots.slice(0, MAX_SLOTS).map((pin, idx) => {
        if (!pin) {
          return (
            <div
              key={`empty-${idx}`}
              className="inline-flex h-7 min-w-[96px] items-center gap-1.5 rounded-md border border-dashed border-border/70 px-2 text-[11px] text-muted-foreground/60"
              title="Press p on an issue to pin it"
            >
              <PinIcon className="h-3 w-3" />
              <span>Pin…</span>
            </div>
          );
        }
        const badge = workspaceColor(pin.workspace.key);
        const href = `/w/${pin.workspace.slug}/issues/${pin.id}`;
        const idLabel = formatIssueId(pin.workspace.key, pin.number);
        return (
          <button
            key={pin.id}
            type="button"
            onClick={() => router.push(href)}
            title={`${idLabel} · ${pin.title}`}
            className={cn(
              "focus-ring group inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-card/60 pl-1 pr-2 text-left hover:bg-subtle",
            )}
          >
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[9px] font-semibold"
              style={{
                backgroundColor: badge.bg,
                color: badge.fg,
                boxShadow: `inset 0 0 0 1px ${badge.ring}`,
              }}
            >
              {pin.workspace.key.slice(0, 2)}
            </span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {idLabel}
            </span>
            <span className="truncate text-[11px]">{pin.title}</span>
          </button>
        );
      })}
    </div>
  );
}
