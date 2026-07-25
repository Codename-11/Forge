export type ForgePrismaLogLevel = "query" | "warn" | "error";

export function prismaLogLevels(env: NodeJS.ProcessEnv): ForgePrismaLogLevel[] {
  if (env.FORGE_LOG_PRISMA_QUERIES === "1") return ["query", "warn", "error"];
  if (env.NODE_ENV === "development") return ["warn", "error"];
  return ["error"];
}
