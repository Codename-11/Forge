-- Pomodoro prompts + Email-to-issue ingest stub (Run B of 2).
--
-- Two unrelated surfaces in one migration:
--   * User.pomodoro* — per-user toggle and durations for the timer
--     widget's break-prompt behavior. Defaults match the canonical
--     25/5 cadence; admins/users can tune. Only consulted when the
--     time-tracker is actually running.
--   * Workspace.emailIngest* — toggle + HMAC secret for the
--     `/api/ingest/email` endpoint. Off by default. Endpoint refuses
--     writes when disabled or when the signature doesn't match.

-- ---------------------------------------------------------------------------
-- User pomodoro columns
-- ---------------------------------------------------------------------------
ALTER TABLE "User"
  ADD COLUMN "pomodoroEnabled"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pomodoroMinutes"      INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "pomodoroBreakMinutes" INTEGER NOT NULL DEFAULT 5;

-- ---------------------------------------------------------------------------
-- Workspace email-ingest columns
-- ---------------------------------------------------------------------------
ALTER TABLE "Workspace"
  ADD COLUMN "emailIngestEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emailIngestSecret"  TEXT;
