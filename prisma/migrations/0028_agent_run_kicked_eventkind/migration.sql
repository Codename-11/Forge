-- Add AGENT_RUN_KICKED to the EventKind enum so the operator-driven
-- "kick a stalled run" action can record an audit/event row distinct
-- from the existing AGENT_RUN_CONTROL_REQUESTED family. Kick doesn't
-- change assignment or controlState — it just re-fires the dispatch
-- webhook for the issue, which is a different intent worth its own
-- kind so timeline filters can show it specifically.
ALTER TYPE "EventKind" ADD VALUE IF NOT EXISTS 'AGENT_RUN_KICKED';
