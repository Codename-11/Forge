import "server-only";

import {
  ChatRole,
  ConnectorDeliveryDirection,
  ConnectorDeliveryStatus,
  ConnectorSessionLifecycle,
  EventKind,
  type Prisma,
} from "@prisma/client";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import {
  connectorRetryDecision,
  hermesSessionExternalEventId,
  makeHermesSessionsClient,
  redactConnectorDiagnostic,
} from "@/server/services/hermes-sessions";

type DbClient = typeof db;

function object(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Replay due interactive Hermes outbox rows. The browser stream is only a
 * presentation channel: once a turn is durable, the worker owns eventual
 * delivery and persists the final reply into the existing placeholder. */
export async function sweepHermesConnectorRetries(
  client: DbClient = db,
  now = new Date(),
): Promise<{ attempted: number; delivered: number; rescheduled: number; deadLettered: number }> {
  const due = await client.connectorDelivery.findMany({
    where: {
      direction: ConnectorDeliveryDirection.OUTBOUND,
      OR: [
        {
          status: ConnectorDeliveryStatus.RETRY_SCHEDULED,
          nextAttemptAt: { lte: now },
        },
        {
          status: ConnectorDeliveryStatus.PROCESSING,
          nextAttemptAt: { lte: now },
        },
      ],
      connectorSession: { connectorKey: "hermes-sessions" },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 20,
    include: {
      chatMessage: { select: { id: true, threadId: true } },
      connectorSession: {
        include: {
          runtime: { select: { endpoint: true, secret: true, disabledAt: true } },
          workspace: {
            select: {
              connectorRequestTimeoutSeconds: true,
              connectorDeliveryMaxAttempts: true,
              connectorRetryInitialSeconds: true,
              connectorRetryMaxSeconds: true,
            },
          },
        },
      },
    },
  });
  let delivered = 0;
  let rescheduled = 0;
  let deadLettered = 0;

  for (const candidate of due) {
    const claimed = await client.connectorDelivery.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        attempt: candidate.attempt,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: ConnectorDeliveryStatus.PROCESSING,
        attempt: { increment: 1 },
        lastAttemptAt: now,
        nextAttemptAt: null,
      },
    });
    if (claimed.count === 0) continue;
    const attempt = candidate.attempt + 1;
    const session = candidate.connectorSession;
    const payload = object(candidate.payload);
    const body = typeof payload.body === "string" ? payload.body : "";
    const message =
      typeof payload.message === "string" || Array.isArray(payload.message)
        ? (payload.message as string | Array<Record<string, unknown>>)
        : body;
    const threadId = candidate.chatMessage?.threadId;
    if (!session.runtime.endpoint || session.runtime.disabledAt || !threadId || !message) {
      await client.connectorDelivery.update({
        where: { id: candidate.id },
        data: {
          status: ConnectorDeliveryStatus.DEAD_LETTER,
          lastError: "Retry payload or Hermes runtime binding is unavailable.",
        },
      });
      deadLettered += 1;
      continue;
    }

    try {
      const hermes = makeHermesSessionsClient({
        baseUrl: session.runtime.endpoint,
        token: session.runtime.secret,
        requestTimeoutMs: session.workspace.connectorRequestTimeoutSeconds * 1000,
      });
      const chunks: string[] = [];
      let completed: string | null = null;
      let externalMessageId: string | null = null;
      for await (const event of hermes.streamMessage({
        sessionId: session.externalSessionId,
        memoryKey: session.memoryKey,
        message,
        instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        idempotencyKey: candidate.externalEventId,
      })) {
        if (event.name === "assistant.delta" && typeof event.data.delta === "string") {
          chunks.push(event.data.delta);
        }
        if (event.name === "assistant.completed" && typeof event.data.content === "string") {
          completed = event.data.content;
        }
        if (event.messageId) externalMessageId = event.messageId;
        await client.connectorDelivery.createMany({
          data: [
            {
              workspaceId: candidate.workspaceId,
              connectorSessionId: session.id,
              direction: ConnectorDeliveryDirection.INBOUND,
              externalEventId: hermesSessionExternalEventId(event),
              sequence: event.sequence,
              kind: event.name,
              status: ConnectorDeliveryStatus.DELIVERED,
              payload: event.data as Prisma.InputJsonObject,
              deliveredAt: new Date(),
            },
          ],
          skipDuplicates: true,
        });
      }
      const finalBody = chunks.join("") || completed || "";
      await client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${threadId}))`;
        const reply = await tx.chatMessage.findFirst({
          where: {
            workspaceId: candidate.workspaceId,
            threadId,
            role: ChatRole.AGENT,
            replyToMessageId: candidate.chatMessageId,
            connectorSessionId: session.id,
          },
          orderBy: { createdAt: "desc" },
        });
        if (!reply) throw new Error("Hermes retry reply placeholder is missing.");
        const finishedAt = new Date();
        await tx.chatMessage.update({
          where: { id: reply.id },
          data: {
            body: finalBody,
            externalMessageId,
            contextSnapshot: {
              running: false,
              status: "completed",
              retriedByWorker: true,
              retryAttempt: attempt,
              finishedAt: finishedAt.toISOString(),
              replyToMessageId: candidate.chatMessageId,
            },
          },
        });
        await tx.connectorDelivery.update({
          where: { id: candidate.id },
          data: {
            status: ConnectorDeliveryStatus.DELIVERED,
            deliveredAt: finishedAt,
            lastError: null,
            nextAttemptAt: null,
          },
        });
        await tx.connectorSession.update({
          where: { id: session.id },
          data: {
            lifecycle: ConnectorSessionLifecycle.ACTIVE,
            lastConnectedAt: finishedAt,
            lastDeliveryAt: finishedAt,
            lastError: null,
            lastErrorAt: null,
            retryCount: 0,
            nextRetryAt: null,
          },
        });
        await recordChange(tx, {
          workspaceId: candidate.workspaceId,
          actorId: null,
          actorAgentId: session.agentId,
          entity: "ChatMessage",
          entityId: reply.id,
          action: "connector-retry-delivered",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: threadId,
          payload: {
            threadId,
            messageId: reply.id,
            agentId: session.agentId,
            role: "AGENT",
            connectorDeliveryId: candidate.id,
            retryAttempt: attempt,
          },
        });
      });
      delivered += 1;
    } catch (error) {
      const detail = redactConnectorDiagnostic(error);
      const retry = connectorRetryDecision({
        attempt,
        maxAttempts: session.workspace.connectorDeliveryMaxAttempts,
        initialSeconds: session.workspace.connectorRetryInitialSeconds,
        maxSeconds: session.workspace.connectorRetryMaxSeconds,
        now: new Date(),
      });
      await client.$transaction([
        client.connectorDelivery.update({
          where: { id: candidate.id },
          data: {
            status: retry.deadLetter
              ? ConnectorDeliveryStatus.DEAD_LETTER
              : ConnectorDeliveryStatus.RETRY_SCHEDULED,
            lastError: detail,
            nextAttemptAt: retry.nextAttemptAt,
          },
        }),
        client.connectorSession.update({
          where: { id: session.id },
          data: {
            lifecycle: ConnectorSessionLifecycle.ERROR,
            lastError: detail,
            lastErrorAt: new Date(),
            retryCount: attempt,
            nextRetryAt: retry.nextAttemptAt,
          },
        }),
      ]);
      if (retry.deadLetter) deadLettered += 1;
      else rescheduled += 1;
    }
  }
  return { attempted: due.length, delivered, rescheduled, deadLettered };
}
