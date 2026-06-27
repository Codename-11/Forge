import type { PrismaClient } from "@prisma/client";
import { formatIssueId } from "@/lib/utils";

/**
 * Resolve human-readable labels for polymorphic `ActivityEvent`
 * subjects (`subjectType` + `subjectId`). Audit logs, webhook deliveries,
 * and similar surfaces persist a bare `subjectId` cuid; this turns a batch
 * of those into `{ label, secondary }` so the UI can show "AXI-42 · Fix
 * login" instead of "issue · a1b2c3d4".
 *
 * Batched one query per subject type (no N+1). Types with no clear name
 * (comments, review gates, chat threads, transient stream/ack events) are
 * simply absent from the result — callers fall back to a humanized type +
 * short id. Pass `workspaceId` to scope lookups to a tenant; omit it for
 * instance-admin (cross-tenant) views, where cuids are globally unique.
 */
export type SubjectRef = {
  subjectType: string | null;
  subjectId: string | null;
};

export type SubjectLabel = {
  /** Primary text — the entity's name/title (or issue title). */
  label: string;
  /** Right-aligned hint — issue key, `@handle`, … (null when none). */
  secondary: string | null;
};

/** Stable map key for a (type, id) pair. */
export function subjectKey(
  subjectType: string | null,
  subjectId: string | null,
): string {
  return `${subjectType ?? ""}:${subjectId ?? ""}`;
}

/** "execution-plan" → "Execution plan". Used for null-title fallbacks. */
export function humanizeSubjectType(subjectType: string): string {
  const spaced = subjectType.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function resolveSubjectLabels(
  db: PrismaClient,
  refs: ReadonlyArray<SubjectRef>,
  opts: { workspaceId?: string } = {},
): Promise<Map<string, SubjectLabel>> {
  const out = new Map<string, SubjectLabel>();

  // Dedupe ids per type.
  const idsByType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r.subjectType || !r.subjectId) continue;
    let set = idsByType.get(r.subjectType);
    if (!set) {
      set = new Set();
      idsByType.set(r.subjectType, set);
    }
    set.add(r.subjectId);
  }
  if (idsByType.size === 0) return out;

  const ids = (type: string) => Array.from(idsByType.get(type) ?? []);
  const ws = opts.workspaceId ? { workspaceId: opts.workspaceId } : {};
  const put = (
    type: string,
    id: string,
    label: string,
    secondary: string | null = null,
  ) => out.set(subjectKey(type, id), { label, secondary });

  const tasks: Promise<void>[] = [];

  // Issue → title + key.
  if (ids("issue").length) {
    tasks.push(
      db.issue
        .findMany({
          where: { id: { in: ids("issue") }, ...ws },
          select: {
            id: true,
            number: true,
            title: true,
            workspace: { select: { key: true } },
          },
        })
        .then((rows) => {
          for (const r of rows) {
            put("issue", r.id, r.title, formatIssueId(r.workspace.key, r.number));
          }
        }),
    );
  }

  // Agent → name + @handle.
  if (ids("agent").length) {
    tasks.push(
      db.agent
        .findMany({
          where: { id: { in: ids("agent") }, ...ws },
          select: { id: true, name: true, profileKey: true },
        })
        .then((rows) => {
          for (const r of rows) {
            put("agent", r.id, r.name, r.profileKey ? `@${r.profileKey}` : null);
          }
        }),
    );
  }

  // `name`-bearing models.
  const addName = (
    type: string,
    run: (idList: string[]) => Promise<{ id: string; name: string }[]>,
  ) => {
    const list = ids(type);
    if (!list.length) return;
    tasks.push(
      run(list).then((rows) => {
        for (const r of rows) put(type, r.id, r.name);
      }),
    );
  };

  addName("project", (i) =>
    db.project.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );
  addName("initiative", (i) =>
    db.initiative.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );
  addName("cycle", (i) =>
    db.cycle.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );
  addName("agent-crew", (i) =>
    db.agentCrew.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );
  addName("context-set", (i) =>
    db.contextSet.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );
  addName("workspace-canvas", (i) =>
    db.workspaceCanvas.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, name: true } }),
  );

  // `title`-bearing models (title may be null → humanized-type fallback).
  const addTitle = (
    type: string,
    run: (idList: string[]) => Promise<{ id: string; title: string | null }[]>,
  ) => {
    const list = ids(type);
    if (!list.length) return;
    tasks.push(
      run(list).then((rows) => {
        for (const r of rows) {
          put(type, r.id, r.title?.trim() || humanizeSubjectType(type));
        }
      }),
    );
  };

  addTitle("goal", (i) =>
    db.goal.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );
  addTitle("execution-plan", (i) =>
    db.executionPlan.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );
  addTitle("execution-step", (i) =>
    db.executionStep.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );
  addTitle("action-request", (i) =>
    db.actionRequest.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );
  addTitle("artifact", (i) =>
    db.artifact.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );
  addTitle("note", (i) =>
    db.note.findMany({ where: { id: { in: i }, ...ws }, select: { id: true, title: true } }),
  );

  await Promise.all(tasks);
  return out;
}
