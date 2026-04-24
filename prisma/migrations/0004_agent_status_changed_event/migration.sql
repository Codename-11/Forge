-- Add AGENT_STATUS_CHANGED to the EventKind enum so the heartbeat-driven
-- auto-offline worker can emit a typed activity event when it flips an
-- agent to OFFLINE. Idempotent via IF NOT EXISTS so re-runs on a DB that
-- was hand-patched are harmless.
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_STATUS_CHANGED';
