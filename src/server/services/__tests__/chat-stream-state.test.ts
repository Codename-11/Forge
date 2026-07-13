import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingChatApproval,
  getPendingChatApproval,
  registerPendingChatApproval,
  resolvePendingChatApproval,
  waitForPendingChatApproval,
} from "@/server/services/chat-stream-state";

const ids: string[] = [];

afterEach(async () => {
  await Promise.all(ids.splice(0).map((id) => clearPendingChatApproval(id)));
});

const describeRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRedis("chat stream approval relay", () => {
  it("durably delivers a decision that arrives before the waiter", async () => {
    const callId = randomUUID();
    ids.push(callId);
    await registerPendingChatApproval({
      callId,
      workspaceId: "workspace",
      userId: "user",
      threadId: "thread",
      messageId: "message",
      createdAt: new Date().toISOString(),
    });
    expect(await getPendingChatApproval(callId)).toMatchObject({ callId, userId: "user" });

    expect(await resolvePendingChatApproval(callId, { approved: true })).toBe(true);
    await expect(waitForPendingChatApproval(callId)).resolves.toEqual({ approved: true });
    expect(await resolvePendingChatApproval(callId, { approved: false })).toBe(false);
  });
});
