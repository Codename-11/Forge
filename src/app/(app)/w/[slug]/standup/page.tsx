"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Moon } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc";

export default function StandupPage() {
  const [since, setSince] = useState(24);
  const { data, isLoading, refetch, isFetching } = trpc.standup.draft.useQuery({
    sinceHours: since,
  });

  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!data?.markdown) return;
    await navigator.clipboard.writeText(data.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
    toast.success("Copied to clipboard.");
  }

  return (
    <>
      <Topbar
        title="Standup draft"
        subtitle="Auto-generated from your recent activity. Edit + paste wherever you report."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex h-7 items-center gap-0.5 rounded-md bg-subtle p-0.5 text-[11px]">
              {[24, 72, 168].map((h) => (
                <button
                  key={h}
                  onClick={() => setSince(h)}
                  className={
                    "focus-ring rounded px-2 py-0.5 " +
                    (since === h
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {h === 24 ? "1d" : h === 72 ? "3d" : "7d"}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "…" : "Refresh"}
            </Button>
            <Button size="sm" variant="ember" onClick={copy} disabled={!data}>
              {copied ? "Copied" : "Copy markdown"}
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {isLoading || !data ? (
            <div className="rounded-lg border border-border bg-card/40 p-6 text-sm text-muted-foreground">
              Composing draft…
            </div>
          ) : data.counts.closed === 0 &&
            data.counts.opened === 0 &&
            data.counts.inProgress === 0 &&
            data.counts.blocked === 0 &&
            data.counts.moved === 0 ? (
            <div className="rounded-lg border border-border bg-card/30">
              <EmptyState
                variant="page"
                icon={<Moon />}
                title="Quiet day"
                description="When you log activity — close issues, leave comments, log time — your standup writes itself. Come back tomorrow."
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <Badge color="#65a30d">closed {data.counts.closed}</Badge>
                <Badge color="#0ea5e9">opened {data.counts.opened}</Badge>
                <Badge color="#ca8a04">in progress {data.counts.inProgress}</Badge>
                <Badge color="#be185d">stalled {data.counts.blocked}</Badge>
                <Badge>events {data.counts.moved}</Badge>
              </div>
              <pre className="whitespace-pre-wrap rounded-lg border border-border bg-card/40 p-4 font-sans text-[13px] leading-relaxed">
                {data.markdown}
              </pre>
              <p className="text-[11px] text-muted-foreground">
                Scope: last {data.sinceHours}h of your authored, assigned, or audited activity.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
