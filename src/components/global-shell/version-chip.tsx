"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Compact build/version chip for shell headers and footers.
 * Shows the running version and short SHA (full SHA on hover/title), linking to
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

  const styles = tone === "admin" ? { color: "hsl(var(--admin-text-muted))" } : undefined;

  return (
    <Link
      href={href}
      title={`${title} — What's new`}
      aria-label={`${title} — What's new`}
      style={styles}
      className={cn(
        "group inline-flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md px-2 py-1 text-[0.6875rem] tabular-nums transition-colors",
        tone === "admin"
          ? "hover:bg-white/5"
          : "text-muted-foreground hover:bg-subtle hover:text-foreground",
        className,
      )}
    >
      <Sparkles
        size={11}
        aria-hidden
        className={cn("shrink-0", tone !== "admin" && "text-muted-foreground/70")}
      />
      <span className="shrink-0 font-medium">{label}</span>
      {sha && <span className="min-w-0 truncate font-mono opacity-70">· {sha.slice(0, 7)}</span>}
      <span className="sr-only"> — What&apos;s new</span>
    </Link>
  );
}
