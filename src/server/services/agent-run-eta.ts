import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

export async function medianRunDurationMs(
  tx: Tx,
  params: { workspaceId: string; agentId: string; labelId?: string | null },
): Promise<{ medianMs: number; sampleSize: number } | null> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const where: Prisma.AgentRunWhereInput = {
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    status: "COMPLETED",
    finishedAt: { gte: since, not: null },
    startedAt: { not: undefined as never },
  };
  if (params.labelId) {
    where.issue = { is: { labels: { some: { labelId: params.labelId } } } };
  }
  const runs = await tx.agentRun.findMany({
    where,
    select: { startedAt: true, finishedAt: true },
    take: 200,
  });
  const durations = runs
    .map(r => (r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null))
    .filter((d): d is number => d != null && d > 0)
    .sort((a, b) => a - b);
  if (durations.length < 5) return null;
  const mid = Math.floor(durations.length / 2);
  const median =
    durations.length % 2 === 0
      ? (durations[mid - 1]! + durations[mid]!) / 2
      : durations[mid]!;
  return { medianMs: median, sampleSize: durations.length };
}
