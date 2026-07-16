import "server-only";

import {
  AgentConnectionStatus,
  LivenessConfidence,
  Prisma,
  type AgentConnection,
  type AgentConnectionCapability,
  type AgentConnectionKind,
  type AgentConnectionLiveness,
  type PrismaClient,
} from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type UpsertAgentConnectionInput = {
  workspaceId: string;
  agentId: string;
  kind: AgentConnectionKind;
  livenessModel: AgentConnectionLiveness;
  apiKeyId?: string | null;
  runtimeId?: string | null;
  instanceKey?: string | null;
  displayName?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  capabilities?: AgentConnectionCapability[];
  metadata?: unknown;
};

type TouchAgentConnectionInput = {
  status?: AgentConnectionStatus;
  confidence?: LivenessConfidence;
  seenAt?: Date;
  metadata?: unknown;
};

const MAX_METADATA_KEYS = 32;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_STRING = 512;

/**
 * Keep connection metadata safe for operator display. Protocol implementations
 * must never persist raw request headers, credentials, environment variables,
 * or arbitrary unbounded initialize payloads here.
 */
export function sanitizeAgentConnectionMetadata(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull | undefined {
  function visit(input: unknown, depth: number): Prisma.InputJsonValue | null | undefined {
    if (input === null) return null;
    if (typeof input === "string") return input.slice(0, MAX_METADATA_STRING);
    if (typeof input === "boolean" || typeof input === "number") return input;
    if (depth >= MAX_METADATA_DEPTH) return undefined;
    if (Array.isArray(input)) {
      return input
        .slice(0, MAX_METADATA_KEYS)
        .map((item) => visit(item, depth + 1))
        .filter((item): item is Prisma.InputJsonValue | null => item !== undefined);
    }
    if (typeof input !== "object") return undefined;

    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(input).slice(0, MAX_METADATA_KEYS)) {
      if (/token|secret|password|authorization|cookie|credential/i.test(key)) continue;
      const sanitized = visit(item, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return result as Prisma.InputJsonObject;
  }

  const sanitized = visit(value, 0);
  return sanitized === null ? Prisma.JsonNull : sanitized;
}

/**
 * Register or refresh a concrete endpoint. A supplied instanceKey is the
 * durable identity and makes initialize/reconnect idempotent. Legacy callers
 * without an instance key reuse the most specific matching credential/runtime
 * endpoint when possible, but should migrate to a negotiated key.
 */
export async function upsertAgentConnection(
  db: DbClient,
  input: UpsertAgentConnectionInput,
): Promise<AgentConnection> {
  const now = new Date();
  const metadata = sanitizeAgentConnectionMetadata(input.metadata);
  const common = {
    livenessModel: input.livenessModel,
    status: AgentConnectionStatus.ACTIVE,
    confidence: LivenessConfidence.CONFIRMED,
    apiKeyId: input.apiKeyId ?? null,
    runtimeId: input.runtimeId ?? null,
    displayName: input.displayName?.slice(0, 160) ?? null,
    clientName: input.clientName?.slice(0, 120) ?? null,
    clientVersion: input.clientVersion?.slice(0, 80) ?? null,
    capabilities: input.capabilities ?? [],
    ...(metadata !== undefined ? { metadata } : {}),
    lastSeenAt: now,
    connectedAt: now,
    disconnectedAt: null,
    revokedAt: null,
  } satisfies Prisma.AgentConnectionUncheckedUpdateInput;

  if (input.instanceKey) {
    return db.agentConnection.upsert({
      where: {
        workspaceId_agentId_kind_instanceKey: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          kind: input.kind,
          instanceKey: input.instanceKey.slice(0, 255),
        },
      },
      create: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        kind: input.kind,
        instanceKey: input.instanceKey.slice(0, 255),
        firstSeenAt: now,
        ...common,
      },
      update: common,
    });
  }

  const existing = await db.agentConnection.findFirst({
    where: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: input.kind,
      apiKeyId: input.apiKeyId ?? null,
      runtimeId: input.runtimeId ?? null,
      clientName: input.clientName ?? null,
      revokedAt: null,
    },
    orderBy: { lastSeenAt: "desc" },
  });

  if (existing) {
    return db.agentConnection.update({ where: { id: existing.id }, data: common });
  }

  return db.agentConnection.create({
    data: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      kind: input.kind,
      instanceKey: null,
      firstSeenAt: now,
      ...common,
    },
  });
}

/** Refresh liveness for an already-registered endpoint. */
export async function touchAgentConnection(
  db: DbClient,
  connectionId: string,
  input: TouchAgentConnectionInput = {},
): Promise<AgentConnection> {
  const metadata = sanitizeAgentConnectionMetadata(input.metadata);
  return db.agentConnection.update({
    where: { id: connectionId },
    data: {
      status: input.status ?? AgentConnectionStatus.ACTIVE,
      confidence: input.confidence ?? LivenessConfidence.CONFIRMED,
      lastSeenAt: input.seenAt ?? new Date(),
      disconnectedAt: null,
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
}

/** Revoke every concrete client registered through a credential. */
export async function revokeAgentConnectionsForApiKey(
  db: DbClient,
  apiKeyId: string,
  revokedAt: Date = new Date(),
): Promise<number> {
  const result = await db.agentConnection.updateMany({
    where: { apiKeyId, revokedAt: null },
    data: {
      status: AgentConnectionStatus.REVOKED,
      confidence: LivenessConfidence.CONFIRMED,
      revokedAt,
      disconnectedAt: revokedAt,
    },
  });
  return result.count;
}
