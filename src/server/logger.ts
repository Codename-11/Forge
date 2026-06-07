import "server-only";
import pino from "pino";

const prettyLogs = process.env.FORGE_PRETTY_LOGS === "1";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "forge" },
  transport: prettyLogs ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});
