"use client";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { cn } from "@/lib/utils";
import { IssueTemplatesPanel } from "./_issue-templates";
import { ProjectTemplatesPanel } from "./_project-templates";

type TabKey = "issue" | "project";

export default function TemplatesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: TabKey = searchParams.get("type") === "project" ? "project" : "issue";

  const setTab = (next: TabKey) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (next === "issue") sp.delete("type");
    else sp.set("type", "project");
    router.replace(`${pathname}${sp.toString() ? `?${sp.toString()}` : ""}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        title="Templates"
        subtitle="Reusable starting points for issues and projects."
      />
      <div className="border-b border-border px-5 py-2">
        <nav aria-label="Template type" className="flex gap-1">
          {[
            { key: "issue" as const, label: "Issue templates" },
            { key: "project" as const, label: "Project templates" },
          ].map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "focus-ring inline-flex h-7 items-center rounded-md px-2.5 text-[0.75rem] transition-colors",
                  active
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:bg-subtle/70 hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "issue" ? <IssueTemplatesPanel /> : <ProjectTemplatesPanel />}
      </div>
    </div>
  );
}
