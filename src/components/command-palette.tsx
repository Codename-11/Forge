"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  ArrowRight,
  CircleDot,
  FolderKanban,
  LineChart,
  Plug,
  Inbox,
  Settings,
  Shield,
  Target,
  Users,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useHotkey } from "@/lib/keyboard";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

type NavAction = {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ElementType;
  run: () => void;
};

type IssueResult = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
  isIssue: true;
};

type Item = NavAction | IssueResult;

export function CommandPalette() {
  const router = useRouter();
  const ws = useMaybeWorkspace();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);

  useHotkey("cmd+k", () => setOpen((x) => !x));
  useHotkey("/", () => setOpen(true));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-command-palette]")) setOpen(true);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  useEffect(() => {
    if (!open) {
      setQ("");
      setI(0);
    }
  }, [open]);

  const wsPath = (p: string) => (ws ? `/w/${ws.slug}${p}` : p);

  const nav: NavAction[] = useMemo(
    () => [
      {
        id: "nav:inbox",
        label: "Go to Inbox",
        icon: Inbox,
        run: () => router.push(wsPath("/inbox")),
      },
      {
        id: "nav:issues",
        label: "Go to Issues",
        icon: CircleDot,
        run: () => router.push(wsPath("/issues")),
      },
      {
        id: "nav:projects",
        label: "Go to Projects",
        icon: FolderKanban,
        run: () => router.push(wsPath("/projects")),
      },
      {
        id: "nav:standup",
        label: "Go to Standup",
        icon: Target,
        run: () => router.push(wsPath("/standup")),
      },
      {
        id: "nav:analytics",
        label: "Go to Analytics",
        icon: LineChart,
        run: () => router.push(wsPath("/analytics")),
      },
      {
        id: "nav:settings",
        label: "Go to Workspace settings",
        icon: Settings,
        run: () => router.push(wsPath("/settings")),
      },
      {
        id: "nav:plugins",
        label: "Go to Plugins",
        icon: Plug,
        run: () => router.push(wsPath("/settings/plugins")),
      },
      {
        id: "nav:admin",
        label: "Go to Admin portal",
        icon: Shield,
        run: () => router.push(wsPath("/settings/admin")),
      },
      {
        id: "nav:account",
        label: "Go to Account settings",
        icon: Settings,
        run: () => router.push(ws ? `/w/${ws.slug}/settings/account` : "/settings/account"),
      },
      {
        id: "nav:workspaces",
        label: "Manage workspaces",
        icon: Users,
        run: () => router.push(ws ? `/w/${ws.slug}/settings/workspaces` : "/settings/workspaces"),
      },
    ],
    // `wsPath` closes over `ws`; including `ws` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router, ws?.slug],
  );

  const query = q.trim();
  const { data: wsCurrent } = trpc.workspace.current.useQuery(undefined, {
    enabled: open && !!ws,
  });
  const { data: issues } = trpc.issue.list.useQuery(
    { query, limit: 8, includeDone: true },
    { enabled: open && !!ws && query.length > 0 },
  );

  const issueItems: IssueResult[] = useMemo(
    () =>
      (issues?.items ?? []).map((it) => ({
        id: `issue:${it.id}`,
        label: it.title,
        hint: wsCurrent ? `${wsCurrent.key}-${it.number}` : `#${it.number}`,
        run: () => router.push(wsPath(`/issues/${it.id}`)),
        isIssue: true,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issues, router, wsCurrent, ws?.slug],
  );

  const filteredNav = query
    ? nav.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : nav;

  const items: Item[] = [...issueItems, ...filteredNav];

  const run = (a: Item) => {
    a.run();
    setOpen(false);
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search className="h-4 w-4 text-muted-foreground" />
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
            if (e.key === "Enter" && items[i]) run(items[i]);
          }}
          placeholder="Search issues, jump to page…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <span className="kbd">esc</span>
      </div>
      <ul className="max-h-96 overflow-y-auto py-1">
        {issueItems.length > 0 && (
          <li className="px-3 py-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            Issues
          </li>
        )}
        {issueItems.map((a, idx) => (
          <li key={a.id}>
            <button
              onMouseEnter={() => setI(idx)}
              onClick={() => run(a)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                idx === i ? "bg-subtle" : "",
              )}
            >
              <CircleDot className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">{a.label}</span>
              <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">{a.hint}</span>
            </button>
          </li>
        ))}
        {filteredNav.length > 0 && (
          <li className="mt-1 px-3 py-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            Navigate
          </li>
        )}
        {filteredNav.map((a, idxInNav) => {
          const idx = issueItems.length + idxInNav;
          const Icon = a.icon ?? ArrowRight;
          return (
            <li key={a.id}>
              <button
                onMouseEnter={() => setI(idx)}
                onClick={() => run(a)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                  idx === i ? "bg-subtle" : "",
                )}
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{a.label}</span>
                {a.hint && (
                  <span className="ml-auto text-[0.6875rem] text-muted-foreground">{a.hint}</span>
                )}
              </button>
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">No results.</li>
        )}
      </ul>
    </Dialog>
  );
}
