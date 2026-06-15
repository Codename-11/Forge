import { z } from "zod";
import { Priority, StatusCategory, WorkItemKind } from "@prisma/client";

/**
 * Canonical Zod schema for the per-user `IssueSavedView.filters` JSON
 * blob. Phase 1D owns this shape (Phase 0 left it opaque).
 *
 * Design: a clean **projection** of `issue.list`'s real input. The list
 * router still accepts singletons (`projectId`, `statusId`, …) for
 * legacy call-sites; the saved-view filters always speak in arrays so a
 * view can pin "any of {Backlog, Todo}" or "any of {urgent, high}". The
 * server-side `issue.list` was extended in lockstep to accept the array
 * forms, plus the synthesized predicates here (`unassigned`, `blocked`,
 * `updatedSince`).
 *
 * Tri-state semantics for `cycleIds` / `initiativeIds`:
 *   omitted        — no filter
 *   non-empty []   — match any of the listed ids
 *   contains null  — match issues with NO cycle / no initiative
 * (We model this as a separate `*WithoutCycle` / `*WithoutInitiative`
 * boolean rather than nullable strings to keep the JSON schema flat
 * and serializable.)
 *
 * Status semantics:
 *   `statusIds`         — exact status row ids
 *   `statusCategories`  — buckets like BACKLOG, IN_PROGRESS, DONE
 *
 * Both are accepted; `issue.list` ORs across them when the saved-view
 * driver dispatches the query.
 */

export const UPDATED_SINCE_VALUES = ["1d", "3d", "7d", "30d"] as const;
export type UpdatedSinceWindow = (typeof UPDATED_SINCE_VALUES)[number];

/**
 * Issue-list ordering. Not part of the saved-view filter blob — it's a
 * per-user *view* preference (like density), threaded straight into
 * `issue.list` as `sort`. Shared here so the server enum and the client
 * control can't drift.
 */
export const ISSUE_SORT_VALUES = [
  "priority",
  "newest",
  "oldest",
  "updated",
  "title",
] as const;
export type IssueSort = (typeof ISSUE_SORT_VALUES)[number];

/**
 * Client-side grouping dimension for the issue list. Purely presentational
 * (the list still fetches a flat, server-sorted page and buckets it in the
 * browser), so this never reaches the server.
 */
export const ISSUE_GROUP_VALUES = [
  "status",
  "project",
  "assignee",
  "priority",
  "none",
] as const;
export type IssueGroupBy = (typeof ISSUE_GROUP_VALUES)[number];

const cuidArray = z.array(z.string().cuid()).max(100);

export const TERMINAL_STATUS_CATEGORIES = [
  StatusCategory.DONE,
  StatusCategory.CANCELED,
] as const;

const TERMINAL_STATUS_CATEGORY_SET = new Set<string>(TERMINAL_STATUS_CATEGORIES);

export function hasTerminalStatusCategory(
  categories: readonly StatusCategory[] | undefined,
): boolean {
  return (categories ?? []).some((category) => TERMINAL_STATUS_CATEGORY_SET.has(category));
}

export function withIncludeDoneForTerminalFilters(
  filters: SavedViewFilters,
): SavedViewFilters {
  return hasTerminalStatusCategory(filters.statusCategories)
    ? { ...filters, includeDone: true }
    : filters;
}

export const SavedViewFiltersSchema = z
  .object({
    /** Exact status ids (workspace-scoped). */
    statusIds: cuidArray.optional(),
    /** Status buckets — useful for "any backlog" without pinning ids. */
    statusCategories: z.array(z.nativeEnum(StatusCategory)).max(8).optional(),
    /** Human assignees (any-of). */
    assigneeIds: cuidArray.optional(),
    /** Toggle: only issues with no human assignee + no agent. */
    unassigned: z.boolean().optional(),
    /** Label ids (any-of). */
    labelIds: cuidArray.optional(),
    /** Project ids (any-of). */
    projectIds: cuidArray.optional(),
    /** Match issues with no project. */
    withoutProject: z.boolean().optional(),
    /** Initiative ids (any-of). */
    initiativeIds: cuidArray.optional(),
    /** Match issues whose project has no initiative (or no project). */
    withoutInitiative: z.boolean().optional(),
    /** Cycle (Sprint) ids (any-of). */
    cycleIds: cuidArray.optional(),
    /** Match issues with no cycle assignment. */
    withoutCycle: z.boolean().optional(),
    /** Priority enums (any-of). Stored as the enum string value. */
    priorities: z.array(z.nativeEnum(Priority)).max(8).optional(),
    /** Work-item kinds (any-of). e.g. `["EPIC"]` for the Epics view. */
    kinds: z.array(z.nativeEnum(WorkItemKind)).max(8).optional(),
    /** Toggle: only issues blocked by an open dependency. */
    blocked: z.boolean().optional(),
    /** Window for "updated within last N days". */
    updatedSince: z.enum(UPDATED_SINCE_VALUES).optional(),
    /** Free-text search across title + description. */
    query: z.string().min(1).max(200).optional(),
    /** Toggle: include DONE/CANCELED rows. Default false (matches /issues). */
    includeDone: z.boolean().optional(),
  })
  .strict();

export type SavedViewFilters = z.infer<typeof SavedViewFiltersSchema>;

/** Build a brand-new empty filters object. Useful as a stable default. */
export function emptyFilters(): SavedViewFilters {
  return {};
}

/** Returns true when no filter predicate is set. */
export function isEmptyFilters(f: SavedViewFilters | null | undefined): boolean {
  if (!f) return true;
  for (const v of Object.values(f)) {
    if (Array.isArray(v)) {
      if (v.length > 0) return false;
    } else if (typeof v === "boolean") {
      if (v) return false;
    } else if (v !== undefined && v !== null) {
      return false;
    }
  }
  return true;
}

/** Lossy parse — unknown shapes fall back to {}. Used at read time so a
 *  legacy or hand-edited row never throws in the UI. */
export function safeParseFilters(input: unknown): SavedViewFilters {
  const r = SavedViewFiltersSchema.safeParse(input ?? {});
  return r.success ? r.data : {};
}

/**
 * Order-independent value-equality on two filter blobs. Arrays are
 * compared as sets (order doesn't matter to the query), and missing
 * vs. empty-array vs. undefined all collapse to "no filter set" so a
 * canonicalized blob compares equal to a freshly-built one.
 *
 * Used by the saved-views bar to decide whether the current
 * `/issues` filter state matches an existing view exactly. When it
 * does, the bar surfaces "Save changes" + "New view"; when it
 * doesn't, it offers "Save view".
 */
export function filtersEqual(
  a: SavedViewFilters | null | undefined,
  b: SavedViewFilters | null | undefined,
): boolean {
  const A = a ?? {};
  const B = b ?? {};
  const keys = new Set<string>([...Object.keys(A), ...Object.keys(B)]);
  for (const k of keys) {
    const va = (A as Record<string, unknown>)[k];
    const vb = (B as Record<string, unknown>)[k];
    if (Array.isArray(va) || Array.isArray(vb)) {
      const aa = Array.isArray(va) ? [...va].map(String).sort() : [];
      const bb = Array.isArray(vb) ? [...vb].map(String).sort() : [];
      if (aa.length !== bb.length) return false;
      for (let i = 0; i < aa.length; i++) {
        if (aa[i] !== bb[i]) return false;
      }
      continue;
    }
    // Treat undefined and "false" as equivalent for booleans —
    // omitting a toggle and explicitly setting it false both mean
    // "off". Mirrors `isEmptyFilters`.
    const va_n = va === undefined || va === false ? null : va;
    const vb_n = vb === undefined || vb === false ? null : vb;
    if (va_n !== vb_n) return false;
  }
  return true;
}

/**
 * Status ids whose category is DONE or CANCELED. Cheap to recompute from
 * the workspace's `status.list`.
 */
export function doneStatusIds(
  statuses: ReadonlyArray<{ id: string; category: StatusCategory }>,
): Set<string> {
  return new Set(
    statuses
      .filter((s) => s.category === StatusCategory.DONE || s.category === StatusCategory.CANCELED)
      .map((s) => s.id),
  );
}

/**
 * Whether a filter explicitly targets a completed status — a DONE/CANCELED
 * status id, or the DONE/CANCELED category.
 */
export function filtersTargetDone(
  filters: SavedViewFilters | null | undefined,
  done: Set<string>,
): boolean {
  const cats = filters?.statusCategories ?? [];
  if (cats.includes(StatusCategory.DONE) || cats.includes(StatusCategory.CANCELED)) return true;
  return (filters?.statusIds ?? []).some((id) => done.has(id));
}

/**
 * Effective `includeDone` for a list/count query. An explicit
 * `filters.includeDone` (or the surface's `base` default) normally wins —
 * but a filter that explicitly targets a completed status forces done rows
 * in, otherwise selecting "Done" would return nothing. Shared by the list,
 * the board, and the header count so all three agree.
 */
export function resolveIncludeDone(
  filters: SavedViewFilters | null | undefined,
  base: boolean,
  done: Set<string>,
): boolean {
  return (filters?.includeDone ?? base) || filtersTargetDone(filters, done);
}

/** Lookup table for `updatedSince`. Returns the threshold as a Date. */
export function updatedSinceToDate(window: UpdatedSinceWindow): Date {
  const days = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 }[window];
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}
