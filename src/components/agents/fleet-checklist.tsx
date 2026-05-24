"use client";

import Link from "next/link";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * "Fleet setup" checklist — the one place that threads the agent setup arc
 * (runtime → agent → key → chat-ready) which otherwise spans four settings
 * pages. Read-only, derived entirely from existing queries; collapses to a
 * single "fleet ready" line once all steps are done.
 */
export function FleetChecklist({ slug }: { slug: string }) {
  const { data: runtimes } = trpc.runtime.list.useQuery({ includeArchived: false });
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: keys } = trpc.access.list.useQuery();

  // Still loading the inputs — render nothing rather than a flash of "todo".
  if (!runtimes || !agents || !keys) return null;

  const runtimeOnline = runtimes.some((r) => {
    if (!r.heartbeatAt) return false;
    const age = Date.now() - new Date(r.heartbeatAt).getTime();
    return !Number.isNaN(age) && age < 300_000;
  });
  const hasAgent = agents.length > 0;
  const hasKey = (keys as unknown[]).length > 0;
  const chatReady = agents.some(
    (a) => (a as { transport?: { mode?: string } }).transport?.mode &&
      (a as { transport?: { mode?: string } }).transport!.mode !== "none",
  );

  const items: Array<{ done: boolean; label: string; hint: string; href: string }> = [
    {
      done: runtimes.length > 0,
      label: runtimeOnline ? "Runtime registered & online" : "Runtime registered",
      hint:
        runtimes.length === 0
          ? "Register a managed runtime (Hermes, Codex app server) or run `forge daemon`."
          : runtimeOnline
            ? "At least one runtime is heartbeating."
            : "Registered, but none heartbeating in the last 5 min.",
      href: `/w/${slug}/settings/runtimes`,
    },
    {
      done: hasAgent,
      label: "Agent created",
      hint: hasAgent ? `${agents.length} agent${agents.length === 1 ? "" : "s"}.` : "Add your first agent below.",
      href: `/w/${slug}/settings/agents`,
    },
    {
      done: hasKey,
      label: "API key issued",
      hint: hasKey ? "A key exists for agent/MCP access." : "Issue a key so a runtime can authenticate.",
      href: `/w/${slug}/settings/access`,
    },
    {
      done: chatReady,
      label: "Chat-ready",
      hint: chatReady
        ? "At least one agent resolves a chat transport."
        : "No agent can serve chat yet — attach a runtime or configure a model.",
      href: `/w/${slug}/settings/integrations`,
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const allDone = doneCount === items.length;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-ember" />
        <h2 className="text-sm font-semibold text-foreground">Fleet setup</h2>
        <span
          className={cn(
            "ml-auto rounded-full border px-2 py-0.5 text-[0.625rem] uppercase tracking-wider",
            allDone
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-border bg-subtle/40 text-muted-foreground",
          )}
        >
          {allDone ? "ready" : `${doneCount}/${items.length}`}
        </span>
      </div>
      {!allDone && (
        <ul className="mt-3 space-y-1.5">
          {items.map((item) => (
            <li key={item.label}>
              <Link
                href={item.href}
                className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-subtle/50"
              >
                {item.done ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                )}
                <span className="min-w-0">
                  <span
                    className={cn(
                      "text-[0.8125rem]",
                      item.done ? "text-foreground/70" : "text-foreground",
                    )}
                  >
                    {item.label}
                  </span>
                  <span className="block text-[0.6875rem] text-muted-foreground">{item.hint}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
