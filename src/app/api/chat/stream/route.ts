import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  ChatRole,
  ConnectorDeliveryDirection,
  ConnectorDeliveryStatus,
  ConnectorSessionLifecycle,
  EventKind,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import {
  runChatLoop,
  providerIdFor,
  type ChatStreamContentBlock,
  type ChatStreamMessage,
  type ChatToolCall,
  type ChatToolExecResult,
} from "@/server/services/chat-stream";
import {
  resolveWorkspaceProviderClient,
  workspaceChatProviderAvailability,
} from "@/server/services/ai-providers";
import { resolveChatReadiness } from "@/server/services/chat-readiness";
import { chatToolsAsOpenAITools, findChatTool } from "@/server/services/chat-tools-allowlist";
import { executeChatTool } from "@/server/services/chat-tool-exec";
import {
  clearPendingChatApproval,
  clearChatStreamStop,
  getChatStreamStopRequest,
  registerPendingChatApproval,
  requestChatStreamStop,
  waitForPendingChatApproval,
} from "@/server/services/chat-stream-state";
import { resolveRunEngine, getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import { loadCanvasContextSummary } from "@/server/services/chat-context-canvas";
import { presignDownloadUrl } from "@/server/services/storage";
import { FORGE_RUN_CONTRACT_VERSION } from "@/server/services/engagement-mode";
import { buildRuntimePolicySnapshot } from "@/lib/runtime-enforcement";
import { logger } from "@/server/logger";
import { publish } from "@/server/realtime";
import {
  buildHermesMemoryKey,
  connectorRetryDecision,
  hermesSessionExternalEventId,
  HERMES_SESSIONS_CONNECTOR_KEY,
  makeHermesSessionsClient,
  redactConnectorDiagnostic,
  type HermesNegotiatedCapabilities,
  type HermesSessionEvent,
  type HermesSessionsClient,
} from "@/server/services/hermes-sessions";

/**
 * Interactive chat streaming endpoint.
 *
 * The dispatch path (CHAT_MESSAGE_POSTED → WebhookDelivery → Hermes → MCP)
 * is still required for assignment-triggered wakes and existing tests.
 * This endpoint is the *interactive* path: the operator types, we open a
 * direct OpenAI-compatible streaming call to the provider configured on
 * `Agent.provider`, and pipe deltas back as Server-Sent Events.
 *
 * Lifecycle invariant: even on the streaming path, we still persist the USER
 * row with `dispatchedAt` set + emit CHAT_MESSAGE_POSTED via recordChange so
 * audit + activity-event consumers stay consistent. Payload carries
 * `streamed: true` so fan-out branches can skip the webhook dispatch.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function redactStreamDiagnostic(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|key|authorization|signature)(["'\s:=]+)[^\s"'&}]+/gi, "$1$2[REDACTED]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function streamErrorMessage(err: unknown, fallback: string): string {
  return redactStreamDiagnostic(err instanceof Error && err.message ? err.message : fallback);
}

interface RequestBody {
  threadId: string;
  body: string;
  /** Client-generated stable id used to deduplicate retries/reconnects. */
  clientTurnId?: string;
  context?: unknown;
  attachments?: string[];
  /** Optional cuid — the canvas the operator is currently viewing.
   * Validated to belong to the same workspace as the thread before
   * being injected into the system prompt. */
  canvasId?: string;
  /** Optional placeholder ChatMessage id the client created to host
   * attachment uploads. Deleted server-side after we re-target the
   * uploads at the real USER row this route persists. */
  pendingMessageId?: string;
}

const STREAM_CHECKPOINT_MS = 500;
const STREAM_HEARTBEAT_MS = 10_000;

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    },
  );
}

function readContextSnapshot(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Prisma.InputJsonObject;
}

type PreparedHermesSession = {
  client: HermesSessionsClient;
  capabilities: HermesNegotiatedCapabilities;
  mapping: {
    id: string;
    externalSessionId: string;
    memoryKey: string;
  };
};

async function prepareHermesSession(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  runtimeId: string;
  runtimeEndpoint: string;
  runtimeSecret: string | null;
  threadId: string;
  threadTitle: string | null;
  model: string | null;
  requestTimeoutSeconds: number;
}): Promise<PreparedHermesSession> {
  const client = makeHermesSessionsClient({
    baseUrl: input.runtimeEndpoint,
    token: input.runtimeSecret,
    requestTimeoutMs: input.requestTimeoutSeconds * 1_000,
  });
  const capabilities = await client.negotiateCapabilities();
  if (!capabilities.sessions || !capabilities.streaming || !capabilities.protocolVersion) {
    throw new Error(
      "This Hermes runtime does not advertise the native Sessions streaming contract required for interactive chat.",
    );
  }

  const existing = await db.connectorSession.findUnique({
    where: {
      chatThreadId_connectorKey: {
        chatThreadId: input.threadId,
        connectorKey: HERMES_SESSIONS_CONNECTOR_KEY,
      },
    },
  });
  const memoryKey =
    existing?.memoryKey ??
    buildHermesMemoryKey({
      runtimeId: input.runtimeId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      chatThreadId: input.threadId,
    });
  const deterministicSessionId = `forge_${memoryKey.split(":").at(-1)!.slice(0, 48)}`;
  let externalSessionId =
    existing?.runtimeId === input.runtimeId
      ? existing.externalSessionId
      : deterministicSessionId;

  try {
    if (existing?.runtimeId === input.runtimeId) {
      await client.getSession(externalSessionId, memoryKey);
    } else {
      const created = await client.createSession({
        sessionId: deterministicSessionId,
        title: input.threadTitle,
        model: input.model,
        memoryKey,
        idempotencyKey: `forge-session:${input.threadId}`,
      });
      externalSessionId = created.id;
    }
  } catch (error) {
    const missing =
      error && typeof error === "object" && "status" in error && error.status === 404;
    if (!missing) throw error;
    const created = await client.createSession({
      sessionId: deterministicSessionId,
      title: input.threadTitle,
      model: input.model,
      memoryKey,
      idempotencyKey: `forge-session:${input.threadId}`,
    });
    externalSessionId = created.id;
  }

  const now = new Date();
  const priorCapabilities =
    existing?.capabilities &&
    typeof existing.capabilities === "object" &&
    !Array.isArray(existing.capabilities)
      ? (existing.capabilities as Prisma.JsonObject)
      : {};
  const mergedCapabilities = {
    ...capabilities,
    ...(typeof priorCapabilities.platformProtocolVersion === "string"
      ? {
          platformProtocolVersion: priorCapabilities.platformProtocolVersion,
          proactiveDelivery: priorCapabilities.proactiveDelivery === true,
          orderedDelivery: priorCapabilities.orderedDelivery === true,
          statusEvents: priorCapabilities.statusEvents === true,
          toolEvents: priorCapabilities.toolEvents === true,
          attribution: priorCapabilities.attribution === true,
        }
      : {}),
  };
  const mapping = await db.connectorSession.upsert({
    where: {
      chatThreadId_connectorKey: {
        chatThreadId: input.threadId,
        connectorKey: HERMES_SESSIONS_CONNECTOR_KEY,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      runtimeId: input.runtimeId,
      agentId: input.agentId,
      chatThreadId: input.threadId,
      connectorKey: HERMES_SESSIONS_CONNECTOR_KEY,
      externalSessionId,
      memoryKey,
      lifecycle: ConnectorSessionLifecycle.ACTIVE,
      protocolVersion: capabilities.protocolVersion,
      capabilities: mergedCapabilities as unknown as Prisma.InputJsonValue,
      negotiatedAt: now,
      lastConnectedAt: now,
    },
    update: {
      runtimeId: input.runtimeId,
      agentId: input.agentId,
      externalSessionId,
      memoryKey,
      lifecycle: ConnectorSessionLifecycle.ACTIVE,
      protocolVersion: capabilities.protocolVersion,
      capabilities: mergedCapabilities as unknown as Prisma.InputJsonValue,
      negotiatedAt: now,
      negotiationError: null,
      lastConnectedAt: now,
      lastError: null,
      lastErrorAt: null,
      retryCount: 0,
      nextRetryAt: null,
      closedAt: null,
    },
    select: { id: true, externalSessionId: true, memoryKey: true },
  });
  return { client, capabilities, mapping };
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let parsed: RequestBody;
  try {
    parsed = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const threadId = String(parsed.threadId ?? "").trim();
  const body = String(parsed.body ?? "");
  const requestedAttachmentIds = Array.isArray(parsed.attachments)
    ? parsed.attachments.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (!threadId || (!body.trim() && requestedAttachmentIds.length === 0)) {
    return NextResponse.json(
      { error: "threadId and a message or attachment are required" },
      { status: 400 },
    );
  }
  if (body.length > 8000) {
    return NextResponse.json({ error: "body exceeds 8000 chars" }, { status: 400 });
  }
  const clientTurnId =
    typeof parsed.clientTurnId === "string" && parsed.clientTurnId.trim().length > 0
      ? parsed.clientTurnId.trim().slice(0, 100)
      : randomUUID();
  const contextSnapshot = {
    ...readContextSnapshot(parsed.context),
    clientTurnId,
  } as Prisma.InputJsonObject;
  const canvasId =
    typeof parsed.canvasId === "string" && parsed.canvasId.length > 0 ? parsed.canvasId : null;

  // Owner + workspace scoping. We do this before opening the stream so
  // unauthorised requests get a clean 4xx instead of an empty SSE.
  const thread = await db.chatThread.findFirst({
    where: { id: threadId, userId, archivedAt: null },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          profileKey: true,
          provider: true,
          runEngine: true,
          webhookUrl: true,
          templateMarkdown: true,
          capabilities: true,
          runtime: {
            select: {
              id: true,
              adapterKey: true,
              endpoint: true,
              secret: true,
              kind: true,
              config: true,
              disabledAt: true,
              name: true,
              lastProbeAttempted: true,
              lastProbeReachable: true,
              lastProbeDetail: true,
            },
          },
        },
      },
    },
  });
  if (!thread) {
    return NextResponse.json({ error: "Chat thread not found" }, { status: 404 });
  }
  const workspaceId = thread.workspaceId;
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const agent = thread.agent;
  // Per-thread overrides win over the agent's default provider/model.
  const effectiveProvider = thread.providerOverride ?? agent.provider;
  const effectiveModel = thread.modelOverride ?? undefined;
  const yoloModeOverride = thread.yoloModeOverride ?? undefined;
  // Interactive Hermes traffic has its own native Sessions contract. RUNS
  // remains the issue/background execution lane and is never selected here
  // for Hermes, even when Agent.runEngine is RUNS for dispatch purposes.
  const runEngine = resolveRunEngine({
    runEngine: agent.runEngine,
    provider: effectiveProvider,
    runtime: agent.runtime,
  });
  // Honor a managed runtime's gateway endpoint when one is configured;
  // falls back to the env gateway otherwise (see getRunsConnectorForAgent).
  const runsConnector = getRunsConnectorForAgent({
    provider: effectiveProvider,
    runtime: agent.runtime,
  });
  const useHermesSessions =
    effectiveProvider === "HERMES" &&
    agent.runtime?.adapterKey === "hermes" &&
    Boolean(agent.runtime.id && agent.runtime.endpoint) &&
    !agent.runtime.disabledAt;
  const useRuns =
    effectiveProvider !== "HERMES" && runEngine === "RUNS" && runsConnector != null;

  if (effectiveProvider === "HERMES" && !useHermesSessions) {
    return NextResponse.json(
      {
        error:
          "Interactive Hermes chat requires a bound, enabled Hermes runtime with native Sessions support. /v1/runs is reserved for background issue execution.",
      },
      { status: 503 },
    );
  }

  let hermesSession: PreparedHermesSession | null = null;
  let connectorRetrySettings = { maxAttempts: 6, initialSeconds: 2, maxSeconds: 300 };
  if (useHermesSessions && agent.runtime?.id && agent.runtime.endpoint) {
    const connectorSettings = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        connectorRequestTimeoutSeconds: true,
        connectorDeliveryMaxAttempts: true,
        connectorRetryInitialSeconds: true,
        connectorRetryMaxSeconds: true,
      },
    });
    if (connectorSettings) {
      connectorRetrySettings = {
        maxAttempts: connectorSettings.connectorDeliveryMaxAttempts,
        initialSeconds: connectorSettings.connectorRetryInitialSeconds,
        maxSeconds: connectorSettings.connectorRetryMaxSeconds,
      };
    }
    try {
      hermesSession = await prepareHermesSession({
        workspaceId,
        userId,
        agentId: agent.id,
        runtimeId: agent.runtime.id,
        runtimeEndpoint: agent.runtime.endpoint,
        runtimeSecret: agent.runtime.secret,
        threadId: thread.id,
        threadTitle: thread.title,
        model: effectiveModel ?? null,
        requestTimeoutSeconds: connectorSettings?.connectorRequestTimeoutSeconds ?? 15,
      });
    } catch (error) {
      const diagnostic = redactConnectorDiagnostic(error);
      await db.connectorSession.updateMany({
        where: {
          workspaceId,
          chatThreadId: thread.id,
          connectorKey: HERMES_SESSIONS_CONNECTOR_KEY,
        },
        data: {
          lifecycle: ConnectorSessionLifecycle.ERROR,
          negotiationError: diagnostic,
          lastError: diagnostic,
          lastErrorAt: new Date(),
        },
      });
      return NextResponse.json({ error: diagnostic }, { status: 502 });
    }
  }

  // Resolve how this agent's chat is actually served. When it's `dispatch`
  // (no server model — answered by the agent's runtime/daemon via chat drafts
  // on the CHAT_MESSAGE_POSTED event), the route must NOT also run a server
  // loop: it persists the USER row + emits the event (below) and closes the
  // stream, letting the daemon reply. This keeps the readiness banner, the
  // header chip, and the actual behaviour in agreement (and avoids a
  // double-reply / "no model" error for local CLI + ACP agents).
  const daemonLinked =
    !useRuns &&
    (await db.apiKey.count({
      where: { workspaceId, linkedAgentId: agent.id, revokedAt: null },
    })) > 0;
  const transport = resolveChatReadiness({
    provider: effectiveProvider,
    runEngine: agent.runEngine,
    runtime: agent.runtime,
    webhookUrl: agent.webhookUrl,
    runtimeKind: agent.runtime?.kind ?? null,
    daemonLinked,
    providerAvailable: await workspaceChatProviderAvailability(db, workspaceId),
  });
  const useDispatch = !useRuns && !useHermesSessions && transport.mode === "dispatch";

  // Resolve + verify attachments before opening the stream so we don't
  // leave a half-written user message if one points outside the workspace.
  // Only image attachments are passed to the model as vision blocks today;
  // anything else is persisted on the message but skipped from the prompt.
  const attachmentRows = requestedAttachmentIds.length
    ? await db.attachment.findMany({
        where: {
          id: { in: requestedAttachmentIds },
          workspaceId,
          NOT: { url: { startsWith: "pending:" } },
        },
      })
    : [];
  if (!body.trim() && attachmentRows.length === 0) {
    return NextResponse.json({ error: "No accessible attachments were provided" }, { status: 400 });
  }
  const imageBlocks: ChatStreamContentBlock[] = [];
  for (const a of attachmentRows) {
    const mime = (a.mimeType ?? "").toLowerCase();
    if (a.kind === "LINK") {
      if (!a.externalUrl) continue;
      // Heuristic: treat any LINK whose URL points at an image-ish path
      // as a vision block. Anything else is silently skipped — the model
      // still sees the file name via the persisted attachment row but
      // doesn't get the bytes.
      if (/\.(png|jpe?g|gif|webp|svg)(?:\?|#|$)/i.test(a.externalUrl)) {
        imageBlocks.push({
          type: "image_url",
          image_url: { url: a.externalUrl },
          filename: a.linkTitle ?? a.filename ?? "image",
        });
      }
      continue;
    }
    if (!mime.startsWith("image/")) continue;
    try {
      const presigned = await presignDownloadUrl(a.id);
      imageBlocks.push({
        type: "image_url",
        image_url: { url: presigned.url },
        filename: a.filename,
      });
    } catch (err) {
      logger.warn(
        { err, attachmentId: a.id, threadId: thread.id },
        "chat-stream: failed to presign image attachment; skipping",
      );
    }
  }
  if (!body.trim() && imageBlocks.length === 0) {
    return NextResponse.json(
      { error: "A text message is required when no supported image is attached." },
      { status: 400 },
    );
  }
  if (imageBlocks.length > 0 && !transport.capabilities.vision) {
    return NextResponse.json(
      { error: `${transport.transportLabel} does not support image input.` },
      { status: 400 },
    );
  }
  if (imageBlocks.length > 0 && hermesSession && !hermesSession.capabilities.attachments) {
    return NextResponse.json(
      {
        error:
          "This Hermes Sessions contract does not explicitly advertise attachments. Remove the image or upgrade the connector.",
      },
      { status: 400 },
    );
  }
  const hermesMessage: string | Array<Record<string, unknown>> =
    imageBlocks.length > 0
      ? [
          ...(body.trim() ? [{ type: "input_text", text: body }] : []),
          ...imageBlocks.flatMap((image) =>
            image.type === "image_url"
              ? [{ type: "input_image", image_url: image.image_url.url }]
              : [],
          ),
        ]
      : body;

  // Persist the USER row and the audit/event in one transaction. Mirrors
  // `chat.send` so the inbox lifecycle stays honest. Forge-owned streaming
  // turns tag the payload `streamed: true` so the dispatch worker can no-op
  // and avoid a duplicate reply; dispatch-backed turns leave it false so the
  // addressed daemon/runtime is actually woken. Any resolved attachments get
  // re-targeted at the new ChatMessage so the thread surface (and getThread
  // reads) see them attached to the right turn — the upload flow targets
  // `chat-message` placeholders by id, but streaming uploads at the composer
  // happen *before* the message row exists, so we point them at this row here.
  const attachmentIds = attachmentRows.map((a) => a.id);
  const agentStartedAt = new Date();
  const persistedTurn = await db.$transaction(async (tx) => {
    // A JSON field cannot carry a unique constraint without a migration, so
    // serialize retries for this thread/client id with a transaction-scoped
    // advisory lock before looking up or creating the turn.
    // Serialize every writer for this thread so the durable sequence remains
    // gap-safe even when separate browser tabs submit different turn ids.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${thread.id}))`;
    const existingUser = await tx.chatMessage.findFirst({
      where: {
        workspaceId,
        threadId: thread.id,
        role: ChatRole.USER,
        contextSnapshot: { path: ["clientTurnId"], equals: clientTurnId },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existingUser) {
      const existingAgent = useDispatch
        ? null
        : await tx.chatMessage.findFirst({
            where: {
              workspaceId,
              threadId: thread.id,
              role: ChatRole.AGENT,
              contextSnapshot: { path: ["turnId"], equals: clientTurnId },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, body: true, contextSnapshot: true },
          });
      if (attachmentIds.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: attachmentIds }, workspaceId },
          data: { targetType: "chat-message", targetId: existingUser.id },
        });
      }
      if (
        typeof parsed.pendingMessageId === "string" &&
        parsed.pendingMessageId.length > 0 &&
        parsed.pendingMessageId !== existingUser.id
      ) {
        await tx.chatMessage.deleteMany({
          where: {
            id: parsed.pendingMessageId,
            workspaceId,
            threadId: thread.id,
            role: ChatRole.USER,
            dispatchedAt: null,
          },
        });
      }
      const existingSnapshot = jsonObject(existingAgent?.contextSnapshot);
      if (
        existingAgent &&
        existingSnapshot.retryable === true &&
        existingSnapshot.running !== true &&
        typeof existingSnapshot.runExternalId !== "string"
      ) {
        const {
          error: _error,
          finishedAt: _finishedAt,
          retryable: _retryable,
          ...retainedSnapshot
        } = existingSnapshot;
        const revived = await tx.chatMessage.update({
          where: { id: existingAgent.id },
          data: {
            body: "",
            outputStartedAt: agentStartedAt,
            contextSnapshot: {
              ...retainedSnapshot,
              running: true,
              status: "running",
              startedAt: agentStartedAt.toISOString(),
              streamUpdatedAt: agentStartedAt.toISOString(),
            } as Prisma.InputJsonObject,
          },
          select: { id: true, body: true, contextSnapshot: true },
        });
        await tx.chatMessage.update({
          where: { id: existingUser.id },
          data: { acknowledgedAt: agentStartedAt, outputStartedAt: agentStartedAt },
        });
        return {
          userMessageId: existingUser.id,
          agentMessageId: revived.id,
          existingAgent: revived,
          reused: false,
        };
      }
      return {
        userMessageId: existingUser.id,
        agentMessageId: existingAgent?.id ?? null,
        existingAgent,
        reused: true,
      };
    }

    const now = new Date();
    const sequenceAggregate = await tx.chatMessage.aggregate({
      where: { workspaceId, threadId: thread.id },
      _max: { sequence: true },
    });
    const userSequence = (sequenceAggregate._max.sequence ?? 0) + 1;
    await tx.chatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: now },
    });
    const message = await tx.chatMessage.create({
      data: {
        workspaceId,
        threadId: thread.id,
        role: ChatRole.USER,
        body,
        contextSnapshot,
        dispatchedAt: now,
        sequence: userSequence,
        connectorSessionId: hermesSession?.mapping.id ?? null,
      },
    });
    const placeholder = useDispatch
      ? null
      : await tx.chatMessage.create({
          data: {
            workspaceId,
            threadId: thread.id,
            role: ChatRole.AGENT,
            body: "",
            outputStartedAt: agentStartedAt,
            sequence: userSequence + 1,
            replyToMessageId: message.id,
            connectorSessionId: hermesSession?.mapping.id ?? null,
            contextSnapshot: {
              streamed: true,
              turnId: clientTurnId,
              replyToMessageId: message.id,
              running: true,
              status: "running",
              startedAt: agentStartedAt.toISOString(),
              streamUpdatedAt: agentStartedAt.toISOString(),
            },
          },
          select: { id: true, body: true, contextSnapshot: true },
        });
    if (placeholder) {
      await tx.chatMessage.update({
        where: { id: message.id },
        data: { acknowledgedAt: agentStartedAt, outputStartedAt: agentStartedAt },
      });
    }
    if (attachmentIds.length > 0) {
      await tx.attachment.updateMany({
        where: { id: { in: attachmentIds }, workspaceId },
        data: { targetType: "chat-message", targetId: message.id },
      });
    }
    // Drop the operator-supplied placeholder if it's still hanging around.
    // Guarded by `dispatchedAt: null` so we never delete a real row.
    if (
      typeof parsed.pendingMessageId === "string" &&
      parsed.pendingMessageId.length > 0 &&
      parsed.pendingMessageId !== message.id
    ) {
      await tx.chatMessage.deleteMany({
        where: {
          id: parsed.pendingMessageId,
          workspaceId,
          threadId: thread.id,
          role: ChatRole.USER,
          dispatchedAt: null,
        },
      });
    }
    await recordChange(tx, {
      workspaceId,
      actorId: userId,
      entity: "ChatMessage",
      entityId: message.id,
      action: "create",
      eventKind: EventKind.CHAT_MESSAGE_POSTED,
      subjectType: "chat-thread",
      subjectId: thread.id,
      payload: {
        threadId: thread.id,
        messageId: message.id,
        agentId: agent.id,
        role: "USER",
        body,
        context: contextSnapshot,
        streamed: !useDispatch,
        attachments: attachmentRows.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          kind: a.kind,
          externalUrl: a.externalUrl,
        })) as unknown as Prisma.InputJsonArray,
      },
    });
    if (hermesSession) {
      await tx.connectorDelivery.create({
        data: {
          workspaceId,
          connectorSessionId: hermesSession.mapping.id,
          direction: ConnectorDeliveryDirection.OUTBOUND,
          externalEventId: clientTurnId,
          kind: "user.message",
          status: ConnectorDeliveryStatus.PROCESSING,
          chatMessageId: message.id,
          attempt: 1,
          lastAttemptAt: now,
          payload: {
            threadId: thread.id,
            messageId: message.id,
            body,
            message: hermesMessage as unknown as Prisma.InputJsonValue,
            instructions: systemPrompt,
            model: effectiveModel ?? null,
            attachmentIds,
          } as Prisma.InputJsonObject,
        },
      });
    }
    return {
      userMessageId: message.id,
      agentMessageId: placeholder?.id ?? null,
      existingAgent: null,
      reused: false,
    };
  });
  const { userMessageId } = persistedTurn;

  if (persistedTurn.reused) {
    const existingSnapshot = jsonObject(persistedTurn.existingAgent?.contextSnapshot);
    const running = existingSnapshot.running === true;
    return streamResponse([
      sse("meta", {
        userMessageId,
        agentMessageId: persistedTurn.agentMessageId,
        messageId: persistedTurn.agentMessageId,
        clientTurnId,
        deduplicated: true,
        running,
        snapshot: existingSnapshot,
      }),
      ...(!running && persistedTurn.existingAgent?.body
        ? [sse("content", { delta: persistedTurn.existingAgent.body, replay: true })]
        : []),
      ...(!running
        ? [
            sse("done", {
              messageId: persistedTurn.agentMessageId,
              deduplicated: true,
              running: false,
            }),
          ]
        : []),
    ]);
  }

  if (useDispatch) {
    return streamResponse([
      sse("meta", {
        userMessageId,
        dispatch: true,
        transport: transport.transportLabel,
      }),
      sse("done", { userMessageId, dispatch: true }),
    ]);
  }

  // Non-dispatch turns create their durable placeholder in the same
  // transaction as the USER row, so a process crash cannot strand an
  // idempotency key between the user turn and its reply state.
  const agentMessageId = persistedTurn.agentMessageId;
  if (!agentMessageId) {
    return NextResponse.json({ error: "Failed to initialize chat turn" }, { status: 500 });
  }

  const prepared = await (async () => {
    // Load recent history *after* the USER row is persisted so it appears in
    // the context array we send to the provider. Take last 20 chronological,
    // including the just-inserted user message.
    const recent = await db.chatMessage.findMany({
      where: {
        workspaceId,
        threadId: thread.id,
        ...(persistedTurn.agentMessageId ? { id: { not: persistedTurn.agentMessageId } } : {}),
        OR: [{ role: { not: ChatRole.USER } }, { dispatchedAt: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { role: true, body: true },
    });
    const history = recent.reverse();

    // Resolve the canvas binding once up-front so an invalid id fails fast
    // (rather than silently dropping the binding mid-stream).
    let boundCanvasId: string | null = null;
    if (canvasId) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: canvasId, workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (canvas) boundCanvasId = canvas.id;
    }

    const baseSystemPrompt =
      `You are ${agent.name}. You're chatting with the operator inside Forge, a project ` +
      `management workspace. Be concise and direct. ` +
      (agent.capabilities && agent.capabilities.length > 0
        ? `Your capabilities: ${agent.capabilities.join(", ")}.\n\n`
        : "") +
      (agent.templateMarkdown ? `${agent.templateMarkdown}\n` : "");

    const buildSystemPrompt = async (): Promise<string> => {
      if (!boundCanvasId) return baseSystemPrompt;
      const canvasSummary = await loadCanvasContextSummary(workspaceId, boundCanvasId);
      const storyboardHint =
        `When the operator asks you to lay out, storyboard, sketch, ` +
        `organize, or "set up a canvas for" something, reach for the ` +
        `compound MCP gestures:\n` +
        `- \`canvases.storyboardPlan({ planId })\` — labeled frame with ` +
        `the plan card + notes lane + sources column + next-steps lane.\n` +
        `- \`canvases.storyboardIssue({ issueId })\` — labeled frame ` +
        `with the issue card + related + comments + attachments.\n` +
        `- \`canvases.storyboardResearch({ topic })\` — labeled frame ` +
        `with a scratchpad + sources column + next-steps lane.\n` +
        `- \`canvases.storyboardCustom({ name, panels })\` — escape ` +
        `hatch when the three presets don't fit. Provide a panels[] ` +
        `array of \`{ label, body?, x, y, width, height }\`.\n` +
        `One storyboard call is the grammar — don't scatter 25 floating ` +
        `nodes by hand.`;
      if (!canvasSummary) return `${baseSystemPrompt}\n\n${storyboardHint}`;
      return `${baseSystemPrompt}\n\n${canvasSummary}\n\n${storyboardHint}`;
    };
    const systemPrompt = await buildSystemPrompt();

    // Build the model-facing message array. History rows stay plain text —
    // we only attach image blocks to the *latest* user turn, which is the
    // one we just persisted. (Historical attachments aren't replayed; the
    // model already saw them in their original turn.)
    const messages: ChatStreamMessage[] = [{ role: "system", content: systemPrompt }];
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      const isLatest = i === history.length - 1;
      const role: "user" | "assistant" = m.role === ChatRole.USER ? "user" : "assistant";
      if (isLatest && role === "user" && imageBlocks.length > 0) {
        const blocks: ChatStreamContentBlock[] = [];
        if (m.body) blocks.push({ type: "text", text: m.body });
        blocks.push(...imageBlocks);
        messages.push({ role, content: blocks });
      } else {
        messages.push({ role, content: m.body });
      }
    }
    return { boundCanvasId, buildSystemPrompt, history, messages, systemPrompt };
  })().catch(async (err) => {
    const failedAt = new Date().toISOString();
    const message = streamErrorMessage(err, "Failed to prepare the chat turn.");
    await db.chatMessage
      .update({
        where: { id: agentMessageId },
        data: {
          body: "(The chat turn could not be prepared. Retry to try again.)",
          contextSnapshot: {
            streamed: true,
            turnId: clientTurnId,
            replyToMessageId: userMessageId,
            running: false,
            status: "failed",
            error: message,
            retryable: true,
            startedAt: agentStartedAt.toISOString(),
            finishedAt: failedAt,
            streamUpdatedAt: failedAt,
          },
        },
      })
      .catch(() => undefined);
    logger.warn({ err, threadId: thread.id, agentMessageId }, "chat-stream: preparation failed");
    return null;
  });
  if (!prepared) {
    return NextResponse.json({ error: "Failed to prepare chat turn" }, { status: 500 });
  }
  const { boundCanvasId, buildSystemPrompt, history, messages, systemPrompt } = prepared;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed */
        }
      };
      void (async () => {
        enqueue(
          sse("meta", {
            messageId: agentMessageId,
            agentMessageId,
            userMessageId,
            turnId: clientTurnId,
            acknowledgedAt: agentStartedAt.toISOString(),
            outputStartedAt: agentStartedAt.toISOString(),
          }),
        );

        const assembled: string[] = [];
        const thinkingChunks: string[] = [];
        type ToolCallRecord = {
          id: string;
          name: string;
          args: Record<string, unknown>;
          status: "pending" | "approved" | "declined" | "executed" | "error";
          requiresConfirm: boolean;
          summary?: string;
          result?: unknown;
        };
        const toolCalls: ToolCallRecord[] = [];
        const startedAt = Date.now();
        let usage:
          | { tokensIn?: number; tokensOut?: number; tokensCached?: number; costUsd?: number }
          | undefined;
        let errored = false;
        let streamError: string | null = null;
        let streamFinishing = false;
        // Track approval ids we registered so we can clean them up on abort.
        const registeredApprovalIds = new Set<string>();

        const abortController = new AbortController();
        // Provider-side run id when streaming via the RUNS engine — lets the
        // Stop button interrupt the live Hermes run, not just the local read.
        let runExternalId: string | null = null;
        let hermesExternalMessageId: string | null = null;
        let clientDetached = false;
        let stopObserved = false;
        let stopPollBusy = false;
        let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
        let lastCheckpointAt = 0;
        let checkpointChain = Promise.resolve();

        const writeCheckpoint = async () => {
          const now = new Date();
          lastCheckpointAt = now.getTime();
          try {
            await db.chatMessage.updateMany({
              where: {
                id: agentMessageId,
                contextSnapshot: { path: ["running"], equals: true },
              },
              data: {
                body: assembled.join(""),
                contextSnapshot: {
                  streamed: true,
                  turnId: clientTurnId,
                  replyToMessageId: userMessageId,
                  provider: effectiveProvider,
                  model: effectiveModel ?? undefined,
                  yoloModeOverride,
                  running: true,
                  status: "running",
                  startedAt: agentStartedAt.toISOString(),
                  streamUpdatedAt: now.toISOString(),
                  runExternalId: runExternalId ?? undefined,
                  partial_text: assembled.join("") || undefined,
                  thinking: thinkingChunks.join("") || undefined,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  usage,
                  clientDetached: clientDetached || undefined,
                } as never,
              },
            });
            await publish({
              id: randomUUID(),
              workspaceId,
              kind: EventKind.CHAT_MESSAGE_POSTED,
              subjectType: "chat-thread-state",
              subjectId: thread.id,
              payload: {
                phase: "progress",
                threadId: thread.id,
                messageId: agentMessageId,
                turnId: clientTurnId,
                updatedAt: now.toISOString(),
              },
              actorId: null,
              createdAt: now.toISOString(),
            });
          } catch (err) {
            logger.warn(
              { err, threadId: thread.id, agentMessageId },
              "chat-stream: checkpoint failed",
            );
          }
        };
        const queueCheckpoint = (force = false) => {
          const waitMs = Math.max(0, STREAM_CHECKPOINT_MS - (Date.now() - lastCheckpointAt));
          if (!force && checkpointTimer) return;
          const queue = () => {
            checkpointTimer = null;
            checkpointChain = checkpointChain.then(writeCheckpoint);
          };
          if (force || waitMs === 0) queue();
          else checkpointTimer = setTimeout(queue, waitMs);
        };
        const flushCheckpoint = async () => {
          if (checkpointTimer) clearTimeout(checkpointTimer);
          checkpointTimer = null;
          checkpointChain = checkpointChain.then(writeCheckpoint);
          await checkpointChain;
        };
        const heartbeat = setInterval(() => queueCheckpoint(true), STREAM_HEARTBEAT_MS);
        const stopPoll = setInterval(() => {
          if (stopPollBusy || stopObserved) return;
          stopPollBusy = true;
          void getChatStreamStopRequest(agentMessageId)
            .then(async (request) => {
              if (!request || stopObserved) return;
              stopObserved = true;
              if (!request.remoteHandled && runExternalId && runsConnector?.stop) {
                try {
                  await runsConnector.stop(runExternalId);
                  await requestChatStreamStop(agentMessageId, true);
                } catch (err) {
                  stopObserved = false;
                  const stopFailedAt = new Date().toISOString();
                  const existing = await db.chatMessage.findUnique({
                    where: { id: agentMessageId },
                    select: { contextSnapshot: true },
                  });
                  const existingSnapshot = jsonObject(existing?.contextSnapshot);
                  delete existingSnapshot.stoppedAt;
                  delete existingSnapshot.finishedAt;
                  await db.chatMessage.update({
                    where: { id: agentMessageId },
                    data: {
                      contextSnapshot: {
                        ...existingSnapshot,
                        stopped: false,
                        running: true,
                        status: "running",
                        stopFailedAt,
                        stopError: "Runtime rejected the stop request.",
                        streamUpdatedAt: stopFailedAt,
                      } as never,
                    },
                  });
                  await clearChatStreamStop(agentMessageId);
                  await publish({
                    id: randomUUID(),
                    workspaceId,
                    kind: EventKind.CHAT_MESSAGE_POSTED,
                    subjectType: "chat-thread-state",
                    subjectId: thread.id,
                    payload: {
                      phase: "stop-failed",
                      threadId: thread.id,
                      messageId: agentMessageId,
                    },
                    actorId: userId,
                    createdAt: stopFailedAt,
                  }).catch(() => undefined);
                  enqueue(
                    sse("error", {
                      message: "The runtime rejected the stop request; the reply is still running.",
                    }),
                  );
                  logger.warn(
                    { err, threadId: thread.id, agentMessageId, runExternalId },
                    "chat-stream: delayed runtime stop failed",
                  );
                  return;
                }
              }
              abortController.abort();
            })
            .catch((err) => {
              logger.warn(
                { err, threadId: thread.id, agentMessageId },
                "chat-stream: stop relay failed",
              );
            })
            .finally(() => {
              stopPollBusy = false;
            });
        }, 750);
        const onAbort = () => {
          // A browser/SSE disconnect is not the same as "stop the agent".
          // Navigation, React remounts, proxy hiccups, retries, and tab
          // sleeps all abort the fetch. Keep the provider run alive and keep
          // this server task subscribed so the final answer is still persisted
          // and other tabs refresh through the durable CHAT_MESSAGE_POSTED
          // event. Explicit user stops go through /api/chat/stream/stop.
          clientDetached = true;
          queueCheckpoint(true);
        };
        req.signal.addEventListener("abort", onAbort);

        const recordCall = (call: ChatToolCall): ToolCallRecord => {
          const existing = toolCalls.find((c) => c.id === call.id);
          if (existing) return existing;
          const fresh: ToolCallRecord = {
            id: call.id,
            name: call.name,
            args: call.args,
            status: "pending",
            requiresConfirm: findChatTool(call.name)?.requiresConfirm ?? true,
          };
          toolCalls.push(fresh);
          queueCheckpoint();
          return fresh;
        };

        const registerApproval = async (callId: string) => {
          registeredApprovalIds.add(callId);
          await registerPendingChatApproval({
            callId,
            workspaceId,
            userId,
            threadId: thread.id,
            messageId: agentMessageId,
            createdAt: new Date().toISOString(),
          });
        };

        const waitForApproval = async (callId: string) => {
          try {
            return await waitForPendingChatApproval(callId, abortController.signal);
          } finally {
            registeredApprovalIds.delete(callId);
            await clearPendingChatApproval(callId).catch(() => undefined);
          }
        };

        const runOneTool = async (call: ChatToolCall): Promise<ChatToolExecResult> => {
          const record = recordCall(call);
          const def = findChatTool(call.name);
          const displayName = def?.name ?? call.name;
          const requiresConfirm = def?.requiresConfirm ?? true;

          if (!def) {
            const summary = `Tool ${call.name} is not on the chat allowlist.`;
            record.status = "error";
            record.summary = summary;
            queueCheckpoint();
            enqueue(sse("tool_result", { id: call.id, ok: false, summary }));
            return { ok: false, summary };
          }

          enqueue(
            sse("tool_call_started", {
              id: call.id,
              name: displayName,
              args: call.args,
              requiresConfirm,
            }),
          );

          if (requiresConfirm) {
            await registerApproval(call.id);
            enqueue(
              sse("tool_confirm", {
                id: call.id,
                name: displayName,
                args: call.args,
              }),
            );
            const decision = await waitForApproval(call.id);
            if (!decision.approved) {
              const summary = "User declined this action.";
              record.status = "declined";
              record.summary = summary;
              queueCheckpoint(true);
              enqueue(sse("tool_result", { id: call.id, ok: false, summary }));
              return { ok: false, summary };
            }
            record.status = "approved";
            queueCheckpoint(true);
          }

          const exec = await executeChatTool({
            workspaceId,
            userId,
            name: displayName,
            args: call.args,
          });
          record.status = exec.ok ? "executed" : "error";
          record.summary = exec.summary;
          record.result = exec.result;
          queueCheckpoint();
          enqueue(
            sse("tool_result", {
              id: call.id,
              ok: exec.ok,
              summary: exec.summary,
              result: exec.result,
            }),
          );
          return exec;
        };

        const streamViaHermesSessions = async () => {
          if (!hermesSession) throw new Error("Hermes session mapping was not prepared.");
          let completedFinalText: string | null = null;
          const persistEvent = async (event: HermesSessionEvent) => {
            const externalEventId = hermesSessionExternalEventId(event);
            const inserted = await db.connectorDelivery.createMany({
              data: [
                {
                  workspaceId,
                  connectorSessionId: hermesSession.mapping.id,
                  direction: ConnectorDeliveryDirection.INBOUND,
                  externalEventId,
                  sequence: event.sequence,
                  kind: event.name,
                  status: ConnectorDeliveryStatus.DELIVERED,
                  payload: event.data as Prisma.InputJsonObject,
                  deliveredAt: new Date(),
                },
              ],
              skipDuplicates: true,
            });
            if (inserted.count === 0) return false;
            const now = new Date();
            await db.connectorSession.update({
              where: { id: hermesSession.mapping.id },
              data: {
                lifecycle: ConnectorSessionLifecycle.ACTIVE,
                ...(event.sessionId && event.sessionId !== hermesSession.mapping.externalSessionId
                  ? { externalSessionId: event.sessionId }
                  : {}),
                lastExternalSequence: event.sequence,
                lastEventAt: now,
                lastDeliveryAt: now,
                lastError: null,
                lastErrorAt: null,
              },
            });
            return true;
          };

          try {
            for await (const event of hermesSession.client.streamMessage({
              sessionId: hermesSession.mapping.externalSessionId,
              memoryKey: hermesSession.mapping.memoryKey,
              message: hermesMessage,
              instructions: systemPrompt,
              model: effectiveModel,
              idempotencyKey: clientTurnId,
              signal: abortController.signal,
            })) {
              if (!(await persistEvent(event))) continue;
              if (event.messageId) hermesExternalMessageId = event.messageId;
              const eventData = event.data;
              switch (event.name) {
                case "assistant.delta": {
                  const delta = typeof eventData.delta === "string" ? eventData.delta : "";
                  if (delta) {
                    assembled.push(delta);
                    queueCheckpoint();
                    enqueue(sse("content", { delta }));
                  }
                  break;
                }
                case "tool.progress": {
                  const delta = typeof eventData.delta === "string" ? eventData.delta : "";
                  const toolName =
                    typeof eventData.tool_name === "string" ? eventData.tool_name : "tool";
                  if (delta && toolName === "_thinking") {
                    thinkingChunks.push(delta);
                    queueCheckpoint();
                    enqueue(sse("thinking", { delta }));
                  }
                  break;
                }
                case "tool.started": {
                  const id = event.messageId ?? `session_tool_${event.sequence ?? toolCalls.length}`;
                  const name =
                    typeof eventData.tool_name === "string" ? eventData.tool_name : "tool";
                  if (!toolCalls.some((call) => call.id === id)) {
                    toolCalls.push({
                      id,
                      name,
                      args:
                        eventData.args && typeof eventData.args === "object"
                          ? (eventData.args as Record<string, unknown>)
                          : {},
                      status: "pending",
                      requiresConfirm: false,
                    });
                  }
                  queueCheckpoint();
                  enqueue(sse("tool_call_started", { id, name, args: eventData.args ?? {} }));
                  break;
                }
                case "tool.completed":
                case "tool.failed": {
                  const name =
                    typeof eventData.tool_name === "string" ? eventData.tool_name : "tool";
                  const rec = [...toolCalls].reverse().find((call) => call.name === name);
                  if (rec) rec.status = event.name === "tool.completed" ? "executed" : "error";
                  queueCheckpoint();
                  if (rec) {
                    enqueue(
                      sse("tool_result", {
                        id: rec.id,
                        ok: event.name === "tool.completed",
                        summary: event.name === "tool.completed" ? "done" : "failed",
                      }),
                    );
                  }
                  break;
                }
                case "assistant.completed": {
                  if (typeof eventData.content === "string" && eventData.content) {
                    completedFinalText = eventData.content;
                  }
                  break;
                }
                case "run.completed": {
                  const rawUsage =
                    eventData.usage && typeof eventData.usage === "object"
                      ? (eventData.usage as Record<string, unknown>)
                      : {};
                  usage = {
                    tokensIn:
                      typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : undefined,
                    tokensOut:
                      typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : undefined,
                    tokensCached:
                      typeof rawUsage.cache_read_tokens === "number"
                        ? rawUsage.cache_read_tokens
                        : undefined,
                  };
                  queueCheckpoint();
                  break;
                }
                case "error": {
                  errored = true;
                  streamError = redactStreamDiagnostic(
                    typeof eventData.message === "string"
                      ? eventData.message
                      : "Hermes session stream failed.",
                  );
                  queueCheckpoint(true);
                  enqueue(sse("error", { message: streamError }));
                  break;
                }
              }
            }
            if (assembled.length === 0 && completedFinalText) {
              assembled.push(completedFinalText);
              enqueue(sse("content", { delta: completedFinalText }));
            }
            await db.connectorDelivery.updateMany({
              where: {
                connectorSessionId: hermesSession.mapping.id,
                direction: ConnectorDeliveryDirection.OUTBOUND,
                externalEventId: clientTurnId,
              },
              data: {
                status: ConnectorDeliveryStatus.DELIVERED,
                deliveredAt: new Date(),
                lastError: null,
              },
            });
          } catch (error) {
            const diagnostic = redactConnectorDiagnostic(error);
            const now = new Date();
            const retry = connectorRetryDecision({
              attempt: 1,
              maxAttempts: connectorRetrySettings.maxAttempts,
              initialSeconds: connectorRetrySettings.initialSeconds,
              maxSeconds: connectorRetrySettings.maxSeconds,
              now,
            });
            await db.$transaction([
              db.connectorSession.update({
                where: { id: hermesSession.mapping.id },
                data: {
                  lifecycle: abortController.signal.aborted
                    ? ConnectorSessionLifecycle.DISCONNECTED
                    : ConnectorSessionLifecycle.ERROR,
                  lastError: diagnostic,
                  lastErrorAt: now,
                  retryCount: { increment: 1 },
                  nextRetryAt: retry.nextAttemptAt,
                },
              }),
              db.connectorDelivery.updateMany({
                where: {
                  connectorSessionId: hermesSession.mapping.id,
                  direction: ConnectorDeliveryDirection.OUTBOUND,
                  externalEventId: clientTurnId,
                },
                data: {
                  status: retry.deadLetter
                    ? ConnectorDeliveryStatus.DEAD_LETTER
                    : ConnectorDeliveryStatus.RETRY_SCHEDULED,
                  lastError: diagnostic,
                  lastAttemptAt: now,
                  nextAttemptAt: retry.nextAttemptAt,
                },
              }),
            ]);
            throw error;
          }
        };

        // RUNS engine: delegate the whole turn to the provider's structured
        // agent-run API and map its normalized events onto the SAME SSE
        // vocabulary the client already speaks (content/thinking/tool_*/
        // error) — so the client needs no changes and chat still streams
        // token-by-token (via `message.delta`). Tools + approvals run on the
        // provider side; an `approval_required` event surfaces as a
        // tool_confirm card and our reply is POSTed back to the run.
        const streamViaRuns = async () => {
          const runtimePolicy = buildRuntimePolicySnapshot({
            contractVersion: FORGE_RUN_CONTRACT_VERSION,
            engagementMode: "DISCUSS",
            adapterKey:
              agent.runtime?.adapterKey ?? (effectiveProvider === "HERMES" ? "hermes" : null),
            runtimeName: agent.runtime?.name ?? null,
            config: agent.runtime?.config,
          });
          const priorTurns = history.slice(0, -1).map((m) => ({
            role:
              m.role === ChatRole.USER
                ? ("user" as const)
                : m.role === ChatRole.SYSTEM
                  ? ("system" as const)
                  : ("assistant" as const),
            content: m.body,
          }));
          try {
            const started = await runsConnector!.startRun({
              message: body,
              history: priorTurns,
              instructions: systemPrompt,
              model: effectiveModel,
              yoloMode: yoloModeOverride,
              engagementMode: "DISCUSS",
              contractVersion: FORGE_RUN_CONTRACT_VERSION,
              toolPolicy: runtimePolicy,
              sessionKey: agent.profileKey,
              runtimeProfile: agent.profileKey,
            });
            runExternalId = started.externalRunId;
            await flushCheckpoint();
            enqueue(sse("meta", { messageId: agentMessageId, agentMessageId, runExternalId }));
          } catch (err) {
            errored = true;
            streamError = streamErrorMessage(err, "Failed to start run.");
            logger.warn(
              { err, threadId: thread.id, agentId: agent.id },
              "chat-stream: failed to start runtime run",
            );
            enqueue(
              sse("error", {
                message: streamError,
              }),
            );
            return;
          }
          const externalRunId = runExternalId;
          const toolIdsByName = new Map<string, string[]>();
          let toolSeq = 0;
          let approvalSeq = 0;
          // The gateway only emits `message.delta` events when the agent's
          // turn actually streams. Tool-heavy turns (or a non-streaming model
          // response) deliver the full answer ONLY in `run.completed.output`.
          // Capture it so we can fall back when no deltas arrived — otherwise
          // the reply persists empty as "(no response — provider stream
          // errored)" even though the run succeeded.
          let completedFinalText: string | null = null;
          await runsConnector!.subscribe(
            externalRunId,
            (e) => {
              switch (e.type) {
                case "content_delta":
                  assembled.push(e.delta);
                  queueCheckpoint();
                  enqueue(sse("content", { delta: e.delta }));
                  break;
                case "thinking":
                  thinkingChunks.push(e.text);
                  queueCheckpoint();
                  enqueue(sse("thinking", { delta: e.text }));
                  break;
                case "tool_started": {
                  const providerCallId =
                    "callId" in e && typeof e.callId === "string" ? e.callId : null;
                  const id = providerCallId ?? `run_tool_${++toolSeq}`;
                  const queued = toolIdsByName.get(e.tool) ?? [];
                  queued.push(id);
                  toolIdsByName.set(e.tool, queued);
                  toolCalls.push({
                    id,
                    name: e.tool,
                    args: {},
                    status: "pending",
                    requiresConfirm: false,
                  });
                  queueCheckpoint();
                  enqueue(
                    sse("tool_call_started", {
                      id,
                      name: e.tool,
                      args: e.preview ? { preview: e.preview } : {},
                      requiresConfirm: false,
                    }),
                  );
                  break;
                }
                case "tool_completed": {
                  const providerCallId =
                    "callId" in e && typeof e.callId === "string" ? e.callId : null;
                  const queued = toolIdsByName.get(e.tool) ?? [];
                  const id = providerCallId ?? queued.shift();
                  if (providerCallId) {
                    const index = queued.indexOf(providerCallId);
                    if (index >= 0) queued.splice(index, 1);
                  }
                  if (queued.length > 0) toolIdsByName.set(e.tool, queued);
                  else toolIdsByName.delete(e.tool);
                  const rec = toolCalls.find((c) => c.id === id);
                  if (rec) rec.status = e.isError ? "error" : "executed";
                  queueCheckpoint();
                  if (id) {
                    enqueue(
                      sse("tool_result", {
                        id,
                        ok: !e.isError,
                        summary: e.isError ? "failed" : "done",
                      }),
                    );
                  }
                  break;
                }
                case "approval_required": {
                  const providerCallId =
                    "callId" in e && typeof e.callId === "string" ? e.callId : null;
                  const id = providerCallId ?? `run_approval_${++approvalSeq}`;
                  // Hermes approvals gate dangerous shell commands — the
                  // payload carries `command` + a risk `description`, not a
                  // tool name. Title the card with the command.
                  const cmd =
                    typeof e.raw.command === "string" ? e.raw.command : (e.tool ?? "approval");
                  const label = cmd.length > 64 ? `${cmd.slice(0, 61)}…` : cmd;
                  const existingRecord = toolCalls.find((call) => call.id === id);
                  const approvalRecord: ToolCallRecord = existingRecord ?? {
                    id,
                    name: label,
                    args: e.raw,
                    status: "pending",
                    requiresConfirm: true,
                  };
                  Object.assign(approvalRecord, {
                    name: label,
                    args: e.raw,
                    status: "pending" as const,
                    requiresConfirm: true,
                    summary: "Waiting for operator approval.",
                  });
                  if (!existingRecord) toolCalls.push(approvalRecord);
                  queueCheckpoint(true);
                  // Resolve out-of-band — Hermes holds the run open until we
                  // respond. Approve → allow once; decline → STOP the run
                  // (a bare "deny" leaves the agent blocked indefinitely per
                  // the gateway's approval semantics, so we interrupt it).
                  void (async () => {
                    await registerApproval(id);
                    enqueue(
                      sse("tool_call_started", {
                        id,
                        name: label,
                        args: e.raw,
                        requiresConfirm: true,
                      }),
                    );
                    enqueue(sse("tool_confirm", { id, name: label, args: e.raw }));
                    const d = await waitForApproval(id);
                    approvalRecord.status = d.approved ? "approved" : "declined";
                    approvalRecord.summary = d.approved
                      ? "Approved by operator."
                      : "Declined by operator; run stopped.";
                    queueCheckpoint(true);
                    enqueue(
                      sse("tool_result", {
                        id,
                        ok: d.approved,
                        summary: d.approved ? "approved" : "declined — run stopped",
                      }),
                    );
                    return d.approved
                      ? runsConnector!.approve?.(externalRunId, "once")
                      : runsConnector!.stop?.(externalRunId);
                  })().catch((err) => {
                    if (streamFinishing) return;
                    errored = true;
                    streamError = streamErrorMessage(err, "Approval failed.");
                    approvalRecord.status = "error";
                    approvalRecord.summary = streamError;
                    queueCheckpoint(true);
                    enqueue(sse("error", { message: streamError }));
                  });
                  break;
                }
                case "error":
                  errored = true;
                  streamError = redactStreamDiagnostic(e.message);
                  queueCheckpoint(true);
                  logger.warn(
                    { threadId: thread.id, agentId: agent.id, externalRunId, message: streamError },
                    "chat-stream: runtime run emitted error",
                  );
                  enqueue(sse("error", { message: streamError }));
                  break;
                case "approval_resolved":
                  // Confirmation that a pending approval was resolved (our UI
                  // drives the normal case; this also covers resolution by
                  // another client). No further action needed here.
                  break;
                case "completed":
                  if (typeof e.finalText === "string" && e.finalText.length > 0) {
                    completedFinalText = e.finalText;
                  }
                  if (
                    "usage" in e &&
                    e.usage &&
                    typeof e.usage === "object" &&
                    !Array.isArray(e.usage)
                  ) {
                    const terminalUsage = e.usage as Record<string, unknown>;
                    usage = {
                      tokensIn:
                        typeof terminalUsage.tokensIn === "number"
                          ? terminalUsage.tokensIn
                          : undefined,
                      tokensOut:
                        typeof terminalUsage.tokensOut === "number"
                          ? terminalUsage.tokensOut
                          : undefined,
                      tokensCached:
                        typeof terminalUsage.tokensCached === "number"
                          ? terminalUsage.tokensCached
                          : undefined,
                      costUsd:
                        typeof terminalUsage.costUsd === "number"
                          ? terminalUsage.costUsd
                          : undefined,
                    };
                    queueCheckpoint();
                  }
                  break;
                case "usage":
                  usage = {
                    tokensIn: e.tokensIn,
                    tokensOut: e.tokensOut,
                    tokensCached: e.tokensCached,
                    costUsd: e.costUsd,
                  };
                  queueCheckpoint();
                  break;
                case "stopped": {
                  stopObserved = true;
                  enqueue(sse("stopped", { reason: e.reason ?? "Runtime stopped." }));
                  queueCheckpoint(true);
                  break;
                }
              }
            },
            abortController.signal,
          );

          // Fallback: the run finished but streamed no text deltas (tool-only
          // turn, or a non-streaming model response). Emit the run's final
          // output so the client renders it and it persists, rather than
          // leaking an empty bubble / a spurious "provider stream errored".
          if (assembled.length === 0 && completedFinalText) {
            assembled.push(completedFinalText);
            enqueue(sse("content", { delta: completedFinalText }));
          }
          // Last resort: the SSE stream can end without ever delivering the
          // final text — a missed terminal event, or a `run.completed` that
          // carried no `output`. Poll the run once for its persisted output so
          // a real reply isn't lost to a dropped stream (a frequent cause of
          // "the agent never answered" with a blank bubble).
          if (
            assembled.length === 0 &&
            !completedFinalText &&
            !abortController.signal.aborted &&
            runsConnector?.getStatus
          ) {
            try {
              const st = await runsConnector.getStatus(externalRunId);
              if (st.output && st.output.trim()) {
                assembled.push(st.output);
                enqueue(sse("content", { delta: st.output }));
              }
            } catch (err) {
              logger.warn({ err, externalRunId }, "chat-stream: getStatus output fallback failed");
            }
          }
        };

        try {
          if (useHermesSessions && hermesSession) {
            await streamViaHermesSessions();
          } else if (useRuns && runsConnector) {
            await streamViaRuns();
          } else if (useDispatch) {
            // The agent's runtime/daemon owns this turn — it replies via chat
            // drafts on the CHAT_MESSAGE_POSTED event already emitted above. Run
            // no server loop: leave `assembled` empty so the placeholder AGENT
            // row is cleaned up below, and let the daemon's draft arrive over
            // realtime (the thinking/wake indicator covers the gap). This keeps
            // local CLI + ACP agents from erroring with "no model".
          } else {
            await runChatLoop({
              provider: effectiveProvider,
              model: effectiveModel,
              messages,
              tools: chatToolsAsOpenAITools(),
              signal: abortController.signal,
              // Per-workspace ProviderCredential (DB) over env; null → env fallback.
              resolvedClient: await resolveWorkspaceProviderClient(
                db,
                workspaceId,
                providerIdFor(effectiveProvider),
              ),
              rebuildSystemPrompt: boundCanvasId ? async () => buildSystemPrompt() : undefined,
              onContent: (delta) => {
                assembled.push(delta);
                queueCheckpoint();
                enqueue(sse("content", { delta }));
              },
              onThinking: (delta) => {
                thinkingChunks.push(delta);
                queueCheckpoint();
                enqueue(sse("thinking", { delta }));
              },
              onToolUseStart: (call) => {
                recordCall(call);
              },
              onError: (message) => {
                errored = true;
                streamError = redactStreamDiagnostic(message);
                queueCheckpoint(true);
                enqueue(sse("error", { message: streamError }));
              },
              executeToolCall: runOneTool,
            });
          }
        } catch (err) {
          if (!stopObserved) {
            errored = true;
            const message = streamErrorMessage(err, "Stream failed.");
            streamError = message;
            queueCheckpoint(true);
            enqueue(sse("error", { message }));
            logger.warn({ err, threadId: thread.id }, "chat-stream: route bridge failed");
          }
        } finally {
          req.signal.removeEventListener("abort", onAbort);
        }

        streamFinishing = true;
        clearInterval(heartbeat);
        clearInterval(stopPoll);
        if (checkpointTimer) clearTimeout(checkpointTimer);
        checkpointTimer = null;
        await checkpointChain;
        const beforeFinal = await db.chatMessage.findUnique({
          where: { id: agentMessageId },
          select: { contextSnapshot: true },
        });
        const currentSnapshot = jsonObject(beforeFinal?.contextSnapshot);
        const wasStopped =
          stopObserved ||
          currentSnapshot.stopped === true ||
          currentSnapshot.status === "stopped" ||
          typeof currentSnapshot.stoppedAt === "string";
        if (registeredApprovalIds.size > 0) {
          abortController.abort();
          await Promise.all(
            Array.from(registeredApprovalIds, (id) =>
              clearPendingChatApproval(id).catch(() => undefined),
            ),
          );
          registeredApprovalIds.clear();
        }
        await clearChatStreamStop(agentMessageId).catch(() => undefined);

        const finalBody = assembled.join("");
        const thinkingFull = thinkingChunks.join("");
        const elapsedMs = Date.now() - startedAt;

        // Persist the AGENT row's final body + rehydration blocks. Even on
        // error we want the row populated (or removed) so the UI doesn't
        // leak an empty bubble. If the model produced nothing and we hit
        // an error, prefer a clear apology body over a blank row.
        // Decide the body we persist. A turn can do real work (tool calls)
        // yet stream no assistant text — Hermes sometimes ends a turn right
        // after tool execution, and a dropped/aborted stream lands here too.
        // Persisting "" leaves a blank bubble that reads as a failed chat, so
        // whenever we keep the row, give it an accurate, non-empty body.
        let persistedBody = finalBody;
        if (!persistedBody) {
          if (wasStopped) {
            persistedBody = "_(Reply stopped.)_";
          } else if (errored) {
            persistedBody = "(no response — provider stream errored; check logs)";
          } else if (abortController.signal.aborted) {
            if (thinkingFull || toolCalls.length > 0) {
              persistedBody = "_(Reply interrupted before it finished.)_";
            }
          } else if (toolCalls.length > 0) {
            const names = Array.from(new Set(toolCalls.map((c) => c.name))).join(", ");
            persistedBody = `_(The agent ran ${toolCalls.length} tool call${
              toolCalls.length === 1 ? "" : "s"
            }${names ? ` — ${names}` : ""} but returned no message.)_`;
          } else if (thinkingFull) {
            persistedBody = "_(The agent finished without a message.)_";
          }
        }

        try {
          if (!persistedBody && !thinkingFull && toolCalls.length === 0 && !wasStopped) {
            // Nothing to keep — clean up the empty placeholder.
            await db.chatMessage.delete({ where: { id: agentMessageId } });
          } else {
            await db.chatMessage.update({
              where: { id: agentMessageId },
              data: {
                body: persistedBody,
                replyToMessageId: userMessageId,
                externalMessageId: hermesExternalMessageId,
                connectorSessionId: hermesSession?.mapping.id ?? undefined,
                contextSnapshot: {
                  ...currentSnapshot,
                  streamed: true,
                  turnId: clientTurnId,
                  replyToMessageId: userMessageId,
                  provider: effectiveProvider,
                  model: effectiveModel ?? undefined,
                  yoloModeOverride,
                  thinking: thinkingFull || undefined,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  error: streamError ?? undefined,
                  aborted: abortController.signal.aborted || wasStopped || undefined,
                  stopped: wasStopped || undefined,
                  clientDetached: clientDetached || undefined,
                  runExternalId: runExternalId ?? undefined,
                  connectorSessionId: hermesSession?.mapping.id ?? undefined,
                  externalSessionId: hermesSession?.mapping.externalSessionId ?? undefined,
                  protocolVersion: hermesSession?.capabilities.protocolVersion ?? undefined,
                  usage,
                  running: false,
                  status: wasStopped ? "stopped" : errored ? "failed" : "completed",
                  startedAt: agentStartedAt.toISOString(),
                  finishedAt: new Date().toISOString(),
                  streamUpdatedAt: new Date().toISOString(),
                  elapsedMs,
                } as never,
              },
            });
            await db.chatThread.update({
              where: { id: thread.id },
              data: { lastMessageAt: new Date() },
            });
            // Emit CHAT_MESSAGE_POSTED for the persisted AGENT reply so other
            // browser tabs (and the threads-list invalidator) refresh.
            await recordChange(db, {
              workspaceId,
              actorId: null,
              entity: "ChatMessage",
              entityId: agentMessageId,
              action: "create",
              eventKind: EventKind.CHAT_MESSAGE_POSTED,
              subjectType: "chat-thread",
              subjectId: thread.id,
              payload: {
                threadId: thread.id,
                messageId: agentMessageId,
                agentId: agent.id,
                role: "AGENT",
                streamed: true,
                attachments: [] as Prisma.InputJsonArray,
              },
            });
            const terminalAt = new Date().toISOString();
            await publish({
              id: randomUUID(),
              workspaceId,
              kind: EventKind.CHAT_MESSAGE_POSTED,
              subjectType: "chat-thread-state",
              subjectId: thread.id,
              payload: {
                phase: wasStopped ? "stopped" : errored ? "failed" : "completed",
                threadId: thread.id,
                messageId: agentMessageId,
                turnId: clientTurnId,
              },
              actorId: null,
              createdAt: terminalAt,
            });
          }
        } catch (err) {
          logger.warn({ err, threadId: thread.id }, "chat-stream: failed to persist agent reply");
        }

        enqueue(sse("done", { messageId: agentMessageId }));
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      })().catch((err) => {
        const message = streamErrorMessage(err, "Stream failed.");
        logger.warn({ err, threadId: thread.id }, "chat-stream: unhandled stream task failure");
        enqueue(sse("error", { message }));
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
