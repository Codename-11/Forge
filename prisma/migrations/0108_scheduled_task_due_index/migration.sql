-- Support the global worker sweep, which filters enabled tasks and orders by nextRunAt.
CREATE INDEX "ScheduledTask_enabled_nextRunAt_idx"
  ON "ScheduledTask"("enabled", "nextRunAt");
