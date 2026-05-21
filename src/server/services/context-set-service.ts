import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { recordChange } from "@/server/audit";
import { hydrateEntityRefs, type HydratedEntityRef } from "@/server/services/entity-hydration";
import { type ForgeEntityType } from "@/lib/entity-ref";

export const CONTEXT_SET_INCLUDE_MODES = ["INCLUDE", "EXCLUDE", "SUMMARY_ONLY"] as const;
export type ContextSetIncludeMode = (typeof CONTEXT_SET_INCLUDE_MODES)[number];

export interface CreateContextSetInput {
  workspaceId: string;
  actorId: string | null;
  actorAgentId?: string | null;
  name: string;
  description?: string | null;
  items?: Array<{
    targetType: string;
    targetId: string;
    includeMode?: ContextSetIncludeMode;
    note?: string | null;
  }>;
}

/**
 * Create a ContextSet with optional seeded items. Owners default to
 * the calling user (or agent if the caller is an agent-linked api key).
 */
export async function createContextSet(
  db: PrismaClient,
  input: CreateContextSetInput,
): Promise<{ id: string }> {
  const { id } = await db.$transaction(async (tx) => {
    const set = await tx.contextSet.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name.trim(),
        description: input.description ?? null,
        ownerUserId: input.actorAgentId ? null : input.actorId,
        ownerAgentId: input.actorAgentId ?? null,
      },
    });
    if (input.items && input.items.length) {
      await tx.contextSetItem.createMany({
        data: input.items.map((it, idx) => ({
          workspaceId: input.workspaceId,
          contextSetId: set.id,
          targetType: it.targetType,
          targetId: it.targetId,
          includeMode: it.includeMode ?? "INCLUDE",
          position: idx,
          note: it.note ?? null,
        })),
      });
    }
    await recordChange(tx, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorAgentId: input.actorAgentId ?? null,
      entity: "context-set",
      entityId: set.id,
      action: "created",
      after: { name: set.name, itemCount: input.items?.length ?? 0 } as Prisma.InputJsonValue,
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "context-set",
      subjectId: set.id,
      payload: {
        contextSetName: set.name,
        action: "created",
      } as Prisma.InputJsonValue,
    });
    return { id: set.id };
  });
  return { id };
}

/** Add an item to an existing ContextSet (idempotent on the unique key). */
export async function addContextSetItem(
  db: PrismaClient,
  params: {
    workspaceId: string;
    actorId: string | null;
    contextSetId: string;
    targetType: string;
    targetId: string;
    includeMode?: ContextSetIncludeMode;
    note?: string | null;
  },
): Promise<{ id: string }> {
  const set = await db.contextSet.findFirst({
    where: { id: params.contextSetId, workspaceId: params.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!set) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Context set not found." });
  }
  // Position = current max + 1 (per-set monotonic).
  const last = await db.contextSetItem.findFirst({
    where: { contextSetId: params.contextSetId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const item = await db.contextSetItem.upsert({
    where: {
      contextSetId_targetType_targetId: {
        contextSetId: params.contextSetId,
        targetType: params.targetType,
        targetId: params.targetId,
      },
    },
    create: {
      workspaceId: params.workspaceId,
      contextSetId: params.contextSetId,
      targetType: params.targetType,
      targetId: params.targetId,
      includeMode: params.includeMode ?? "INCLUDE",
      position: (last?.position ?? -1) + 1,
      note: params.note ?? null,
    },
    update: {
      includeMode: params.includeMode ?? undefined,
      note: params.note ?? undefined,
    },
    select: { id: true },
  });
  await db.contextSet.update({
    where: { id: params.contextSetId },
    data: { updatedAt: new Date() },
  });
  return { id: item.id };
}

/** Remove an item from a ContextSet. */
export async function removeContextSetItem(
  db: PrismaClient,
  params: {
    workspaceId: string;
    contextSetId: string;
    itemId: string;
  },
): Promise<void> {
  const item = await db.contextSetItem.findFirst({
    where: {
      id: params.itemId,
      contextSetId: params.contextSetId,
      workspaceId: params.workspaceId,
    },
    select: { id: true },
  });
  if (!item) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Context set item not found." });
  }
  await db.contextSetItem.delete({ where: { id: item.id } });
  await db.contextSet.update({
    where: { id: params.contextSetId },
    data: { updatedAt: new Date() },
  });
}

export interface HydratedContextSet {
  id: string;
  name: string;
  description: string | null;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  items: Array<
    HydratedEntityRef & {
      itemId: string;
      includeMode: ContextSetIncludeMode | string;
      position: number;
      note: string | null;
    }
  >;
}

/**
 * Hydrate a ContextSet to the shape an agent/UI consumer wants: head
 * row + every item resolved to a {label, subLabel, url, missing} ref.
 * Filters EXCLUDE items out of the agent's view by default; the
 * context inspector UI surfaces them under a separate "excluded"
 * bucket.
 */
export async function hydrateContextSet(
  db: PrismaClient,
  params: { workspaceId: string; contextSetId: string; workspaceSlug?: string },
): Promise<HydratedContextSet | null> {
  const set = await db.contextSet.findFirst({
    where: { id: params.contextSetId, workspaceId: params.workspaceId },
    include: {
      items: { orderBy: { position: "asc" } },
    },
  });
  if (!set) return null;
  const refs = set.items.map((item) => ({
    type: item.targetType as ForgeEntityType,
    id: item.targetId,
  }));
  const hydrated = await hydrateEntityRefs(
    { db, workspaceId: params.workspaceId, workspaceSlug: params.workspaceSlug },
    refs,
  );
  const items = set.items.map((item, idx) => ({
    ...hydrated[idx],
    itemId: item.id,
    includeMode: item.includeMode,
    position: item.position,
    note: item.note,
  }));
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    ownerUserId: set.ownerUserId,
    ownerAgentId: set.ownerAgentId,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    archivedAt: set.archivedAt,
    items,
  };
}
