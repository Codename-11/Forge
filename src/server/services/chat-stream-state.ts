import "server-only";
import { redis } from "@/server/redis";
import { logger } from "@/server/logger";

export type ChatApprovalDecision = { approved: boolean };

export type PendingChatApproval = {
  callId: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  messageId: string;
  createdAt: string;
};

const APPROVAL_TTL_SECONDS = 15 * 60;
const DECISION_TTL_SECONDS = 60;

function pendingKey(callId: string): string {
  return `forge:chat-approval:pending:${callId}`;
}

function decisionKey(callId: string): string {
  return `forge:chat-approval:decision:${callId}`;
}

function stopKey(messageId: string): string {
  return `forge:chat-stream:stop:${messageId}`;
}

export async function requestChatStreamStop(
  messageId: string,
  remoteHandled = false,
): Promise<void> {
  await redis.set(
    stopKey(messageId),
    JSON.stringify({ requestedAt: new Date().toISOString(), remoteHandled }),
    "EX",
    5 * 60,
  );
}

export async function getChatStreamStopRequest(
  messageId: string,
): Promise<{ remoteHandled: boolean } | null> {
  const raw = await redis.get(stopKey(messageId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { remoteHandled?: unknown };
    return { remoteHandled: value.remoteHandled === true };
  } catch {
    return { remoteHandled: false };
  }
}

export async function clearChatStreamStop(messageId: string): Promise<void> {
  await redis.del(stopKey(messageId));
}

/**
 * Same-process fast path. Redis remains the source of truth so an approval
 * POST can land on any web instance while the streaming request waits on
 * another one.
 */
const localResolvers = new Map<string, (decision: ChatApprovalDecision) => void>();
const localPending = new Map<string, PendingChatApproval>();

export async function registerPendingChatApproval(approval: PendingChatApproval): Promise<void> {
  localResolvers.delete(approval.callId);
  localPending.set(approval.callId, approval);
  try {
    await redis.set(
      pendingKey(approval.callId),
      JSON.stringify(approval),
      "EX",
      APPROVAL_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn(
      { err, callId: approval.callId },
      "chat approval Redis registration failed; using local fallback",
    );
  }
}

export async function getPendingChatApproval(callId: string): Promise<PendingChatApproval | null> {
  let raw: string | null = null;
  try {
    raw = await redis.get(pendingKey(callId));
  } catch (err) {
    logger.warn({ err, callId }, "chat approval Redis lookup failed; using local fallback");
  }
  if (!raw) return localPending.get(callId) ?? null;
  try {
    return JSON.parse(raw) as PendingChatApproval;
  } catch {
    return null;
  }
}

export async function resolvePendingChatApproval(
  callId: string,
  decision: ChatApprovalDecision,
): Promise<boolean> {
  let claimed = false;
  try {
    // Atomically claim and queue the request so two browser tabs cannot
    // resolve it differently, and no process can observe a claimed request
    // before its durable decision exists.
    const moved = await redis.eval(
      `local pending = redis.call('GET', KEYS[1])
       if not pending then return 0 end
       redis.call('DEL', KEYS[1])
       redis.call('LPUSH', KEYS[2], ARGV[1])
       redis.call('EXPIRE', KEYS[2], ARGV[2])
       return 1`,
      2,
      pendingKey(callId),
      decisionKey(callId),
      JSON.stringify(decision),
      String(DECISION_TTL_SECONDS),
    );
    claimed = moved === 1;
  } catch (err) {
    logger.warn({ err, callId }, "chat approval Redis resolution failed; using local fallback");
  }

  if (!claimed && !localPending.has(callId)) return false;
  localPending.delete(callId);

  const local = localResolvers.get(callId);
  if (local) {
    localResolvers.delete(callId);
    local(decision);
  }
  return true;
}

export async function waitForPendingChatApproval(
  callId: string,
  signal?: AbortSignal,
): Promise<ChatApprovalDecision> {
  const blocking = redis.duplicate({ maxRetriesPerRequest: null });
  let settled = false;

  return new Promise<ChatApprovalDecision>((resolve, reject) => {
    const finish = (decision: ChatApprovalDecision) => {
      if (settled) return;
      settled = true;
      localResolvers.delete(callId);
      signal?.removeEventListener("abort", onAbort);
      void blocking.quit().catch(() => blocking.disconnect());
      resolve(decision);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      localResolvers.delete(callId);
      signal?.removeEventListener("abort", onAbort);
      blocking.disconnect();
      reject(err);
    };
    const onAbort = () => fail(new DOMException("Approval wait aborted", "AbortError"));

    localResolvers.set(callId, finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    void blocking
      .brpop(decisionKey(callId), APPROVAL_TTL_SECONDS)
      .then((row) => {
        if (!row) {
          fail(new Error("Approval request expired."));
          return;
        }
        try {
          finish(JSON.parse(row[1]) as ChatApprovalDecision);
        } catch (err) {
          fail(err);
        }
      })
      .catch((err) => {
        // Preserve a safe local fallback when Redis is transiently
        // unavailable. The same-node POST can still resolve the promise.
        logger.warn({ err, callId }, "chat approval Redis wait failed; using local fallback");
      });
  });
}

export async function clearPendingChatApproval(callId: string): Promise<void> {
  localResolvers.delete(callId);
  localPending.delete(callId);
  await redis.del(pendingKey(callId), decisionKey(callId)).catch(() => undefined);
}
