"use client";
import { useCallback, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Paperclip, Link2, Activity as ActivityIcon } from "lucide-react";
import { IssueAttachmentsPanel } from "@/components/attachments/issue-attachments-panel";
import { IssueRelationsPanel } from "@/components/relations/issue-relations-panel";
import { IssueActivityPanel } from "@/components/issue-detail/issue-activity-panel";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";

/**
 * Tabbed right-rail for the issue detail page. Hosts the existing
 * attachments + relations panels and the new activity stream.
 *
 * Tab state is mirrored into the `?tab=` search param so individual tabs
 * are deep-linkable (and survive reloads). Keys 1/2/3 cycle between tabs
 * when the page has focus — bound here, scoped to the issue detail route
 * so we don't pollute global keybindings.
 */

const TABS = [
  { id: "attachments", label: "Attachments", icon: Paperclip },
  { id: "relations", label: "Relations", icon: Link2 },
  { id: "activity", label: "Activity", icon: ActivityIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(v: string | null | undefined): v is TabId {
  return v === "attachments" || v === "relations" || v === "activity";
}

export function IssueRail({ issueId }: { issueId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams?.get("tab");
  const active: TabId = isTabId(raw) ? raw : "attachments";

  const setTab = useCallback(
    (next: TabId) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (next === "attachments") params.delete("tab");
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
        setTab("attachments");
      } else if (e.key === "2") {
        e.preventDefault();
        setTab("relations");
      } else if (e.key === "3") {
        e.preventDefault();
        setTab("activity");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Issue detail sections"
        className="flex items-center gap-px border-b border-border bg-card/30 px-2"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setTab(t.id)}
              className={cn(
                "focus-ring relative flex h-8 items-center gap-1.5 rounded-t-md px-2.5 text-[0.6875rem] font-medium",
                MOTION.fast,
                selected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={`${t.label} — ${TABS.indexOf(t) + 1}`}
            >
              <Icon className="h-3 w-3" />
              <span>{t.label}</span>
              {selected && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-px h-px bg-ember"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
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
