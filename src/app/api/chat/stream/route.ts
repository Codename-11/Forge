import { NextResponse, type NextRequest } from "next/server";
import { ChatRole, EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import {
  runChatLoop,
  type ChatStreamContentBlock,
  type ChatStreamMessage,
  type ChatToolCall,
  type ChatToolExecResult,
} from "@/server/services/chat-stream";
import {
  chatToolsAsOpenAITools,
  findChatTool,
} from "@/server/services/chat-tools-allowlist";
import { executeChatTool } from "@/server/services/chat-tool-exec";
import { pendingApprovals } from "@/server/services/chat-stream-state";
import { resolveRunEngine, getRunsConnector } from "@/server/services/dispatch/registry";
import { loadCanvasContextSummary } from "@/server/services/chat-context-canvas";
import { presignDownloadUrl } from "@/server/services/storage";
import { logger } from "@/server/logger";

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

interface RequestBody {
  threadId: string;
  body: string;
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
  if (!threadId || !body.trim()) {
    return NextResponse.json(
      { error: "threadId and non-empty body are required" },
      { status: 400 },
    );
  }
  if (body.length > 8000) {
    return NextResponse.json({ error: "body exceeds 8000 chars" }, { status: 400 });
  }
  const canvasId =
    typeof parsed.canvasId === "string" && parsed.canvasId.length > 0
      ? parsed.canvasId
      : null;

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
          templateMarkdown: true,
          capabilities: true,
        },
      },
    },
  });
  if (!thread) {
    return NextResponse.json({ error: "Chat thread not found" }, { status: 404 });
  }
  const workspaceId = thread.workspaceId;
  const agent = thread.agent;
  // Per-thread overrides win over the agent's default provider/model.
  const effectiveProvider = thread.providerOverride ?? agent.provider;
  const effectiveModel = thread.modelOverride ?? undefined;
  // Resolve the chat engine. RUNS delegates to the provider's structured
  // agent-run API (Hermes /v1/runs) instead of Forge's own completions
  // loop; falls back to completions when the provider has no runs connector.
  const runEngine = resolveRunEngine({
    runEngine: agent.runEngine,
    provider: effectiveProvider,
  });
  const runsConnector = getRunsConnector(effectiveProvider);
  const useRuns = runEngine === "RUNS" && runsConnector != null;

  // Resolve + verify attachments before opening the stream so we don't
  // leave a half-written user message if one points outside the workspace.
  // Only image attachments are passed to the model as vision blocks today;
  // anything else is persisted on the message but skipped from the prompt.
  const requestedAttachmentIds = Array.isArray(parsed.attachments)
    ? parsed.attachments.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const attachmentRows = requestedAttachmentIds.length
    ? await db.attachment.findMany({
        where: {
          id: { in: requestedAttachmentIds },
          workspaceId,
          NOT: { url: { startsWith: "pending:" } },
        },
      })
    : [];
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

  // Persist the USER row and the audit/event in one transaction. Mirrors
  // `chat.send` so the inbox lifecycle stays honest, but tags the payload
  // `streamed: true` so the dispatch worker can no-op for this row. Any
  // resolved attachments get re-targeted at the new ChatMessage so the
  // thread surface (and getThread reads) see them attached to the right
  // turn — the upload flow targets `chat-message` placeholders by id, but
  // streaming uploads at the composer happen *before* the message row
  // exists, so we point them at this row here.
  const attachmentIds = attachmentRows.map((a) => a.id);
  const { userMessageId } = await db.$transaction(async (tx) => {
    const now = new Date();
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
        contextSnapshot: {} as never,
        dispatchedAt: now,
      },
    });
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
        streamed: true,
        attachments: attachmentRows.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          kind: a.kind,
          externalUrl: a.externalUrl,
        })) as unknown as Prisma.InputJsonArray,
      },
    });
    return { userMessageId: message.id };
  });

  // Load recent history *after* the USER row is persisted so it appears in
  // the context array we send to the provider. Take last 20 chronological,
  // including the just-inserted user message.
  const recent = await db.chatMessage.findMany({
    where: {
      workspaceId,
      threadId: thread.id,
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
  const messages: ChatStreamMessage[] = [
    { role: "system", content: systemPrompt },
  ];
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

  // Create the placeholder AGENT row up front so the client gets a stable
  // messageId in the `meta` event — we fill its `body` + `contextSnapshot`
  // after the stream finishes (or aborts).
  const placeholder = await db.chatMessage.create({
    data: {
      workspaceId,
      threadId: thread.id,
      role: ChatRole.AGENT,
      body: "",
      outputStartedAt: new Date(),
    },
    select: { id: true },
  });
  const agentMessageId = placeholder.id;

  // Acknowledged-flag bookkeeping so the chat panel's dispatch state UI
  // transitions cleanly out of "wake-sent" when the streaming reply lands.
  void db.chatMessage
    .update({
      where: { id: userMessageId },
      data: { acknowledgedAt: new Date(), outputStartedAt: new Date() },
    })
    .catch(() => undefined);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* controller already closed */
        }
      };

      enqueue(sse("meta", { messageId: agentMessageId }));

      const assembled: string[] = [];
      const thinkingChunks: string[] = [];
      type ToolCallRecord = {
        id: string;
        name: string;
        args: Record<string, unknown>;
        status: "pending" | "approved" | "declined" | "executed" | "error";
        summary?: string;
        result?: unknown;
      };
      const toolCalls: ToolCallRecord[] = [];
      const startedAt = Date.now();
      let errored = false;
      // Track approval ids we registered so we can clean them up on abort.
      const registeredApprovalIds = new Set<string>();

      const abortController = new AbortController();
      // Provider-side run id when streaming via the RUNS engine — lets the
      // Stop button interrupt the live Hermes run, not just the local read.
      let runExternalId: string | null = null;
      const onAbort = () => {
        abortController.abort();
        if (runExternalId && runsConnector?.stop) {
          void runsConnector.stop(runExternalId);
        }
        for (const id of registeredApprovalIds) {
          const resolver = pendingApprovals.get(id);
          if (resolver) {
            pendingApprovals.delete(id);
            resolver({ approved: false });
          }
        }
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
        };
        toolCalls.push(fresh);
        return fresh;
      };

      const waitForApproval = (callId: string) =>
        new Promise<{ approved: boolean }>((resolve) => {
          registeredApprovalIds.add(callId);
          pendingApprovals.set(callId, (decision) => {
            registeredApprovalIds.delete(callId);
            resolve(decision);
          });
        });

      const runOneTool = async (call: ChatToolCall): Promise<ChatToolExecResult> => {
        const record = recordCall(call);
        const def = findChatTool(call.name);
        const displayName = def?.name ?? call.name;
        const requiresConfirm = def?.requiresConfirm ?? true;

        if (!def) {
          const summary = `Tool ${call.name} is not on the chat allowlist.`;
          record.status = "error";
          record.summary = summary;
          enqueue(
            sse("tool_result", { id: call.id, ok: false, summary }),
          );
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
            enqueue(
              sse("tool_result", { id: call.id, ok: false, summary }),
            );
            return { ok: false, summary };
          }
          record.status = "approved";
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

      // RUNS engine: delegate the whole turn to the provider's structured
      // agent-run API and map its normalized events onto the SAME SSE
      // vocabulary the client already speaks (content/thinking/tool_*/
      // error) — so the client needs no changes and chat still streams
      // token-by-token (via `message.delta`). Tools + approvals run on the
      // provider side; an `approval_required` event surfaces as a
      // tool_confirm card and our reply is POSTed back to the run.
      const streamViaRuns = async () => {
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
          });
          runExternalId = started.externalRunId;
        } catch (err) {
          errored = true;
          enqueue(
            sse("error", {
              message: err instanceof Error ? err.message : "Failed to start run.",
            }),
          );
          return;
        }
        const externalRunId = runExternalId;
        const toolIdByName = new Map<string, string>();
        let toolSeq = 0;
        let approvalSeq = 0;
        await runsConnector!.subscribe(
          externalRunId,
          (e) => {
            switch (e.type) {
              case "content_delta":
                assembled.push(e.delta);
                enqueue(sse("content", { delta: e.delta }));
                break;
              case "thinking":
                thinkingChunks.push(e.text);
                enqueue(sse("thinking", { delta: e.text }));
                break;
              case "tool_started": {
                const id = `run_tool_${++toolSeq}`;
                toolIdByName.set(e.tool, id);
                toolCalls.push({ id, name: e.tool, args: {}, status: "pending" });
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
                const id = toolIdByName.get(e.tool);
                const rec = toolCalls.find((c) => c.id === id);
                if (rec) rec.status = e.isError ? "error" : "executed";
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
                const id = `run_approval_${++approvalSeq}`;
                // Hermes approvals gate dangerous shell commands — the
                // payload carries `command` + a risk `description`, not a
                // tool name. Title the card with the command.
                const cmd =
                  typeof e.raw.command === "string" ? e.raw.command : (e.tool ?? "approval");
                const label = cmd.length > 64 ? `${cmd.slice(0, 61)}…` : cmd;
                enqueue(
                  sse("tool_call_started", {
                    id,
                    name: label,
                    args: e.raw,
                    requiresConfirm: true,
                  }),
                );
                enqueue(sse("tool_confirm", { id, name: label, args: e.raw }));
                // Resolve out-of-band — Hermes holds the run open until we
                // respond. Approve → allow once; decline → STOP the run
                // (a bare "deny" leaves the agent blocked indefinitely per
                // the gateway's approval semantics, so we interrupt it).
                void waitForApproval(id).then((d) => {
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
                });
                break;
              }
              case "error":
                errored = true;
                enqueue(sse("error", { message: e.message }));
                break;
              case "approval_resolved":
                // Confirmation that a pending approval was resolved (our UI
                // drives the normal case; this also covers resolution by
                // another client). No further action needed here.
                break;
              case "usage":
              case "completed":
                break;
            }
          },
          abortController.signal,
        );
      };

      try {
        if (useRuns && runsConnector) {
          await streamViaRuns();
        } else {
          await runChatLoop({
            provider: effectiveProvider,
            model: effectiveModel,
            messages,
            tools: chatToolsAsOpenAITools(),
            signal: abortController.signal,
            rebuildSystemPrompt: boundCanvasId
              ? async () => buildSystemPrompt()
              : undefined,
            onContent: (delta) => {
              assembled.push(delta);
              enqueue(sse("content", { delta }));
            },
            onThinking: (delta) => {
              thinkingChunks.push(delta);
              enqueue(sse("thinking", { delta }));
            },
            onToolUseStart: (call) => {
              recordCall(call);
            },
            onError: (message) => {
              errored = true;
              enqueue(sse("error", { message }));
            },
            executeToolCall: runOneTool,
          });
        }
      } catch (err) {
        errored = true;
        const message = err instanceof Error ? err.message : "Stream failed.";
        enqueue(sse("error", { message }));
        logger.warn({ err, threadId: thread.id }, "chat-stream: route bridge failed");
      } finally {
        req.signal.removeEventListener("abort", onAbort);
      }

      const finalBody = assembled.join("");
      const thinkingFull = thinkingChunks.join("");
      const elapsedMs = Date.now() - startedAt;

      // Persist the AGENT row's final body + rehydration blocks. Even on
      // error we want the row populated (or removed) so the UI doesn't
      // leak an empty bubble. If the model produced nothing and we hit
      // an error, prefer a clear apology body over a blank row.
      const persistedBody =
        finalBody ||
        (errored
          ? "(no response — provider stream errored; check logs)"
          : "");

      try {
        if (!persistedBody && !thinkingFull && toolCalls.length === 0) {
          // Nothing to keep — clean up the empty placeholder.
          await db.chatMessage.delete({ where: { id: agentMessageId } });
        } else {
          await db.chatMessage.update({
            where: { id: agentMessageId },
            data: {
              body: persistedBody,
              contextSnapshot: {
                streamed: true,
                provider: effectiveProvider,
                model: effectiveModel ?? undefined,
                thinking: thinkingFull || undefined,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
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
        }
      } catch (err) {
        logger.warn(
          { err, threadId: thread.id },
          "chat-stream: failed to persist agent reply",
        );
      }

      enqueue(sse("done", { messageId: agentMessageId }));
      try {
        controller.close();
      } catch {
        /* already closed */
      }
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
