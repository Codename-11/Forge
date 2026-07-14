"use client";
import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Paperclip, Link2, Activity as ActivityIcon } from "lucide-react";
import { IssueAttachmentsPanel } from "@/components/attachments/issue-attachments-panel";
import { IssueRelationsPanel } from "@/components/relations/issue-relations-panel";
import { IssueActivityPanel } from "@/components/issue-detail/issue-activity-panel";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { trpc } from "@/lib/trpc";

/**
 * Tabbed right-rail for the issue detail page. Hosts the existing
 * attachments + relations panels and the new activity stream.
 *
 * Tab state is mirrored into the `?tab=` search param so individual tabs
 * are deep-linkable (and survive reloads). Activity leads the navigation
 * and is the bare-URL default so recent work is visible without discovery.
 * Keys 1/2/3 cycle between tabs
 * when the page has focus — bound here, scoped to the issue detail route
 * so we don't pollute global keybindings.
 */

const TABS = [
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "relations", label: "Relations", icon: Link2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

function tabButtonId(issueId: string, tab: TabId) {
  return `issue-${issueId}-${tab}-tab`;
}

function tabPanelId(issueId: string) {
  return `issue-${issueId}-detail-panel`;
}

function isTabId(v: string | null | undefined): v is TabId {
  return v === "attachments" || v === "relations" || v === "activity";
}

export function IssueRail({
  issueId,
  header,
  activityCount,
}: {
  issueId: string;
  activityCount?: number;
  /**
   * Optional content rendered above the tab strip — the issue detail
   * page passes its "Properties" group (project / labels / due / agent
   * queue) here so the metadata sits in the rail instead of dangling at
   * the bottom of the main column.
   */
  header?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams?.get("tab");
  const active: TabId = isTabId(raw) ? raw : "activity";
  const { data: activeRun } = trpc.agentRun.activeForIssue.useQuery(
    { issueId },
    { staleTime: 5_000 },
  );

  const setTab = useCallback(
    (next: TabId) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "activity") params.delete("tab");
      else params.set("tab", next);
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // 1 / 2 / 3 switch tabs. Scoped here — we listen only while the issue
  // detail is mounted, and we bail out when the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === "1") {
        e.preventDefault();
        setTab("activity");
      } else if (e.key === "2") {
        e.preventDefault();
        setTab("attachments");
      } else if (e.key === "3") {
        e.preventDefault();
        setTab("relations");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  const focusTab = useCallback(
    (next: TabId) => {
      setTab(next);
      requestAnimationFrame(() => document.getElementById(tabButtonId(issueId, next))?.focus());
    },
    [issueId, setTab],
  );

  return (
    <div className="min-h-0">
      {header && <div className="border-b border-border bg-card/20 px-3 py-2.5">{header}</div>}
      <div
        role="tablist"
        aria-label="Issue detail sections"
        className="flex items-center gap-px border-b border-border bg-card/30 px-2"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const selected = active === t.id;
          const index = TABS.indexOf(t);
          return (
            <button
              key={t.id}
              id={tabButtonId(issueId, t.id)}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={tabPanelId(issueId)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => {
                let next: TabId | null = null;
                if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length].id;
                else if (event.key === "ArrowLeft")
                  next = TABS[(index - 1 + TABS.length) % TABS.length].id;
                else if (event.key === "Home") next = TABS[0].id;
                else if (event.key === "End") next = TABS[TABS.length - 1].id;
                if (!next) return;
                event.preventDefault();
                focusTab(next);
              }}
              className={cn(
                "focus-ring relative flex h-9 items-center gap-1.5 rounded-t-md px-2.5 text-xs font-medium",
                MOTION.fast,
                selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              title={`${t.label} — ${TABS.indexOf(t) + 1}`}
            >
              <Icon aria-hidden className="h-3 w-3" />
              <span>{t.label}</span>
              {t.id === "activity" && activityCount !== undefined ? (
                <span className="rounded-full bg-subtle px-1.5 py-px text-[0.5625rem] font-medium tabular-nums text-muted-foreground">
                  {activityCount > 99 ? "99+" : activityCount}
                </span>
              ) : null}
              {t.id === "activity" && activeRun ? (
                <span
                  className="relative flex h-1.5 w-1.5"
                  aria-label="Live agent activity"
                  title="Agent work is updating live"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember/50" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ember" />
                </span>
              ) : null}
              {selected && (
                <span aria-hidden className="absolute inset-x-0 -bottom-px h-px bg-ember" />
              )}
            </button>
          );
        })}
      </div>
      <div
        id={tabPanelId(issueId)}
        role="tabpanel"
        aria-labelledby={tabButtonId(issueId, active)}
        tabIndex={0}
        className="focus-ring rounded-b-lg px-3 py-3"
      >
        {/* Keep each tab simple — reuse the battle-tested panels as-is. */}
        <ActiveTab tab={active} issueId={issueId} />
      </div>
    </div>
  );
}

function ActiveTab({ tab, issueId }: { tab: TabId; issueId: string }) {
  // Each panel handles its own data fetching via tRPC — switching tabs
  // just swaps which one mounts. React Query keeps the data warm across
  // swaps so flipping back to a recently-viewed tab feels instant.
  if (tab === "attachments") return <IssueAttachmentsPanel issueId={issueId} />;
  if (tab === "relations") return <IssueRelationsPanel issueId={issueId} />;
  return <IssueActivityPanel issueId={issueId} />;
}
