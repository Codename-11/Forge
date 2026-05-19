-- Per-user preferred Mission Control tab. Null = "live" (current default).
-- Values: "live" | "queue" | "agents" | "history" | "chat".
ALTER TABLE "User" ADD COLUMN "missionControlDefaultTab" TEXT;
