import React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export type IssueReferenceValue = {
  id?: string;
  number: number;
  title: string;
  workspace: { key: string; slug?: string | null };
};

/**
 * Human-readable issue identity for operational surfaces. Identifiers remain
 * scannable in mono, while the title carries the meaning an operator needs to
 * decide whether to open or act on the item.
 */
export function IssueReference({
  issue,
  href,
  className,
  titleClassName,
}: {
  issue: IssueReferenceValue;
  href?: string | null;
  className?: string;
  titleClassName?: string;
}) {
  const identifier = `${issue.workspace.key}-${issue.number}`;
  const content = (
    <>
      <span className="text-id shrink-0 text-muted-foreground">{identifier}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground/60">
        ·
      </span>
      <span className={cn("min-w-0 truncate", titleClassName)} title={issue.title}>
        {issue.title}
      </span>
    </>
  );
  const shared = cn("focus-ring inline-flex min-w-0 items-baseline gap-1.5 rounded-sm", className);

  return href ? (
    <Link
      href={href}
      className={cn(shared, "hover:text-ember")}
      aria-label={`${identifier}: ${issue.title}`}
    >
      {content}
    </Link>
  ) : (
    <span className={shared} aria-label={`${identifier}: ${issue.title}`}>
      {content}
    </span>
  );
}
