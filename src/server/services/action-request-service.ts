import "server-only";
import type { PrismaClient } from "@prisma/client";
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentRunStatus,
  EngagementMode,
  EventKind,
  NotificationSeverity,
  Prisma,
  RelationKind,
  Role,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  RUNTIME_TOOL_CAPABILITIES,
  runtimeSupportsRuntimeToolGrants,
  runtimeToolSurface,
  type RuntimeToolCapability,
} from "@/lib/runtime-tools";
import { buildRuntimePolicySnapshot } from "@/lib/runtime-enforcement";
import { recordChange } from "@/server/audit";
import { openOrTouchRun, appendRunEvent } from "@/server/services/agent-run";
import { resolveRunEngineWithSource } from "@/server/services/dispatch/registry";
import { FORGE_RUN_CONTRACT_VERSION } from "@/server/services/engagement-mode";
import { archiveIssue } from "@/server/services/issue-archive";
import { agentIdSchema } from "@/server/validators";

/**
 * Per-kind payload schemas. The MCP + tRPC entry points strip any
 * unrecognized keys (Zod's default) so callers can't sneak extra
 * state through `payload`. Each shape's referenced ids are
 * cross-tenant-validated inside `createActionRequest` before persist.
 */
const completionEvidencePayload = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(500),
  tone: z.enum(["SUCCESS", "WARNING", "NEUTRAL"]).optional(),
});
const completionFactPayload = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  status: z.enum(["PASS", "FAIL", "VERIFYING", "UNAVAILABLE", "STALE"]),
  detail: z.string().trim().max(2_000).optional(),
  observedAt: z.string().datetime().optional(),
  nextRetryAt: z.string().datetime().optional(),
  diagnostic: z.string().trim().max(2_000).optional(),
  href: z.string().url().max(2_000).optional(),
});
const completionAssessmentPayload = z.object({
  version: z.literal(1),
  state: z.enum(["READY", "BLOCKED", "VERIFYING", "UNAVAILABLE", "STALE"]),
  evaluatedAt: z.string().datetime(),
  facts: z.array(completionFactPayload).max(24),
});
const transitionPayload = z.object({
  statusId: z.string().cuid(),
  intent: z.enum(["COMPLETE", "RECOVER"]).optional(),
  sourceLabel: z.string().trim().max(300).optional(),
  sourceUrl: z.string().url().max(2_000).optional(),
  assessment: completionAssessmentPayload.optional(),
  sourceEvidence: z.array(completionEvidencePayload).max(12).optional(),
  evidence: z.array(completionEvidencePayload).max(12).optional(),
  autoHeldReasons: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
});
const setLabelsPayload = z.object({
  add: z.array(z.string().cuid()).max(50).default([]),
  remove: z.array(z.string().cuid()).max(50).default([]),
});
const assignPayload = z.object({
  userIds: z.array(z.string().cuid()).max(50),
});
const assignAgentPayload = z.object({
  agentId: agentIdSchema,
});
const archivePayload = z.object({}).default({});
const closeAsDuplicatePayload = z.object({
  duplicateOfIssueId: z.string().cuid(),
  /** Optional: status to flip the source issue to (typically CANCELED). */
  statusId: z.string().cuid().optional(),
});
const runtimeToolGrantPayload = z.object({
  agentId: agentIdSchema,
  mode: z.nativeEnum(EngagementMode).default(EngagementMode.REVIEW),
  tools: z.array(z.enum(RUNTIME_TOOL_CAPABILITIES)).min(1).max(RUNTIME_TOOL_CAPABILITIES.length),
  accessLevel: z.enum(["READ_ONLY", "FULL"]).default("READ_ONLY"),
  scopePath: z.string().trim().min(1).max(500),
  reason: z.string().trim().max(2_000).optional(),
});

export const actionRequestPayloadSchemas = {
  TRANSITION: transitionPayload,
  SET_LABELS: setLabelsPayload,
  ASSIGN: assignPayload,
  ASSIGN_AGENT: assignAgentPayload,
  ARCHIVE: archivePayload,
  CLOSE_AS_DUPLICATE: closeAsDuplicatePayload,
  RUNTIME_TOOL_GRANT: runtimeToolGrantPayload,
} as const;

export type ActionRequestPayloadMap = {
  TRANSITION: z.infer<typeof transitionPayload>;
  SET_LABELS: z.infer<typeof setLabelsPayload>;
  ASSIGN: z.infer<typeof assignPayload>;
  ASSIGN_AGENT: z.infer<typeof assignAgentPayload>;
  ARCHIVE: z.infer<typeof archivePayload>;
  CLOSE_AS_DUPLICATE: z.infer<typeof closeAsDuplicatePayload>;
  RUNTIME_TOOL_GRANT: z.infer<typeof runtimeToolGrantPayload>;
};

/**
 * Parse a payload against the schema for a given kind. Throws a
 * `BAD_REQUEST` TRPCError with the Zod failure path on mismatch so
 * callers get a usable error message instead of a stack trace.
 */
export function parseActionRequestPayload<K extends ActionRequestKind>(
  kind: K,
  raw: unknown,
): K extends "FREE_FORM" ? null : ActionRequestPayloadMap[Exclude<K, "FREE_FORM">] {
  if (kind === ActionRequestKind.FREE_FORM) {
    // Free-form requests never carry a payload — silently drop any
    // accidental input so callers can pass through a single shape.
    return null as never;
  }
  const schema = actionRequestPayloadSchemas[kind as Exclude<K, "FREE_FORM">];
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid payload for ActionRequest kind=${kind}: ${parsed.error.message}`,
    });
  }
  return parsed.data as never;
}

export interface CreateActionRequestInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity;
  kind?: ActionRequestKind;
  payload?: unknown;
  /**
   * Optional poll options. When provided, the renderer treats this
   * request as a poll — operators vote via ActionRequestVote and the
   * requester closes voting to surface the winning option. Each entry
   * carries `key` (stable id used by every vote row), `label`
   * (rendered to humans), and optional `description`.
   */
  options?: ActionRequestPollOption[] | null;
  assignedUserId?: string | null;
  assignedAgentId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  dedupeKey?: string | null;
  issueId?: string | null;
  dueAt?: Date | null;
}

export interface ActionRequestPollOption {
  key: string;
  label: string;
  description?: string;
}

/**
 * Per-row validation of the `options` array — keeps the JSON shape
 * sane (no duplicate keys, capped count) so downstream readers can
 * trust what's in the column.
 */
export const actionRequestPollOptionsSchema = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2_000).optional(),
    }),
  )
  .min(2)
  .max(8)
  .refine((rows) => new Set(rows.map((r) => r.key)).size === rows.length, {
    message: "ActionRequest.options keys must be unique.",
  });

/**
 * Read the `options` JSON off an ActionRequest row and return a
 * typed array, or null if voting is not enabled. Defensive — the
 * row may have been created before this migration, in which case
 * `options` is null.
 */
export function readPollOptions(raw: Prisma.JsonValue | null): ActionRequestPollOption[] | null {
  if (raw === null || raw === undefined) return null;
  const parsed = actionRequestPollOptionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate that every entity referenced by a kind-specific payload
 * lives in the calling workspace. Runs *before* the create transaction
 * so a bad payload errors cleanly without a half-written row.
 */
async function validatePayloadWorkspaceScope(
  db: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  kind: ActionRequestKind,
  payload: unknown,
  issueId: string | null,
): Promise<void> {
  if (kind === ActionRequestKind.FREE_FORM) return;
  // All executable kinds target a specific issue, so the row must
  // carry one. Reject the create rather than silently strand the
  // request with no Accept target.
  if (!issueId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `ActionRequest kind=${kind} requires issueId to be set.`,
    });
  }
  if (kind === ActionRequestKind.ARCHIVE) return;

  if (kind === ActionRequestKind.TRANSITION) {
    const p = payload as ActionRequestPayloadMap["TRANSITION"];
    const ok = await db.status.findFirst({
      where: { id: p.statusId, workspaceId },
      select: { id: true },
    });
    if (!ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "TRANSITION.statusId does not belong to this workspace.",
      });
    }
    return;
  }

  if (kind === ActionRequestKind.SET_LABELS) {
    const p = payload as ActionRequestPayloadMap["SET_LABELS"];
    const ids = Array.from(new Set([...(p.add ?? []), ...(p.remove ?? [])]));
    if (ids.length === 0) return;
    const found = await db.label.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "SET_LABELS payload references labels outside this workspace.",
      });
    }
    return;
  }

  if (kind === ActionRequestKind.ASSIGN) {
    const p = payload as ActionRequestPayloadMap["ASSIGN"];
    if (p.userIds.length === 0) return;
    const memberships = await db.membership.findMany({
      where: { workspaceId, userId: { in: p.userIds } },
      select: { userId: true },
    });
    if (memberships.length !== p.userIds.length) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ASSIGN payload references users outside this workspace's members.",
      });
    }
    return;
  }

  if (kind === ActionRequestKind.ASSIGN_AGENT) {
    const p = payload as ActionRequestPayloadMap["ASSIGN_AGENT"];
    const ok = await db.agent.findFirst({
      where: { id: p.agentId, workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!ok) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "ASSIGN_AGENT.agentId does not belong to this workspace.",
      });
    }
    return;
  }

  if (kind === ActionRequestKind.RUNTIME_TOOL_GRANT) {
    const p = payload as ActionRequestPayloadMap["RUNTIME_TOOL_GRANT"];
    const agent = await db.agent.findFirst({
      where: { id: p.agentId, workspaceId, archivedAt: null },
      select: {
        id: true,
        runtime: {
          select: { id: true, adapterKey: true, config: true, disabledAt: true },
        },
      },
    });
    if (!agent) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "RUNTIME_TOOL_GRANT.agentId does not belong to this workspace.",
      });
    }
    if (!agent.runtime) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "RUNTIME_TOOL_GRANT requires an agent attached to a managed runtime.",
      });
    }
    if (!runtimeSupportsRuntimeToolGrants(agent.runtime.adapterKey)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Runtime tool grants are not supported for this runtime adapter.",
      });
    }
    if (agent.runtime.disabledAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Target runtime is disabled.",
      });
    }
    const surface = runtimeToolSurface(agent.runtime.adapterKey, agent.runtime.config);
    const declared = new Set(surface.capabilities);
    const missing = p.tools.filter((tool) => !declared.has(tool));
    if (missing.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Runtime does not declare requested tool access: ${missing.join(", ")}.`,
      });
    }
    return;
  }

  if (kind === ActionRequestKind.CLOSE_AS_DUPLICATE) {
    const p = payload as ActionRequestPayloadMap["CLOSE_AS_DUPLICATE"];
    const dup = await db.issue.findFirst({
      where: {
        id: p.duplicateOfIssueId,
        workspaceId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!dup) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "CLOSE_AS_DUPLICATE.duplicateOfIssueId does not belong to this workspace.",
      });
    }
    if (p.statusId) {
      const status = await db.status.findFirst({
        where: { id: p.statusId, workspaceId },
        select: { id: true },
      });
      if (!status) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "CLOSE_AS_DUPLICATE.statusId does not belong to this workspace.",
        });
      }
    }
    return;
  }
}

/**
 * Create an ActionRequest and emit an audit/activity event. Either
 * `assignedUserId` or `assignedAgentId` is recommended; the request
 * shows up on the inbox of whoever is targeted.
 */
/**
 * True when an error is a unique-violation on the OPEN-request dedup index
 * (added 2026-06-23, migration 0088). ActionRequest carries no other unique
 * constraint a create/transition can hit, so a P2002 here is always the
 * scoped-dedup race between two concurrent writers.
 */
function isOpenDedupConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value ?? null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export async function createActionRequest(
  db: PrismaClient,
  input: CreateActionRequestInput,
): Promise<{ id: string }> {
  if (input.issueId) {
    const found = await db.issue.findFirst({
      where: { id: input.issueId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!found) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
    }
  }
  const kind = input.kind ?? ActionRequestKind.FREE_FORM;
  const parsedPayload = parseActionRequestPayload(kind, input.payload);
  await validatePayloadWorkspaceScope(
    db,
    input.workspaceId,
    kind,
    parsedPayload,
    input.issueId ?? null,
  );
  // Validate poll options (when provided) before opening the transaction.
  // A poll only makes sense on FREE_FORM today — the executable kinds
  // already carry a single dispatch target, so multi-vote semantics
  // don't apply. We accept polls regardless of kind to keep the column
  // forward-compatible, but reject malformed shapes early.
  let parsedOptions: ActionRequestPollOption[] | null = null;
  if (input.options && input.options.length > 0) {
    const parsed = actionRequestPollOptionsSchema.safeParse(input.options);
    if (!parsed.success) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Invalid ActionRequest.options: ${parsed.error.message}`,
      });
    }
    parsedOptions = parsed.data;
  }
  // Dedup key (added 2026-06-23): at most one OPEN request per
  // (workspace, issue, kind, requesting-agent, scopePath). A re-ask or an
  // escalation (e.g. read-only → full grant on the same path) SUPERSEDES the
  // prior open request instead of stacking a second card — the AXI-26
  // duplicate-grant pathology. Dedup is scoped to requests that actually
  // carry a `scopePath` (runtime-tool grants today) so that two *distinct*
  // FREE_FORM asks from the same agent on one issue never collapse into each
  // other. Mirrors the partial-unique index, which only covers scopePath rows.
  const requesterAgentId = input.actorAgentId ?? null;
  const genericDedupeKey = input.dedupeKey?.trim() || null;
  const dedupScopePath =
    parsedPayload && typeof parsedPayload === "object" && "scopePath" in parsedPayload
      ? String((parsedPayload as { scopePath?: unknown }).scopePath ?? "") || null
      : null;
  const legacyDedupable = Boolean(input.issueId && requesterAgentId && dedupScopePath !== null);
  const dedupable = Boolean(genericDedupeKey || legacyDedupable);

  const createOnce = () =>
    db.$transaction(async (tx) => {
      let supersededId: string | null = null;
      if (dedupable) {
        const match = genericDedupeKey
          ? await tx.actionRequest.findFirst({
              where: {
                workspaceId: input.workspaceId,
                dedupeKey: genericDedupeKey,
                status: ActionRequestStatus.OPEN,
              },
              select: { id: true },
            })
          : (
              await tx.actionRequest.findMany({
                where: {
                  workspaceId: input.workspaceId,
                  issueId: input.issueId!,
                  kind,
                  requestedByAgentId: requesterAgentId!,
                  status: ActionRequestStatus.OPEN,
                },
                select: { id: true, payload: true },
              })
            ).find((row) => {
              const ps =
                row.payload && typeof row.payload === "object" && "scopePath" in row.payload
                  ? String((row.payload as { scopePath?: unknown }).scopePath ?? "")
                  : "";
              return ps === (dedupScopePath ?? "");
            });
        if (genericDedupeKey && match) {
          const existing = await tx.actionRequest.findUniqueOrThrow({
            where: { id: match.id },
          });
          const nextPayload =
            parsedPayload === null ? null : (parsedPayload as Prisma.InputJsonValue);
          const nextOptions =
            parsedOptions === null ? null : (parsedOptions as unknown as Prisma.InputJsonValue);
          const unchanged =
            existing.title === input.title.trim() &&
            existing.body === (input.body ?? null) &&
            existing.severity === (input.severity ?? NotificationSeverity.INFO) &&
            existing.kind === kind &&
            sameJson(existing.payload, nextPayload) &&
            sameJson(existing.options, nextOptions) &&
            existing.requestedByUserId === (input.actorAgentId ? null : input.actorId) &&
            existing.requestedByAgentId === (input.actorAgentId ?? null) &&
            existing.assignedUserId === (input.assignedUserId ?? null) &&
            existing.assignedAgentId === (input.assignedAgentId ?? null) &&
            existing.sourceType === (input.sourceType ?? null) &&
            existing.sourceId === (input.sourceId ?? null) &&
            existing.issueId === (input.issueId ?? null) &&
            existing.dueAt?.getTime() === input.dueAt?.getTime();
          if (unchanged) return { id: existing.id };

          const refreshed = await tx.actionRequest.update({
            where: { id: match.id },
            data: {
              title: input.title.trim(),
              body: input.body ?? null,
              severity: input.severity ?? NotificationSeverity.INFO,
              kind,
              payload:
                parsedPayload === null ? Prisma.JsonNull : (parsedPayload as Prisma.InputJsonValue),
              options:
                parsedOptions === null
                  ? Prisma.JsonNull
                  : (parsedOptions as unknown as Prisma.InputJsonValue),
              requestedByUserId: input.actorAgentId ? null : input.actorId,
              requestedByAgentId: input.actorAgentId ?? null,
              assignedUserId: input.assignedUserId ?? null,
              assignedAgentId: input.assignedAgentId ?? null,
              sourceType: input.sourceType ?? null,
              sourceId: input.sourceId ?? null,
              issueId: input.issueId ?? null,
              dueAt: input.dueAt ?? null,
            },
          });
          await recordChange(tx, {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorAgentId: input.actorAgentId ?? null,
            entity: "action-request",
            entityId: refreshed.id,
            action: "refreshed",
            after: { title: refreshed.title, severity: refreshed.severity, kind: refreshed.kind },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "action-request",
            subjectId: refreshed.id,
            payload: {
              title: refreshed.title,
              severity: refreshed.severity,
              kind: refreshed.kind,
              sourceType: refreshed.sourceType,
              sourceId: refreshed.sourceId,
              issueId: refreshed.issueId,
              dedupeKey: refreshed.dedupeKey,
              refreshed: true,
            } as Prisma.InputJsonValue,
          });
          return { id: refreshed.id };
        }
        if (match) {
          // Supersede FIRST: flip the prior row out of OPEN so it leaves the
          // partial-unique index before the replacement is inserted.
          // `supersededById` is backfilled once the new row id exists.
          await tx.actionRequest.update({
            where: { id: match.id },
            data: {
              status: ActionRequestStatus.SUPERSEDED,
              resolvedAt: new Date(),
              resolution: "Superseded by a newer request on the same issue.",
            },
          });
          supersededId = match.id;
        }
      }

      const row = await tx.actionRequest.create({
        data: {
          workspaceId: input.workspaceId,
          title: input.title.trim(),
          body: input.body ?? null,
          severity: input.severity ?? NotificationSeverity.INFO,
          kind,
          payload:
            parsedPayload === null ? Prisma.JsonNull : (parsedPayload as Prisma.InputJsonValue),
          options:
            parsedOptions === null
              ? Prisma.JsonNull
              : (parsedOptions as unknown as Prisma.InputJsonValue),
          requestedByUserId: input.actorAgentId ? null : input.actorId,
          requestedByAgentId: input.actorAgentId ?? null,
          assignedUserId: input.assignedUserId ?? null,
          assignedAgentId: input.assignedAgentId ?? null,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          dedupeKey: genericDedupeKey,
          issueId: input.issueId ?? null,
          dueAt: input.dueAt ?? null,
        },
      });

      if (supersededId) {
        await tx.actionRequest.update({
          where: { id: supersededId },
          data: { supersededById: row.id },
        });
      }

      await recordChange(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorAgentId: input.actorAgentId ?? null,
        entity: "action-request",
        entityId: row.id,
        action: "created",
        after: { title: row.title, severity: row.severity, kind: row.kind },
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "action-request",
        subjectId: row.id,
        payload: {
          title: row.title,
          severity: row.severity,
          kind: row.kind,
          assignedUserId: row.assignedUserId,
          assignedAgentId: row.assignedAgentId,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          dedupeKey: row.dedupeKey,
          issueId: row.issueId,
          supersededId,
        } as Prisma.InputJsonValue,
      });
      return { id: row.id };
    });

  try {
    return await createOnce();
  } catch (err) {
    // A concurrent create for the same scoped dedup key can race the partial
    // unique index. Retry once: the supersede-first lookup now sees the
    // committed sibling and supersedes it before inserting.
    if (isOpenDedupConflict(err)) return await createOnce();
    throw err;
  }
}

/** Resolve / dismiss / snooze an action request. */
export async function transitionActionRequest(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    requestId: string;
    status: ActionRequestStatus;
    resolution?: string | null;
  },
): Promise<void> {
  const row = await db.actionRequest.findFirst({
    where: { id: params.requestId, workspaceId: params.workspaceId },
    select: { id: true, status: true, title: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
  }
  const apply = async (tx: Prisma.TransactionClient) => {
    try {
      await tx.actionRequest.update({
        where: { id: row.id },
        data: {
          status: params.status,
          resolvedAt: params.status === ActionRequestStatus.OPEN ? null : new Date(),
          resolvedByUserId: params.status === ActionRequestStatus.OPEN ? null : params.actorId,
          resolution: params.resolution ?? undefined,
        },
      });
    } catch (err) {
      // Re-opening a scoped (grant) request can collide with another OPEN
      // request for the same dedup key against the partial unique index.
      // Surface a clean conflict rather than a raw Prisma error.
      if (isOpenDedupConflict(err)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Another open request already exists for this issue and scope. Resolve it before re-opening this one.",
        });
      }
      throw err;
    }
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "action-request",
      entityId: row.id,
      action: "transition",
      before: { status: row.status },
      after: { status: params.status },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: row.id,
    });
  };
  if ("$transaction" in db) {
    await db.$transaction(apply);
  } else {
    await apply(db);
  }
}

/**
 * Permission gate for Accept/Decline. The operator may resolve if any
 * of the following hold:
 *   - they are the assigned user
 *   - they are a watcher on the request's issue
 *   - their workspace role is OWNER or ADMIN
 * Returns silently on success; throws FORBIDDEN otherwise.
 */
export async function assertCanResolveActionRequest(
  db: PrismaClient | Prisma.TransactionClient,
  params: {
    workspaceId: string;
    userId: string;
    request: {
      id: string;
      assignedUserId: string | null;
      issueId: string | null;
    };
  },
): Promise<void> {
  const { workspaceId, userId, request } = params;
  if (request.assignedUserId && request.assignedUserId === userId) return;
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (membership && (membership.role === Role.OWNER || membership.role === Role.ADMIN)) {
    return;
  }
  if (request.issueId) {
    const watcher = await db.issueWatcher.findFirst({
      where: { issueId: request.issueId, userId },
      select: { id: true },
    });
    if (watcher) return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "You don't have permission to resolve this action request. Must be the assignee, a watcher on the issue, or a workspace admin.",
  });
}

/**
 * Dispatch the action attached to a kind=… request. Called by Accept
 * after the permission gate passes. Each kind is a small Prisma +
 * recordChange block inline (not a tRPC re-entry — keep all writes in
 * the same transaction as the action-request flip).
 */
async function dispatchActionRequestKind(
  tx: Prisma.TransactionClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    request: {
      id: string;
      kind: ActionRequestKind;
      payload: Prisma.JsonValue | null;
      issueId: string | null;
    };
  },
): Promise<void> {
  const { workspaceId, actorId, request } = params;
  const kind = request.kind;
  if (kind === ActionRequestKind.FREE_FORM) return;
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  if (!request.issueId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `ActionRequest kind=${kind} cannot dispatch without an issueId.`,
    });
  }
  const issueId = request.issueId;

  // Re-verify the issue belongs to the workspace and isn't soft-deleted
  // before we touch it. Cheap check, prevents acting on a row that
  // moved tenants or was archived after the request was created.
  const issue = await tx.issue.findFirst({
    where: { id: issueId, workspaceId, deletedAt: null },
    select: { id: true, statusId: true },
  });
  if (!issue) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Target issue is no longer available (deleted or moved).",
    });
  }

  if (kind === ActionRequestKind.TRANSITION) {
    const p = parseActionRequestPayload(ActionRequestKind.TRANSITION, payload);
    const next = await tx.status.findFirst({
      where: { id: p.statusId, workspaceId },
    });
    if (!next) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "TRANSITION target status no longer exists.",
      });
    }
    const before = await tx.issue.findUniqueOrThrow({
      where: { id: issueId },
      include: { status: true },
    });
    const extra: {
      startedAt?: Date;
      completedAt?: Date | null;
      canceledAt?: Date | null;
    } = {};
    if (next.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
    if (next.category === "DONE") extra.completedAt = new Date();
    if (next.category === "CANCELED") extra.canceledAt = new Date();
    if (next.category !== "DONE") extra.completedAt = null;
    if (next.category !== "CANCELED") extra.canceledAt = null;
    await tx.issue.update({
      where: { id: issueId },
      data: { statusId: p.statusId, ...extra },
    });
    const after = await tx.issue.findUniqueOrThrow({
      where: { id: issueId },
      include: { status: true },
    });
    await recordChange(tx, {
      workspaceId,
      actorId,
      entity: "Issue",
      entityId: issueId,
      action: "update",
      before,
      after,
      eventKind: EventKind.ISSUE_STATUS_CHANGED,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        statusId: p.statusId,
        via: "action-request",
        actionRequestId: request.id,
        ...(p.intent === "COMPLETE"
          ? {
              completionAssessment: p.assessment ?? null,
              completionOverride: p.assessment?.state !== "READY",
            }
          : {}),
      },
    });
    return;
  }

  if (kind === ActionRequestKind.SET_LABELS) {
    const p = parseActionRequestPayload(ActionRequestKind.SET_LABELS, payload);
    let added = 0;
    let removed = 0;
    if (p.remove.length > 0) {
      const res = await tx.issueLabel.deleteMany({
        where: { issueId, labelId: { in: p.remove } },
      });
      removed = res.count;
    }
    if (p.add.length > 0) {
      const res = await tx.issueLabel.createMany({
        data: p.add.map((labelId) => ({ issueId, labelId })),
        skipDuplicates: true,
      });
      added = res.count;
    }
    if (added > 0 || removed > 0) {
      await recordChange(tx, {
        workspaceId,
        actorId,
        entity: "Issue",
        entityId: issueId,
        action: "set-labels",
        after: { add: p.add, remove: p.remove },
        eventKind: EventKind.ISSUE_UPDATED,
        subjectType: "issue",
        subjectId: issueId,
        payload: {
          add: p.add,
          remove: p.remove,
          via: "action-request",
          actionRequestId: request.id,
        },
      });
    }
    return;
  }

  if (kind === ActionRequestKind.ASSIGN) {
    const p = parseActionRequestPayload(ActionRequestKind.ASSIGN, payload);
    await tx.issueAssignee.deleteMany({ where: { issueId } });
    if (p.userIds.length > 0) {
      await tx.issueAssignee.createMany({
        data: p.userIds.map((userId) => ({ issueId, userId })),
        skipDuplicates: true,
      });
    }
    await recordChange(tx, {
      workspaceId,
      actorId,
      entity: "Issue",
      entityId: issueId,
      action: "assign",
      after: { assigneeIds: p.userIds },
      eventKind: EventKind.ISSUE_ASSIGNED,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        assigneeIds: p.userIds,
        via: "action-request",
        actionRequestId: request.id,
      },
    });
    return;
  }

  if (kind === ActionRequestKind.ASSIGN_AGENT) {
    const p = parseActionRequestPayload(ActionRequestKind.ASSIGN_AGENT, payload);
    await tx.issue.update({
      where: { id: issueId },
      data: { assignedAgentId: p.agentId },
    });
    await recordChange(tx, {
      workspaceId,
      actorId,
      entity: "Issue",
      entityId: issueId,
      action: "assign-agent",
      after: { assignedAgentId: p.agentId },
      eventKind: EventKind.ISSUE_ASSIGNED,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        assignedAgentId: p.agentId,
        via: "action-request",
        actionRequestId: request.id,
      },
    });
    return;
  }

  if (kind === ActionRequestKind.RUNTIME_TOOL_GRANT) {
    const p = parseActionRequestPayload(ActionRequestKind.RUNTIME_TOOL_GRANT, payload);
    const agent = await tx.agent.findFirst({
      where: { id: p.agentId, workspaceId, archivedAt: null },
      select: {
        id: true,
        name: true,
        provider: true,
        runEngine: true,
        runtime: {
          select: {
            name: true,
            adapterKey: true,
            config: true,
            disabledAt: true,
            endpoint: true,
            secret: true,
          },
        },
      },
    });
    if (!agent?.runtime) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Target agent no longer has an attached runtime.",
      });
    }
    if (agent.runtime.disabledAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Target runtime is disabled.",
      });
    }
    if (!runtimeSupportsRuntimeToolGrants(agent.runtime.adapterKey)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Runtime tool grants are not supported for this runtime adapter.",
      });
    }
    const surface = runtimeToolSurface(agent.runtime.adapterKey, agent.runtime.config);
    const declared = new Set(surface.capabilities);
    const missing = p.tools.filter((tool) => !declared.has(tool));
    if (missing.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Runtime does not declare requested tool access: ${missing.join(", ")}.`,
      });
    }

    const runtimePolicy = buildRuntimePolicySnapshot({
      contractVersion: FORGE_RUN_CONTRACT_VERSION,
      engagementMode: p.mode,
      adapterKey: agent.runtime.adapterKey ?? (agent.provider === "HERMES" ? "hermes" : null),
      runtimeName: agent.runtime.name,
      config: agent.runtime.config,
      toolGrant: {
        tools: p.tools as RuntimeToolCapability[],
        accessLevel: p.accessLevel,
        scopePath: p.scopePath,
        approvedByUserId: actorId,
        actionRequestId: request.id,
        reason: p.reason ?? null,
      },
    });

    const now = new Date();
    const superseded = await tx.agentRun.findMany({
      where: {
        workspaceId,
        issueId,
        agentId: p.agentId,
        status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
      },
      select: { id: true },
    });
    if (superseded.length > 0) {
      await tx.agentRun.updateMany({
        where: { id: { in: superseded.map((run) => run.id) } },
        data: {
          status: AgentRunStatus.ABANDONED,
          finishedAt: now,
          currentStep: "superseded by one-time runtime tool grant",
          awaitingApprovalAt: null,
          pendingApproval: Prisma.DbNull,
        },
      });
      await Promise.all(
        superseded.map((run) =>
          appendRunEvent(tx, {
            runId: run.id,
            workspaceId,
            issueId,
            agentId: p.agentId,
            kind: "SUPERSEDED",
            currentStep: "superseded by one-time runtime tool grant",
            payload: {
              actionRequestId: request.id,
              mode: p.mode,
              tools: p.tools,
            },
          }),
        ),
      );
    }

    const grantEngine = resolveRunEngineWithSource({
      runEngine: agent.runEngine,
      provider: agent.provider,
      runtime: agent.runtime,
    });
    const { run } = await openOrTouchRun(tx, {
      workspaceId,
      issueId,
      agentId: p.agentId,
      actorId,
      currentStep: "queued with one-time runtime tool grant",
      engagementMode: p.mode,
      // The grant carries an explicit mode the operator approved.
      engagementSource: "explicit",
      runEngine: grantEngine.engine,
      runEngineSource: grantEngine.source,
      runtimePolicy: runtimePolicy as unknown as Prisma.InputJsonValue,
      resumeWaiting: true,
    });
    // Collapse the runs we just abandoned (above) under the fresh grant
    // run so the stack reads as one thread. Prior STALLED attempts are
    // already linked inside openOrTouchRun via linkSupersededRuns.
    if (superseded.length > 0) {
      await tx.agentRun.updateMany({
        where: { id: { in: superseded.map((r) => r.id) } },
        data: { supersededByRunId: run.id },
      });
    }
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        triggerEventId: request.id,
        triggerKind: "ACTION_REQUEST_ACCEPTED",
      },
    });
    await appendRunEvent(tx, {
      runId: run.id,
      workspaceId,
      issueId,
      agentId: p.agentId,
      kind: "TOOL_GRANT_APPROVED",
      currentStep: "queued with one-time runtime tool grant",
      payload: {
        actionRequestId: request.id,
        mode: p.mode,
        tools: p.tools,
        accessLevel: p.accessLevel,
        scopePath: p.scopePath,
      },
    });
    return;
  }

  if (kind === ActionRequestKind.ARCHIVE) {
    await archiveIssue(tx, {
      workspaceId,
      actorId,
      issueId,
      action: "archive",
      via: "action-request",
      metadata: { actionRequestId: request.id },
    });
    return;
  }

  if (kind === ActionRequestKind.CLOSE_AS_DUPLICATE) {
    const p = parseActionRequestPayload(ActionRequestKind.CLOSE_AS_DUPLICATE, payload);
    // 1. Persist the DUPLICATES relation (idempotent upsert).
    await tx.issueRelation.upsert({
      where: {
        fromIssueId_toIssueId_kind: {
          fromIssueId: issueId,
          toIssueId: p.duplicateOfIssueId,
          kind: RelationKind.DUPLICATES,
        },
      },
      create: {
        workspaceId,
        fromIssueId: issueId,
        toIssueId: p.duplicateOfIssueId,
        kind: RelationKind.DUPLICATES,
      },
      update: {},
    });
    // 2. Optionally transition the source issue. Default behavior:
    //    leave the status alone unless the caller supplied one — keeps
    //    the action narrow and predictable.
    if (p.statusId) {
      const next = await tx.status.findFirst({
        where: { id: p.statusId, workspaceId },
      });
      if (!next) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "CLOSE_AS_DUPLICATE.statusId no longer exists.",
        });
      }
      const extra: {
        canceledAt?: Date | null;
        completedAt?: Date | null;
      } = {};
      if (next.category === "CANCELED") extra.canceledAt = new Date();
      if (next.category === "DONE") extra.completedAt = new Date();
      if (next.category !== "DONE") extra.completedAt = null;
      if (next.category !== "CANCELED") extra.canceledAt = null;
      await tx.issue.update({
        where: { id: issueId },
        data: { statusId: p.statusId, ...extra },
      });
    }
    await recordChange(tx, {
      workspaceId,
      actorId,
      entity: "Issue",
      entityId: issueId,
      action: "close-as-duplicate",
      after: {
        duplicateOfIssueId: p.duplicateOfIssueId,
        statusId: p.statusId ?? null,
      },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "issue",
      subjectId: issueId,
      payload: {
        duplicateOfIssueId: p.duplicateOfIssueId,
        statusId: p.statusId ?? null,
        via: "action-request",
        actionRequestId: request.id,
      },
    });
    return;
  }
}

/**
 * Accept an action request — runs the bound dispatch (if any) and
 * flips status=RESOLVED in the same transaction so the UI either sees
 * both or neither. Permission-gated to assignee / watcher / OWNER /
 * ADMIN.
 */
export async function acceptActionRequest(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    resolution?: string | null;
  },
): Promise<{ id: string; dispatched: boolean }> {
  const request = await db.actionRequest.findFirst({
    where: { id: params.requestId, workspaceId: params.workspaceId },
    select: {
      id: true,
      kind: true,
      status: true,
      payload: true,
      assignedUserId: true,
      issueId: true,
      requestedByAgentId: true,
      title: true,
      sourceType: true,
      sourceId: true,
    },
  });
  if (!request) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
  }
  if (request.status !== ActionRequestStatus.OPEN) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Action request is already ${request.status.toLowerCase()}.`,
    });
  }
  await assertCanResolveActionRequest(db, {
    workspaceId: params.workspaceId,
    userId: params.actorId,
    request,
  });
  const actor = await db.user.findUnique({
    where: { id: params.actorId },
    select: { handle: true, name: true },
  });
  const tag = actor?.handle ? `@${actor.handle}` : (actor?.name ?? "operator");
  const baseResolution = `Accepted by ${tag}`;
  const note = params.resolution?.trim()
    ? `${baseResolution} — ${params.resolution.trim()}`
    : baseResolution;

  let dispatched = false;
  await db.$transaction(async (tx) => {
    await dispatchActionRequestKind(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      request,
    });
    dispatched = request.kind !== ActionRequestKind.FREE_FORM;
    // Plan-approval hook: a FREE_FORM request sourced from an
    // execution-plan activates that plan on Accept (DRAFT/APPROVED →
    // RUNNING, goal → ACTIVE, root steps dispatched). Runs in the same
    // transaction as the request flip so accept + activation are atomic.
    if (
      request.kind === ActionRequestKind.FREE_FORM &&
      request.sourceType === "execution-plan" &&
      request.sourceId
    ) {
      const { activatePlan } = await import("@/server/services/orchestration-service");
      await activatePlan(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        planId: request.sourceId,
      });
      dispatched = true;
    }
    await tx.actionRequest.update({
      where: { id: request.id },
      data: {
        status: ActionRequestStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedByUserId: params.actorId,
        resolution: note,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "action-request",
      entityId: request.id,
      action: "accept",
      before: { status: request.status },
      after: {
        status: ActionRequestStatus.RESOLVED,
        kind: request.kind,
        dispatched,
      },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: request.id,
      payload: {
        kind: request.kind,
        dispatched,
        issueId: request.issueId,
        resolution: note,
      },
    });

    // Deliver the answer back to the requesting agent. A FREE_FORM ask is
    // the agent asking *us* for information — resolving it isn't enough,
    // the answer has to reach the agent. Post it as a comment @mentioning
    // the agent on the issue, which routes through the normal mention
    // dispatch (and records an inbox row even for runs-engine agents that
    // poll). Only when there's a real answer to deliver.
    const answer = params.resolution?.trim();
    if (
      request.kind === ActionRequestKind.FREE_FORM &&
      request.requestedByAgentId &&
      request.issueId &&
      answer
    ) {
      const agent = await tx.agent.findUnique({
        where: { id: request.requestedByAgentId },
        select: { id: true, profileKey: true },
      });
      if (agent) {
        const comment = await tx.comment.create({
          data: {
            workspaceId: params.workspaceId,
            issueId: request.issueId,
            authorId: params.actorId,
            body: `@${agent.profileKey} ${answer}`,
          },
        });
        await recordChange(tx, {
          workspaceId: params.workspaceId,
          actorId: params.actorId,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: request.issueId,
          payload: {
            commentId: comment.id,
            issueId: request.issueId,
            mentions: { agentIds: [agent.id], userIds: [] },
            answeredActionRequestId: request.id,
          },
        });
      }
    }
  });
  return { id: request.id, dispatched };
}

/**
 * Decline an action request — flips status=REJECTED and records the
 * (optional) reason. Never dispatches the bound action. Permission gate
 * is identical to Accept.
 */
export async function declineActionRequest(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    reason?: string | null;
  },
): Promise<{ id: string }> {
  const request = await db.actionRequest.findFirst({
    where: { id: params.requestId, workspaceId: params.workspaceId },
    select: {
      id: true,
      kind: true,
      status: true,
      assignedUserId: true,
      issueId: true,
    },
  });
  if (!request) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
  }
  if (request.status !== ActionRequestStatus.OPEN) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Action request is already ${request.status.toLowerCase()}.`,
    });
  }
  await assertCanResolveActionRequest(db, {
    workspaceId: params.workspaceId,
    userId: params.actorId,
    request,
  });
  const actor = await db.user.findUnique({
    where: { id: params.actorId },
    select: { handle: true, name: true },
  });
  const tag = actor?.handle ? `@${actor.handle}` : (actor?.name ?? "operator");
  const reason = params.reason?.trim();
  const note = reason ? `Declined by ${tag}: ${reason}` : `Declined by ${tag}`;
  await db.$transaction(async (tx) => {
    await tx.actionRequest.update({
      where: { id: request.id },
      data: {
        status: ActionRequestStatus.REJECTED,
        resolvedAt: new Date(),
        resolvedByUserId: params.actorId,
        resolution: note,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "action-request",
      entityId: request.id,
      action: "decline",
      before: { status: request.status },
      after: { status: ActionRequestStatus.REJECTED, kind: request.kind },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: request.id,
      payload: {
        kind: request.kind,
        issueId: request.issueId,
        resolution: note,
      },
    });
  });
  return { id: request.id };
}

// ---------------------------------------------------------------------------
// Polls — multi-vote variant of ActionRequest.
// ---------------------------------------------------------------------------

export interface PollResultsRow {
  optionKey: string;
  label: string;
  description: string | null;
  count: number;
  /** Earliest vote timestamp for this option (used for tie-breaking). */
  firstVoteAt: Date | null;
}

export interface PollResults {
  options: PollResultsRow[];
  total: number;
  votingClosedAt: Date | null;
  /** The caller's current pick, if they've voted. */
  myVote: string | null;
  /** Winning option key — populated when `votingClosedAt` is set. */
  winningOptionKey: string | null;
}

/**
 * Load a request row + assert it lives in the caller's workspace and
 * carries a non-null `options` array. Throws with the conventional
 * tRPC codes so callers can pass the error straight through.
 */
async function loadPollRequest(
  db: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  requestId: string,
): Promise<{
  id: string;
  status: ActionRequestStatus;
  options: ActionRequestPollOption[];
  votingClosedAt: Date | null;
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  issueId: string | null;
  title: string;
}> {
  const row = await db.actionRequest.findFirst({
    where: { id: requestId, workspaceId },
    select: {
      id: true,
      status: true,
      options: true,
      votingClosedAt: true,
      requestedByUserId: true,
      requestedByAgentId: true,
      issueId: true,
      title: true,
    },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
  }
  const options = readPollOptions(row.options);
  if (!options) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This action request is not a poll (no `options` set).",
    });
  }
  return { ...row, options };
}

/**
 * Upsert the caller's vote on a poll. Changing the pick is supported
 * until `votingClosedAt` is set. Audit + event recorded so the
 * activity feed shows "@bailey voted for option-X".
 */
export async function voteOnActionRequest(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    optionKey: string;
  },
): Promise<{ id: string; optionKey: string; changed: boolean }> {
  const request = await loadPollRequest(db, params.workspaceId, params.requestId);
  if (request.votingClosedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Voting on this poll has been closed.",
    });
  }
  if (!request.options.some((o) => o.key === params.optionKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown option key '${params.optionKey}'.`,
    });
  }

  // Look up existing vote (if any) so we can record `changed` cleanly
  // in the audit/event payload.
  const existing = await db.actionRequestVote.findUnique({
    where: {
      actionRequestId_userId: {
        actionRequestId: request.id,
        userId: params.actorId,
      },
    },
    select: { id: true, optionKey: true },
  });
  const changed = !!existing && existing.optionKey !== params.optionKey;

  await db.$transaction(async (tx) => {
    await tx.actionRequestVote.upsert({
      where: {
        actionRequestId_userId: {
          actionRequestId: request.id,
          userId: params.actorId,
        },
      },
      create: {
        actionRequestId: request.id,
        userId: params.actorId,
        optionKey: params.optionKey,
      },
      update: {
        optionKey: params.optionKey,
      },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      entity: "action-request-vote",
      entityId: request.id,
      action: existing ? (changed ? "vote-change" : "vote-restate") : "vote",
      before: existing ? { optionKey: existing.optionKey } : undefined,
      after: { optionKey: params.optionKey },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: request.id,
      payload: {
        optionKey: params.optionKey,
        previousOptionKey: existing?.optionKey ?? null,
        changed,
        issueId: request.issueId,
      },
    });
  });
  return { id: request.id, optionKey: params.optionKey, changed };
}

/**
 * Aggregate vote counts per option. The renderer can show live counts
 * as votes come in (Linear-style). `myVote` returns the caller's
 * current pick so the UI can highlight it; `winningOptionKey` is only
 * populated after voting is closed.
 */
export async function getActionRequestResults(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string;
    requestId: string;
  },
): Promise<PollResults> {
  const request = await loadPollRequest(db, params.workspaceId, params.requestId);
  const votes = await db.actionRequestVote.findMany({
    where: { actionRequestId: request.id },
    select: { optionKey: true, userId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const countsByKey = new Map<string, { count: number; firstVoteAt: Date | null }>();
  for (const opt of request.options) {
    countsByKey.set(opt.key, { count: 0, firstVoteAt: null });
  }
  let myVote: string | null = null;
  for (const v of votes) {
    if (v.userId === params.actorId) {
      myVote = v.optionKey;
    }
    const bucket = countsByKey.get(v.optionKey);
    // Skip unknown options (e.g., options trimmed after votes
    // already landed). Defensive — should be unreachable when the
    // create-time validator is doing its job.
    if (!bucket) continue;
    bucket.count += 1;
    if (!bucket.firstVoteAt) bucket.firstVoteAt = v.createdAt;
  }

  const rows: PollResultsRow[] = request.options.map((opt) => {
    const bucket = countsByKey.get(opt.key) ?? { count: 0, firstVoteAt: null };
    return {
      optionKey: opt.key,
      label: opt.label,
      description: opt.description ?? null,
      count: bucket.count,
      firstVoteAt: bucket.firstVoteAt,
    };
  });

  return {
    options: rows,
    total: votes.length,
    votingClosedAt: request.votingClosedAt,
    myVote,
    winningOptionKey: request.votingClosedAt ? pickWinner(rows) : null,
  };
}

/**
 * Tie-break rule: highest count wins. On equal counts, the option
 * whose first vote was cast earliest wins (proxy for "people picked
 * this first"). On equal counts AND no votes at all, the option that
 * appears first in the `options[]` array wins. Returns null only on
 * an empty options array (which the schema rejects at create-time).
 */
function pickWinner(rows: PollResultsRow[]): string | null {
  if (rows.length === 0) return null;
  let best: PollResultsRow | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    if (row.count > best.count) {
      best = row;
      continue;
    }
    if (row.count === best.count) {
      // Earlier first-vote wins; null sorts after a real date.
      const a = row.firstVoteAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const b = best.firstVoteAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (a < b) best = row;
    }
  }
  return best?.optionKey ?? null;
}

/**
 * Close voting on a poll. Only the original requester (the user who
 * created the request) can call this — agent-requested polls fall
 * back to the requesting agent's owner key. Returns the winning
 * option key (or null if no votes were cast).
 *
 * Closing voting does NOT resolve the ActionRequest itself — the
 * requester typically posts a follow-up comment "going with option
 * X" and then calls `accept` / `resolve` to clear the request.
 */
export async function closeActionRequestVoting(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string;
    actorAgentId: string | null;
    requestId: string;
  },
): Promise<{ id: string; winningOptionKey: string | null }> {
  const request = await loadPollRequest(db, params.workspaceId, params.requestId);
  if (request.votingClosedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Voting on this poll is already closed.",
    });
  }
  // Permission check: the requester is the only one who can close
  // voting. For a human-requested poll, that's the userId; for an
  // agent-requested poll, the actor must be the agent that owns
  // the request (matched via the calling key's linkedAgentId).
  const isHumanOwner =
    request.requestedByUserId !== null && request.requestedByUserId === params.actorId;
  const isAgentOwner =
    request.requestedByAgentId !== null && request.requestedByAgentId === params.actorAgentId;
  if (!isHumanOwner && !isAgentOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the original requester can close voting on this poll.",
    });
  }

  // Re-tally inside the transaction so the winner reflects the votes
  // that exist at close time (no read-then-write race).
  const closedAt = new Date();
  let winningOptionKey: string | null = null;
  await db.$transaction(async (tx) => {
    const votes = await tx.actionRequestVote.findMany({
      where: { actionRequestId: request.id },
      select: { optionKey: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const countsByKey = new Map<string, { count: number; firstVoteAt: Date | null }>();
    for (const opt of request.options) {
      countsByKey.set(opt.key, { count: 0, firstVoteAt: null });
    }
    for (const v of votes) {
      const bucket = countsByKey.get(v.optionKey);
      if (!bucket) continue;
      bucket.count += 1;
      if (!bucket.firstVoteAt) bucket.firstVoteAt = v.createdAt;
    }
    const rows: PollResultsRow[] = request.options.map((opt) => {
      const bucket = countsByKey.get(opt.key) ?? { count: 0, firstVoteAt: null };
      return {
        optionKey: opt.key,
        label: opt.label,
        description: opt.description ?? null,
        count: bucket.count,
        firstVoteAt: bucket.firstVoteAt,
      };
    });
    winningOptionKey = pickWinner(rows);

    await tx.actionRequest.update({
      where: { id: request.id },
      data: { votingClosedAt: closedAt },
    });
    await recordChange(tx, {
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      actorAgentId: params.actorAgentId ?? null,
      entity: "action-request",
      entityId: request.id,
      action: "close-voting",
      after: {
        votingClosedAt: closedAt.toISOString(),
        winningOptionKey,
        total: votes.length,
      },
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "action-request",
      subjectId: request.id,
      payload: {
        winningOptionKey,
        total: votes.length,
        issueId: request.issueId,
      },
    });
  });
  return { id: request.id, winningOptionKey };
}
