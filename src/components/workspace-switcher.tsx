"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useChord, useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Top-of-shell workspace pill + switcher.
 *
 * Click or press `g w` (leader chord) to open a Linear-style picker. The
 * switcher persists the selection via `workspace.setLastWorkspace` and then
 * routes to `/w/<slug>/inbox` (the unified workspace landing, née
 * Dashboard). `cmd+k` remains bound to the command
 * palette; `g w` is the dedicated chord for this picker so it doesn't
 * conflict with the broader command surface.
 */
export function WorkspaceSwitcher() {
  const ws = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);

  const { data: workspaces, isLoading } = trpc.workspace.list.useQuery(undefined, {
    enabled: open,
  });
  const setLast = trpc.workspace.setLastWorkspace.useMutation();

  useHotkey("escape", () => open && setOpen(false));
  useChord("g", { w: () => setOpen(true) });

  useEffect(() => {
    if (!open) {
      setQ("");
      setI(0);
    }
  }, [open]);

  const query = q.trim().toLowerCase();
  const items = useMemo(() => {
    const list = workspaces ?? [];
    if (!query) return list;
    return list.filter(
      (w) =>
        w.name.toLowerCase().includes(query) ||
        w.key.toLowerCase().includes(query) ||
        w.slug.toLowerCase().includes(query),
    );
  }, [workspaces, query]);

  function go(w: { id: string; slug: string }) {
    setOpen(false);
    if (w.slug === ws.slug) return;
    // Fire-and-forget — UX doesn't block on persistence.
    setLast.mutate({ workspaceId: w.id });
    router.push(`/w/${w.slug}/inbox`);
  }

  const badge = workspaceColor(ws.key);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Switch workspace  (g w)"
        className="focus-ring group inline-flex h-7 items-center gap-2 rounded-md border border-border bg-card/60 pl-1 pr-2 text-left hover:bg-subtle"
      >
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[0.6875rem] font-semibold"
          style={{
            backgroundColor: badge.bg,
            color: badge.fg,
            boxShadow: `inset 0 0 0 1px ${badge.ring}`,
          }}
        >
          {ws.key.slice(0, 2)}
        </span>
        <span className="truncate text-[0.8125rem] font-medium tracking-tight">{ws.name}</span>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground opacity-60 group-hover:opacity-100" />
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setI((x) => Math.min(items.length - 1, x + 1));
              if (e.key === "ArrowUp") setI((x) => Math.max(0, x - 1));
              if (e.key === "Enter" && items[i]) go(items[i]);
            }}
            placeholder="Switch to workspace…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <span className="kbd">esc</span>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {isLoading && (
            <li className="px-3 py-3 text-xs text-muted-foreground">Loading…</li>
          )}
          {!isLoading && items.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">
              No matching workspaces.
            </li>
          )}
          {items.map((w, idx) => {
            const active = w.slug === ws.slug;
            const c = workspaceColor(w.key);
            return (
              <li key={w.id}>
                <button
                  type="button"
                  onMouseEnter={() => setI(idx)}
                  onClick={() => go(w)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                    idx === i ? "bg-subtle" : "",
                  )}
                >
                  <span
                    className="grid h-6 w-6 shrink-0 place-items-center rounded font-mono text-[0.6875rem] font-semibold"
                    style={{
                      backgroundColor: c.bg,
                      color: c.fg,
                      boxShadow: `inset 0 0 0 1px ${c.ring}`,
                    }}
                  >
                    {w.key.slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{w.name}</div>
                    <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {w.key} · /{w.slug}
                    </div>
                  </div>
                  {active && <Check className="h-3.5 w-3.5 text-ember" />}
                </button>
              </li>
            );
          })}
          <li className="mt-1 border-t border-border">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                router.push(`/w/${ws.slug}/settings/workspaces`);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Create or manage workspaces
            </button>
          </li>
        </ul>
      </Dialog>
    </>
  );
}
