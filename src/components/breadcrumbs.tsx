"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Workspace-shell breadcrumb trail.
 *
 * Lives in the TopBar's left brand slot. Derives entirely from the
 * current pathname + a single targeted tRPC query for the entity name
 * (when on a detail page). Two layers, max:
 *
 *   Section · Entity
 *
 * Section is a constant lookup from the route prefix. Entity is the
 * issue key / project name / canvas name / plan title / artifact
 * title / cycle name / initiative name. Sections without a detail
 * route (Dashboard, Personal, Inbox, …) render as a single chip.
 *
 * The workspace itself sits in the sidebar's switcher; we don't repeat
 * it here so the breadcrumbs stay compact at narrow widths.
 */
export function Breadcrumbs() {
  const pathname = usePathname() ?? "";
  const ws = useMaybeWorkspace();
  const slug = ws?.slug ?? null;

  const parsed = useMemo(() => parsePath(pathname, slug), [pathname, slug]);

  // Hydrate the entity name only when on a detail route. Each query is
  // gated by `enabled` so we never fire more than one per route.
  const issueByIdQ = trpc.issue.byId.useQuery(
    { id: parsed?.entityKind === "issue-id" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "issue-id", staleTime: 60_000 },
  );
  const projectQ = trpc.project.byId.useQuery(
    { id: parsed?.entityKind === "project" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "project", staleTime: 60_000 },
  );
  const initiativeQ = trpc.initiative.get.useQuery(
    { id: parsed?.entityKind === "initiative" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "initiative", staleTime: 60_000 },
  );
  const cycleQ = trpc.cycle.get.useQuery(
    { id: parsed?.entityKind === "cycle" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "cycle", staleTime: 60_000 },
  );
  const canvasQ = trpc.canvas.get.useQuery(
    { id: parsed?.entityKind === "canvas" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "canvas", staleTime: 60_000 },
  );
  const planQ = trpc.executionPlan.get.useQuery(
    { id: parsed?.entityKind === "plan" ? parsed.entityId : "" },
    { enabled: parsed?.entityKind === "plan", staleTime: 60_000 },
  );
  const artifactQ = trpc.artifact.getBySlug.useQuery(
    { slug: parsed?.entityKind === "artifact" ? parsed.entitySlug : "" },
    { enabled: parsed?.entityKind === "artifact", staleTime: 60_000 },
  );

  const entityLabel: string | null = (() => {
    if (!parsed) return null;
    switch (parsed.entityKind) {
      case "none":
        return null;
      case "issue-id": {
        const d = issueByIdQ.data;
        if (!d) return "…";
        return formatIssueId(parsed.workspaceKey ?? "", d.number);
      }
      case "issue-key":
        return parsed.entityKey;
      case "project":
        return projectQ.data?.name ?? "…";
      case "initiative":
        return initiativeQ.data?.name ?? "…";
      case "cycle":
        return cycleQ.data?.name ?? "…";
      case "canvas":
        return canvasQ.data?.name ?? "…";
      case "plan":
        return planQ.data?.title ?? "…";
      case "artifact":
        return artifactQ.data?.title ?? "…";
    }
  })();

  if (!parsed || !slug) return null;

  const sectionHref = parsed.sectionHref ? `/w/${slug}${parsed.sectionHref}` : null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden min-w-0 items-center gap-1 text-meta text-muted-foreground md:flex"
    >
      {sectionHref ? (
        <Link
          href={sectionHref}
          className="focus-ring truncate rounded px-1 py-0.5 hover:bg-subtle hover:text-foreground"
        >
          {parsed.sectionLabel}
        </Link>
      ) : (
        <span className="truncate px-1 py-0.5 text-foreground">{parsed.sectionLabel}</span>
      )}
      {entityLabel && (
        <>
          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
          <span
            className={cn(
              "truncate px-1 py-0.5 text-foreground",
              entityLabel === "…" && "text-muted-foreground",
            )}
            title={entityLabel}
          >
            {entityLabel}
          </span>
        </>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

type SectionId =
  | "dashboard"
  | "personal"
  | "inbox"
  | "command-center"
  | "chat"
  | "issues"
  | "projects"
  | "review"
  | "time"
  | "cycles"
  | "initiatives"
  | "roadmap"
  | "artifacts"
  | "plans"
  | "canvas"
  | "analytics"
  | "agents"
  | "docs"
  | "settings"
  | "standup"
  | "focus"
  | "whats-new";

const SECTION_LABEL: Record<SectionId, string> = {
  dashboard: "Dashboard",
  personal: "Personal",
  inbox: "Inbox",
  "command-center": "Command Center",
  chat: "Chat",
  issues: "Issues",
  projects: "Projects",
  review: "Review",
  time: "Time",
  cycles: "Sprints",
  initiatives: "Initiatives",
  roadmap: "Roadmap",
  artifacts: "Artifacts",
  plans: "Plans",
  canvas: "Canvas",
  analytics: "Analytics",
  agents: "Agents",
  docs: "Docs",
  settings: "Settings",
  standup: "Standup",
  focus: "Focus",
  "whats-new": "What's New",
};

type ParsedRoute = {
  sectionId: SectionId;
  sectionLabel: string;
  sectionHref: string | null;
  entityKind:
    | "none"
    | "issue-id"
    | "issue-key"
    | "project"
    | "initiative"
    | "cycle"
    | "canvas"
    | "plan"
    | "artifact";
  entityId: string;
  entityKey: string;
  entitySlug: string;
  workspaceKey: string | null;
};

function parsePath(pathname: string, slug: string | null): ParsedRoute | null {
  if (!slug) return null;
  const prefix = `/w/${slug}`;
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length).replace(/\/+$/, "");
  if (!tail) return null;
  const parts = tail.split("/").filter(Boolean);
  const head = parts[0];
  if (!head) return null;

  // The `/i/:KEY-N` shortcut renders the issue detail page via a key
  // lookup rather than a cuid. We surface it under the Issues section.
  if (head === "i" && parts[1]) {
    return {
      sectionId: "issues",
      sectionLabel: SECTION_LABEL.issues,
      sectionHref: "/issues",
      entityKind: "issue-key",
      entityId: "",
      entityKey: parts[1],
      entitySlug: "",
      workspaceKey: null,
    };
  }

  if (!isSectionId(head)) {
    // Unknown segment — render a single best-effort chip from the slug.
    return {
      sectionId: "dashboard",
      sectionLabel: titleCase(head),
      sectionHref: `/${head}`,
      entityKind: "none",
      entityId: "",
      entityKey: "",
      entitySlug: "",
      workspaceKey: null,
    };
  }

  const sectionId: SectionId = head;
  const id = parts[1] ?? null;
  const entityKind: ParsedRoute["entityKind"] = (() => {
    if (!id) return "none";
    switch (sectionId) {
      case "issues":      return "issue-id";
      case "projects":    return "project";
      case "initiatives": return "initiative";
      case "cycles":      return "cycle";
      case "canvas":      return "canvas";
      case "plans":       return "plan";
      case "artifacts":   return "artifact";
      default:            return "none";
    }
  })();

  return {
    sectionId,
    sectionLabel: SECTION_LABEL[sectionId],
    sectionHref: id ? `/${head}` : null,
    entityKind,
    entityId: entityKind === "artifact" ? "" : id ?? "",
    entityKey: "",
    entitySlug: entityKind === "artifact" ? id ?? "" : "",
    workspaceKey: null,
  };
}

function isSectionId(v: string): v is SectionId {
  return v in SECTION_LABEL;
}

function titleCase(s: string): string {
  return s.replace(/(?:^|[-_/])([a-z])/g, (_, c: string) => " " + c.toUpperCase()).trim();
}
