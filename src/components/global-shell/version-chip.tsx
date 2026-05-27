"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Compact build/version chip for shell footers (global concourse + admin).
 * Shows the running version (and short SHA on hover/title) and links to
 * What's New. Single source of truth: `system.buildInfo`. Keep it subtle —
 * it's an at-a-glance "what's running", not a headline.
 */
export function VersionChip({
  href = "/whats-new",
  tone = "default",
  className,
}: {
  href?: string;
  tone?: "default" | "admin";
  className?: string;
}) {
  const { data } = trpc.system.buildInfo.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const version = data?.version ?? null;
  const sha = data?.gitSha ?? null;
  const label = version ? `v${version}` : "Forge";
  const title = [
    version ? `Forge v${version}` : "Forge",
    data?.release ? `release ${data.release}` : null,
    sha ? `build ${sha}` : null,
    data?.buildTime ? `built ${data.buildTime}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const styles =
    tone === "admin"
      ? { color: "hsl(var(--admin-text-dim))" }
      : undefined;

  return (
    <Link
      href={href}
      title={`${title} — What's new`}
      style={styles}
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] tabular-nums transition-colors",
        tone === "admin"
          ? "hover:bg-white/5"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
        className,
      )}
    >
      <Sparkles size={11} className={tone === "admin" ? "" : "text-muted-foreground/70"} />
      <span className="font-medium">{label}</span>
      {sha && <span className="opacity-60">· {sha}</span>}
      <span className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">{"What's new →"}</span>
    </Link>
  );
}
