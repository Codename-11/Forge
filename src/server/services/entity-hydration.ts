import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type ForgeEntityRef,
  type ForgeEntityType,
  entityRefKey,
} from "@/lib/entity-ref";

/**
 * Hydrated entity ref returned to clients/agents. Shape is intentionally
 * narrow — UI cards + agent context bundles want a uniform pill across
 * primitives (label, sub-label, url, missing flag). Per-type extras
 * live under `meta` so a card renderer can pull, e.g., issue priority
 * without growing the union.
 */
export interface HydratedEntityRef {
  type: ForgeEntityType;
  id: string;
  /**
   * False when the source row was found in the workspace. True when
   * the row is missing, soft-deleted, or out-of-workspace — callers
   * render a dead-ref placeholder.
   */
  missing: boolean;
  /** Canonical title/name when found; falls back to `ref.label` when missing. */
  label: string;
  /** Optional sub-label: issue key, status, agent profileKey, etc. */
  subLabel?: string;
  /** Canonical workspace-relative URL to open this entity. */
  url?: string;
  /** Per-type structured details for richer card renderers. */
  meta?: Record<string, unknown>;
}

type DbClient = Prisma.TransactionClient | PrismaClient;

interface HydrationContext {
  db: DbClient;
  workspaceId: string;
  /**
   * Optional workspace slug. When provided, we generate URLs under
   * `/w/${slug}/...`. Without it, callers can still resolve via the
   * `id` and the `type`, but URL is omitted.
   */
  workspaceSlug?: string;
  /**
   * Optional calling user id. When supplied, user-scoped entity types
   * (notably `chat-thread`) filter to rows owned by this user — refs
   * to other users' threads surface as `missing: true`. Omitted in
   * agent/MCP code paths where there is no human "viewer".
   */
  userId?: string | null;
}

function workspaceUrl(slug: string | undefined, path: string): string | undefined {
  if (!slug) return undefined;
  return `/w/${slug}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Bulk-hydrate a list of refs. Refs are grouped by type for a single
 * SELECT per type; results are returned in input order. Any ref that
 * can't be found in the workspace surfaces as `missing: true` with the
 * caller-supplied `label` as best-effort display.
 *
 * Unknown types (e.g. a ref to a primitive that hasn't shipped yet)
 * are returned as missing with `subLabel = type`, never thrown — keeps
 * the hydrator forward-compatible during the agentic-OS rollout.
 */
export async function hydrateEntityRefs(
  ctx: HydrationContext,
  refs: ForgeEntityRef[],
): Promise<HydratedEntityRef[]> {
  if (refs.length === 0) return [];
  // Dedupe input by (type,id) but preserve original positions for the
  // return array.
  const byKey = new Map<string, HydratedEntityRef>();
  const order: string[] = refs.map((r) => entityRefKey(r));
  const grouped = new Map<ForgeEntityType, Set<string>>();
  const fallbackLabels = new Map<string, string | undefined>();
  for (const r of refs) {
    const key = entityRefKey(r);
    fallbackLabels.set(key, r.label);
    if (!grouped.has(r.type)) grouped.set(r.type, new Set());
    grouped.get(r.type)!.add(r.id);
  }

  await Promise.all(
    [...grouped.entries()].map(async ([type, ids]) => {
      const hydrated = await hydrateOne(ctx, type, [...ids]);
      for (const row of hydrated) {
        const key = `${row.type}:${row.id}`;
        if (!row.label) {
          row.label = fallbackLabels.get(key) ?? row.id;
        }
        byKey.set(key, row);
      }
    }),
  );

  // Fill in missing refs with the caller's fallback label.
  return order.map((key) => {
    const found = byKey.get(key);
    if (found) return found;
    const [type, id] = splitKey(key);
    return {
      type: type as ForgeEntityType,
      id,
      missing: true,
      label: fallbackLabels.get(key) ?? id,
      subLabel: type,
    };
  });
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return idx === -1 ? [key, ""] : [key.slice(0, idx), key.slice(idx + 1)];
}

async function hydrateOne(
  ctx: HydrationContext,
  type: ForgeEntityType,
  ids: string[],
): Promise<HydratedEntityRef[]> {
  const { db, workspaceId, workspaceSlug } = ctx;
  switch (type) {
    case "issue": {
      const rows = await db.issue.findMany({
        where: { workspaceId, id: { in: ids }, deletedAt: null },
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          status: { select: { name: true, category: true } },
          workspace: { select: { key: true, slug: true } },
        },
      });
      return rows.map((row) => {
        const issueKey = `${row.workspace.key}-${row.number}`;
        return {
          type: "issue" as const,
          id: row.id,
          missing: false,
          label: row.title,
          subLabel: issueKey,
          url: workspaceUrl(workspaceSlug ?? row.workspace.slug, `/i/${issueKey}`),
          meta: {
            priority: row.priority,
            statusName: row.status.name,
            statusCategory: row.status.category,
            number: row.number,
            issueKey,
          },
        };
      });
    }
    case "project": {
      const rows = await db.project.findMany({
        where: { workspaceId, id: { in: ids }, deletedAt: null },
        select: { id: true, name: true, key: true, archived: true },
      });
      return rows.map((row) => ({
        type: "project" as const,
        id: row.id,
        missing: false,
        label: row.name,
        subLabel: row.key,
        url: workspaceUrl(workspaceSlug, `/projects/${row.key}`),
        meta: { archived: row.archived },
      }));
    }
    case "initiative": {
      const rows = await db.initiative.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, name: true, slug: true, status: true },
      });
      return rows.map((row) => ({
        type: "initiative" as const,
        id: row.id,
        missing: false,
        label: row.name,
        subLabel: row.status,
        url: workspaceUrl(workspaceSlug, `/initiatives/${row.slug}`),
      }));
    }
    case "cycle": {
      const rows = await db.cycle.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, name: true, status: true, startsAt: true, endsAt: true },
      });
      return rows.map((row) => ({
        type: "cycle" as const,
        id: row.id,
        missing: false,
        label: row.name,
        subLabel: row.status,
        url: workspaceUrl(workspaceSlug, `/cycles/${row.id}`),
        meta: { startsAt: row.startsAt, endsAt: row.endsAt },
      }));
    }
    case "chat-thread": {
      const userId = ctx.userId ?? undefined;
      const rows = await db.chatThread.findMany({
        where: {
          workspaceId,
          id: { in: ids },
          // When a viewer is in context, only return threads they own.
          // Without a viewer (agent/MCP path), workspace scope is the
          // only filter — agents see threads they're addressed in
          // through the chat router's own auth checks, not here.
          ...(userId ? { userId } : {}),
        },
        select: {
          id: true,
          title: true,
          topic: true,
          lastMessageAt: true,
          agent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
            },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 3,
            select: {
              id: true,
              role: true,
              body: true,
              createdAt: true,
            },
          },
        },
      });
      return rows.map((row) => {
        const preview = [...row.messages].reverse();
        return {
          type: "chat-thread" as const,
          id: row.id,
          missing: false,
          label: row.title || row.topic || `Chat with @${row.agent.profileKey}`,
          subLabel: `@${row.agent.profileKey}`,
          url: workspaceUrl(workspaceSlug, `/chat?thread=${row.id}`),
          meta: {
            title: row.title,
            topic: row.topic,
            lastMessageAt: row.lastMessageAt,
            agent: {
              id: row.agent.id,
              name: row.agent.name,
              profileKey: row.agent.profileKey,
              avatar: row.agent.avatar,
            },
            preview: preview.map((m) => ({
              id: m.id,
              role: m.role,
              body: m.body.length > 240 ? `${m.body.slice(0, 240)}…` : m.body,
              createdAt: m.createdAt,
            })),
          },
        };
      });
    }
    case "chat-message": {
      const rows = await db.chatMessage.findMany({
        where: { workspaceId, id: { in: ids } },
        select: {
          id: true,
          body: true,
          role: true,
          threadId: true,
        },
      });
      return rows.map((row) => ({
        type: "chat-message" as const,
        id: row.id,
        missing: false,
        label: row.body.length > 80 ? `${row.body.slice(0, 80)}…` : row.body,
        subLabel: row.role.toLowerCase(),
        url: workspaceUrl(workspaceSlug, `/chat?thread=${row.threadId}&message=${row.id}`),
      }));
    }
    case "agent": {
      const rows = await db.agent.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, name: true, profileKey: true, status: true },
      });
      return rows.map((row) => ({
        type: "agent" as const,
        id: row.id,
        missing: false,
        label: row.name,
        subLabel: `@${row.profileKey}`,
        url: workspaceUrl(workspaceSlug, `/agents/${row.profileKey}`),
        meta: { status: row.status },
      }));
    }
    case "agent-run": {
      const rows = await db.agentRun.findMany({
        where: { workspaceId, id: { in: ids } },
        select: {
          id: true,
          status: true,
          currentStep: true,
          issue: { select: { number: true, title: true, workspace: { select: { key: true } } } },
        },
      });
      return rows.map((row) => ({
        type: "agent-run" as const,
        id: row.id,
        missing: false,
        label: row.currentStep || `Run on ${row.issue.workspace.key}-${row.issue.number}`,
        subLabel: row.status,
        url: workspaceUrl(
          workspaceSlug,
          `/i/${row.issue.workspace.key}-${row.issue.number}#run-${row.id}`,
        ),
      }));
    }
    case "attachment": {
      const rows = await db.attachment.findMany({
        where: { workspaceId, id: { in: ids } },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          kind: true,
          externalUrl: true,
          linkTitle: true,
        },
      });
      return rows.map((row) => ({
        type: "attachment" as const,
        id: row.id,
        missing: false,
        label: row.linkTitle || row.filename,
        subLabel: row.mimeType,
        url: row.externalUrl ?? undefined,
        meta: { kind: row.kind, mimeType: row.mimeType },
      }));
    }
    case "note": {
      const rows = await db.note.findMany({
        where: { workspaceId, id: { in: ids } },
        select: { id: true, title: true, kind: true, pinned: true, body: true },
      });
      return rows.map((row) => ({
        type: "note" as const,
        id: row.id,
        missing: false,
        label:
          row.title ||
          (row.body.length > 60 ? `${row.body.slice(0, 60)}…` : row.body || "Untitled note"),
        subLabel: row.kind.toLowerCase(),
        url: workspaceUrl(workspaceSlug, `/notes/${row.id}`),
        meta: { pinned: row.pinned, kind: row.kind },
      }));
    }
    case "comment": {
      const rows = await db.comment.findMany({
        where: { workspaceId, id: { in: ids }, deletedAt: null },
        select: {
          id: true,
          body: true,
          issue: { select: { number: true, workspace: { select: { key: true } } } },
        },
      });
      return rows.map((row) => {
        // Comment.issue is nullable post-migration 0040 (step comments
        // don't have a parent issue). Context-set hydration is
        // currently only wired for issue comments — render step
        // comments as standalone bodies if/when they appear.
        const issue = row.issue;
        return {
          type: "comment" as const,
          id: row.id,
          missing: false,
          label: row.body.length > 80 ? `${row.body.slice(0, 80)}…` : row.body,
          subLabel: issue
            ? `${issue.workspace.key}-${issue.number}`
            : "step comment",
          url: issue
            ? workspaceUrl(
                workspaceSlug,
                `/i/${issue.workspace.key}-${issue.number}#comment-${row.id}`,
              )
            : workspaceUrl(workspaceSlug, "/plans"),
        };
      });
    }
    case "artifact": {
      const rows = await db.artifact.findMany({
        where: { workspaceId, id: { in: ids }, archivedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          type: true,
          status: true,
          summary: true,
          body: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => {
        const isNote = row.type === "NOTE";
        const meta: Record<string, unknown> = {
          status: row.status,
          slug: row.slug,
          summary: row.summary,
          kind: row.type,
          updatedAt: row.updatedAt,
        };
        if (isNote) {
          // Notes carry their full body for inline canvas rendering.
          meta.body = row.body;
        }
        return {
          type: "artifact" as const,
          id: row.id,
          missing: false,
          label: row.title,
          subLabel: row.type.toLowerCase(),
          url: workspaceUrl(workspaceSlug, `/artifacts/${row.slug}`),
          meta,
        };
      });
    }
    case "context-set": {
      const rows = await db.contextSet.findMany({
        where: { workspaceId, id: { in: ids }, archivedAt: null },
        select: {
          id: true,
          name: true,
          description: true,
          _count: { select: { items: true } },
        },
      });
      return rows.map((row) => ({
        type: "context-set" as const,
        id: row.id,
        missing: false,
        label: row.name,
        subLabel: `${row._count.items} item${row._count.items === 1 ? "" : "s"}`,
        url: workspaceUrl(workspaceSlug, `/context-sets/${row.id}`),
        meta: { itemCount: row._count.items, description: row.description },
      }));
    }
    case "execution-plan": {
      const rows = await db.executionPlan.findMany({
        where: { workspaceId, id: { in: ids }, archivedAt: null },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          steps: { select: { status: true } },
        },
      });
      return rows.map((row) => {
        const stepCount = row.steps.length;
        const doneSteps = row.steps.filter((s) => s.status === "DONE").length;
        const runningSteps = row.steps.filter((s) => s.status === "RUNNING").length;
        return {
          type: "execution-plan" as const,
          id: row.id,
          missing: false,
          label: row.title,
          subLabel: `${row.status.toLowerCase()} · ${stepCount} step${stepCount === 1 ? "" : "s"}`,
          url: workspaceUrl(workspaceSlug, `/execution-plans/${row.id}`),
          meta: {
            status: row.status,
            description: row.description,
            stepCount,
            doneSteps,
            runningSteps,
            progress: stepCount === 0 ? 0 : doneSteps / stepCount,
          },
        };
      });
    }
    case "execution-step": {
      const rows = await db.executionStep.findMany({
        where: { workspaceId, id: { in: ids } },
        select: {
          id: true,
          title: true,
          status: true,
          planId: true,
          position: true,
          expectedOutput: true,
          dependsOnStepIds: true,
          assignedAgent: { select: { id: true, name: true, profileKey: true } },
          assignedUser: { select: { id: true, name: true, email: true } },
        },
      });
      return rows.map((row) => ({
        type: "execution-step" as const,
        id: row.id,
        missing: false,
        label: row.title,
        subLabel: row.status.toLowerCase(),
        url: workspaceUrl(workspaceSlug, `/execution-plans/${row.planId}#step-${row.id}`),
        meta: {
          status: row.status,
          position: row.position,
          planId: row.planId,
          expectedOutput: row.expectedOutput,
          dependsOnStepIds: row.dependsOnStepIds,
          assignedAgent: row.assignedAgent
            ? {
                id: row.assignedAgent.id,
                name: row.assignedAgent.name,
                profileKey: row.assignedAgent.profileKey,
              }
            : null,
          assignedUser: row.assignedUser
            ? {
                id: row.assignedUser.id,
                name: row.assignedUser.name,
                email: row.assignedUser.email,
              }
            : null,
        },
      }));
    }
    case "action-request": {
      const rows = await db.actionRequest.findMany({
        where: { workspaceId, id: { in: ids } },
        select: {
          id: true,
          title: true,
          status: true,
          severity: true,
          assignedUserId: true,
          assignedAgentId: true,
          dueAt: true,
        },
      });
      return rows.map((row) => ({
        type: "action-request" as const,
        id: row.id,
        missing: false,
        label: row.title,
        subLabel: `${row.status.toLowerCase()} · ${row.severity.toLowerCase()}`,
        url: workspaceUrl(workspaceSlug, `/inbox?actionRequest=${row.id}`),
        meta: {
          status: row.status,
          severity: row.severity,
          dueAt: row.dueAt,
          assignedUserId: row.assignedUserId,
          assignedAgentId: row.assignedAgentId,
        },
      }));
    }
    default: {
      const exhaustive: never = type;
      void exhaustive;
      return [];
    }
  }
}

/**
 * Convenience wrapper for a single ref. Returns `null` when the ref
 * isn't found (no dead-ref placeholder) — callers wanting placeholders
 * should use `hydrateEntityRefs` directly.
 */
export async function hydrateEntityRef(
  ctx: HydrationContext,
  ref: ForgeEntityRef,
): Promise<HydratedEntityRef | null> {
  const [row] = await hydrateEntityRefs(ctx, [ref]);
  if (!row || row.missing) return null;
  return row;
}
