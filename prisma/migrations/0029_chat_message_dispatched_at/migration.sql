-- Add an explicit dispatch marker so chat messages with attachments can be
-- created first, have their Attachment rows finalized, and only then emit
-- CHAT_MESSAGE_POSTED to agent dispatch subscribers.
ALTER TABLE "ChatMessage" ADD COLUMN "dispatchedAt" TIMESTAMP(3);

-- Existing user messages were all created via the immediate send path before
-- deferred dispatch existed; mark them as already dispatched for idempotency.
UPDATE "ChatMessage"
SET "dispatchedAt" = "createdAt"
WHERE "role" = 'USER' AND "dispatchedAt" IS NULL;

CREATE INDEX "ChatMessage_threadId_dispatchedAt_idx" ON "ChatMessage"("threadId", "dispatchedAt");
