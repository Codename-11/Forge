import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, RelationKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Issue relations — directed, typed links between two issues.
 *
 * Reciprocal semantics:
 *   BLOCKS      ⇄ BLOCKED_BY   (maintained on both sides)
 *   DUPLICATES  → (unidirectional)
 *   RELATES_TO  → (unidirectional)
 *
 * We keep both rows explicit rather than inferring the opposite at query
 * time so that UI filters / counts stay symmetrical without a JOIN.
 */

function reciprocalKind(kind: RelationKind): RelationKind | null {
  if (kind === RelationKind.BLOCKS) return RelationKind.BLOCKED_BY;
  if (kind === RelationKind.BLOCKED_BY) return RelationKind.BLOCKS;
  return null;
}

export const addInput = z.object({
  fromIssueId: z.string().cuid(),
  toIssueId: z.string().cuid(),
  kind: z.nativeEnum(RelationKind),
});

export const removeInput = z.object({
  relationId: z.string().cuid(),
});

export const listForIssueInput = z.object({
  issueId: z.string().cuid(),
});

export const graphForIssueInput = z.object({
  issueId: z.string().cuid(),
  /** How many hops out from the focus issue to traverse. */
  depth: z.number().int().min(1).max(3).default(2),
});

/** Hard cap so a pathological dependency web can't blow up the payload. */
const GRAPH_MAX_NODES = 60;

export const relationRouter = router({
  add: workspaceProcedure.input(addInput).mutation(async ({ ctx, input }) => {
    if (input.fromIssueId === input.toIssueId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot relate an issue to itself.",
      });
    }

    return ctx.db.$transaction(async (tx) => {
      // Both issues must live in the caller's workspace. We check both
      // explicitly because workspaceId isn't part of the IssueRelation
      // lookup path yet.
      const [from, to] = await Promise.all([
        tx.issue.findFirst({
          where: { id: input.fromIssueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        }),
        tx.issue.findFirst({
          where: { id: input.toIssueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!from || !to) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Both issues must belong to this workspace.",
        });
      }

      const existing = await tx.issueRelation.findUnique({
        where: {
          fromIssueId_toIssueId_kind: {
            fromIssueId: input.fromIssueId,
            toIssueId: input.toIssueId,
            kind: input.kind,
          },
        },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That relation already exists.",
        });
      }

      const primary = await tx.issueRelation.create({
        data: {
          workspaceId: ctx.workspaceId,
          fromIssueId: input.fromIssueId,
          toIssueId: input.toIssueId,
          kind: input.kind,
        },
      });

      const mirror = reciprocalKind(input.kind);
      let reciprocal: typeof primary | null = null;
      if (mirror) {
        // Upsert to tolerate a pre-existing mirror row from a prior ad-hoc
        // creation — keeps the invariant clean without surfacing noise.
        reciprocal = await tx.issueRelation.upsert({
          where: {
            fromIssueId_toIssueId_kind: {
              fromIssueId: input.toIssueId,
              toIssueId: input.fromIssueId,
              kind: mirror,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            fromIssueId: input.toIssueId,
            toIssueId: input.fromIssueId,
            kind: mirror,
          },
          update: {},
        });
      }

      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Issue",
        entityId: input.fromIssueId,
        action: "relation.add",
        after: primary,
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: input.fromIssueId,
        payload: {
          relationId: primary.id,
          kind: primary.kind,
          toIssueId: primary.toIssueId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { relation: primary, reciprocal };
    });
  }),

  remove: workspaceProcedure.input(removeInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const relation = await tx.issueRelation.findFirst({
        where: { id: input.relationId, workspaceId: ctx.workspaceId },
        include: {
          fromIssue: { select: { deletedAt: true } },
          toIssue: { select: { deletedAt: true } },
        },
      });
      if (!relation) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Relation not found." });
      }
      if (relation.fromIssue.deletedAt || relation.toIssue.deletedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Restore archived issues before changing their relationships.",
        });
      }

      await tx.issueRelation.delete({ where: { id: relation.id } });

      const mirror = reciprocalKind(relation.kind);
      if (mirror) {
        await tx.issueRelation.deleteMany({
          where: {
            workspaceId: ctx.workspaceId,
            fromIssueId: relation.toIssueId,
            toIssueId: relation.fromIssueId,
            kind: mirror,
          },
        });
      }

      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Issue",
        entityId: relation.fromIssueId,
        action: "relation.remove",
        before: relation,
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: relation.fromIssueId,
        payload: {
          relationId: relation.id,
          kind: relation.kind,
          toIssueId: relation.toIssueId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { ok: true };
    });
  }),

  listForIssue: workspaceProcedure.input(listForIssueInput).query(async ({ ctx, input }) => {
    // Confirm scope before we read relation rows (which don't filter by
    // workspaceId in their unique index).
    const issue = await ctx.db.issue.findFirst({
      where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!issue) throw new TRPCError({ code: "NOT_FOUND" });

    // We only look at outgoing edges. BLOCKS/BLOCKED_BY already have a
    // mirror row on the other side (written in `add`), so every
    // reciprocal relationship is visible as an outgoing edge on *some*
    // issue — which avoids double-counting here.
    const rows = await ctx.db.issueRelation.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        fromIssueId: input.issueId,
        toIssue: { deletedAt: null },
      },
      include: {
        toIssue: {
          select: {
            id: true,
            number: true,
            title: true,
            statusId: true,
            status: { select: { category: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const grouped: Record<
      RelationKind,
      Array<{
        relationId: string;
        kind: RelationKind;
        target: {
          id: string;
          number: number;
          title: string;
          statusId: string;
          statusCategory: string;
        };
      }>
    > = {
      [RelationKind.BLOCKS]: [],
      [RelationKind.BLOCKED_BY]: [],
      [RelationKind.DUPLICATES]: [],
      [RelationKind.RELATES_TO]: [],
    };

    for (const row of rows) {
      grouped[row.kind].push({
        relationId: row.id,
        kind: row.kind,
        target: {
          id: row.toIssue.id,
          number: row.toIssue.number,
          title: row.toIssue.title,
          statusId: row.toIssue.statusId,
          statusCategory: row.toIssue.status.category,
        },
      });
    }

    return grouped;
  }),

  /**
   * Dependency graph centered on one issue, for the Relations tab's DAG
   * view. BFS out `depth` hops over two edge dimensions:
   *
   *   - **blocks** — directed `blocker → blocked`. We read only `BLOCKS`
   *     rows (every blocking pair has one, mirrored to `BLOCKED_BY` in
   *     `add`) so each dependency appears exactly once, in its true
   *     direction, regardless of which side we started from.
   *   - **child** — directed `parent → child` via `Issue.parentId`,
   *     surfacing the sub-issue hierarchy alongside dependencies.
   *   - **plan-dependency** — derived from
   *     `ExecutionStep.dependsOnStepIds` when both steps have materialized
   *     issues. These edges are intentionally not copied into
   *     `IssueRelation`; the plan DAG remains the single source of truth.
   *
   * Returns flat `nodes` (with `isCurrent` flagging the focus issue) and
   * directed `edges`; the client lays them out. Node count is capped at
   * `GRAPH_MAX_NODES` — once hit, expansion stops and any dangling edges
   * to undiscovered nodes are dropped so the graph stays consistent.
   */
  graphForIssue: workspaceProcedure.input(graphForIssueInput).query(async ({ ctx, input }) => {
    const root = await ctx.db.issue.findFirst({
      where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!root) throw new TRPCError({ code: "NOT_FOUND" });

    type Edge = {
      id: string;
      from: string;
      to: string;
      kind: "blocks" | "child" | "plan-dependency";
    };
    const nodeIds = new Set<string>([root.id]);
    const edges = new Map<string, Edge>();
    const addEdge = (from: string, to: string, kind: Edge["kind"]) => {
      const id = `${from}->${to}:${kind}`;
      if (!edges.has(id)) edges.set(id, { id, from, to, kind });
    };

    let frontier = [root.id];
    for (let hop = 0; hop < input.depth && frontier.length > 0; hop++) {
      if (nodeIds.size >= GRAPH_MAX_NODES) break;
      const discovered = new Set<string>();
      const note = (id: string) => {
        if (!nodeIds.has(id)) discovered.add(id);
      };

      const [blocks, frontierIssues, children, frontierSteps] = await Promise.all([
        // Blocking edges touching the frontier, in either direction.
        ctx.db.issueRelation.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            kind: RelationKind.BLOCKS,
            OR: [{ fromIssueId: { in: frontier } }, { toIssueId: { in: frontier } }],
          },
          select: { fromIssueId: true, toIssueId: true },
        }),
        // The frontier issues' own parents (child → up to parent).
        ctx.db.issue.findMany({
          where: { id: { in: frontier }, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true, parentId: true },
        }),
        // The frontier issues' children (parent → down to child).
        ctx.db.issue.findMany({
          where: { parentId: { in: frontier }, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true, parentId: true },
        }),
        // A frontier issue can be the materialized form of a plan step.
        // Fetch the step identity first; its plan scopes the derived DAG
        // lookup below and prevents cross-workspace/cross-plan edges.
        ctx.db.executionStep.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            issueId: { in: frontier },
          },
          select: { id: true, issueId: true, planId: true },
        }),
      ]);

      for (const r of blocks) {
        addEdge(r.fromIssueId, r.toIssueId, "blocks");
        note(r.fromIssueId);
        note(r.toIssueId);
      }
      for (const i of frontierIssues) {
        if (i.parentId) {
          addEdge(i.parentId, i.id, "child");
          note(i.parentId);
        }
      }
      for (const c of children) {
        if (c.parentId) {
          addEdge(c.parentId, c.id, "child");
          note(c.id);
        }
      }

      const planIds = [...new Set(frontierSteps.map((step) => step.planId))];
      if (planIds.length > 0) {
        const planSteps = await ctx.db.executionStep.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            planId: { in: planIds },
            issueId: { not: null },
            issue: { is: { deletedAt: null } },
          },
          select: { id: true, issueId: true, dependsOnStepIds: true },
        });
        const byStepId = new Map(planSteps.map((step) => [step.id, step]));
        const frontierIssueIds = new Set(frontier);

        for (const dependent of planSteps) {
          if (!dependent.issueId) continue;
          for (const dependencyStepId of dependent.dependsOnStepIds) {
            const dependency = byStepId.get(dependencyStepId);
            if (!dependency?.issueId || dependency.issueId === dependent.issueId) continue;
            // At this hop, only add edges that touch the frontier. Other
            // edges will be discovered when their node enters the next
            // frontier, preserving the requested depth semantics.
            if (
              !frontierIssueIds.has(dependency.issueId) &&
              !frontierIssueIds.has(dependent.issueId)
            ) {
              continue;
            }
            addEdge(dependency.issueId, dependent.issueId, "plan-dependency");
            note(dependency.issueId);
            note(dependent.issueId);
          }
        }
      }

      // Admit newly discovered nodes up to the cap; they seed next hop.
      const next: string[] = [];
      for (const id of discovered) {
        if (nodeIds.size >= GRAPH_MAX_NODES) break;
        nodeIds.add(id);
        next.push(id);
      }
      frontier = next;
    }

    const issues = await ctx.db.issue.findMany({
      where: { id: { in: [...nodeIds] }, workspaceId: ctx.workspaceId, deletedAt: null },
      select: {
        id: true,
        number: true,
        title: true,
        priority: true,
        status: { select: { category: true, color: true } },
      },
    });

    const nodes = issues.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title,
      priority: i.priority,
      statusCategory: i.status.category,
      statusColor: i.status.color,
      isCurrent: i.id === root.id,
    }));

    // Drop edges to nodes we never materialized (cap-truncated frontier).
    const present = new Set(nodes.map((n) => n.id));
    const edgeList = [...edges.values()].filter((e) => present.has(e.from) && present.has(e.to));

    return { nodes, edges: edgeList, truncated: nodeIds.size >= GRAPH_MAX_NODES };
  }),
});
