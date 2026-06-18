-- Add an executable action request kind for one-time runtime host-tool grants.
ALTER TYPE "ActionRequestKind" ADD VALUE IF NOT EXISTS 'RUNTIME_TOOL_GRANT';
