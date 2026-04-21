/**
 * Seed the AXI workspace's Agent rows (Victor + Mizu) so `issues.assigned`
 * and the auto-dispatcher have concrete targets.
 *
 * Idempotent — upserts on `{workspaceId, profileKey}`.
 *
 * Also (best-effort) links the existing Victor / Mizu ApiKey rows in the
 * AXI workspace to their new Agent rows via `ApiKey.linkedAgentId`, iff the
 * key exists and its `linkedAgentId` is still null.
 *
 * Env inputs (optional):
 *   FORGE_AGENT_VICTOR_WEBHOOK_URL
 *   FORGE_AGENT_MIZU_WEBHOOK_URL
 *
 * Run:
 *   pnpm tsx scripts/seed-agents.ts
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";

loadDotenv({ path: resolve(__dirname, "..", ".env") });

const prisma = new PrismaClient();

type AgentSeed = {
  profileKey: string;
  name: string;
  description: string;
  avatar: string;
  capabilities: string[];
  maxConcurrent: number;
  webhookUrl: string | null;
  apiKeyNameHint: string;
};

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

async function main() {
  console.log("[seed-agents] start");

  const axi = await prisma.workspace.findUnique({ where: { key: "AXI" } });
  if (!axi) {
    throw new Error(
      "[seed-agents] no Workspace with key='AXI' found — create it first",
    );
  }
  console.log(`[seed-agents] workspace AXI: ${axi.id} (slug=${axi.slug})`);

  const seeds: AgentSeed[] = [
    {
      profileKey: "victor",
      name: "Victor",
      description: "Lead — architecture & ops",
      avatar: "🔷",
      capabilities: ["ops", "architecture", "code-review", "infra"],
      maxConcurrent: 3,
      webhookUrl: readEnv("FORGE_AGENT_VICTOR_WEBHOOK_URL"),
      apiKeyNameHint: "Victor",
    },
    {
      profileKey: "mizu",
      name: "Mizu",
      description: "CEO — Axiom-Labs operations",
      avatar: "💧",
      capabilities: ["ops", "growth", "marketing", "community", "intelligence"],
      maxConcurrent: 2,
      webhookUrl: readEnv("FORGE_AGENT_MIZU_WEBHOOK_URL"),
      apiKeyNameHint: "Mizu",
    },
  ];

  const persisted: Array<{
    id: string;
    profileKey: string;
    name: string;
    webhookUrl: string | null;
  }> = [];

  for (const seed of seeds) {
    const agent = await prisma.agent.upsert({
      where: {
        workspaceId_profileKey: {
          workspaceId: axi.id,
          profileKey: seed.profileKey,
        },
      },
      update: {
        name: seed.name,
        description: seed.description,
        avatar: seed.avatar,
        capabilities: seed.capabilities,
        maxConcurrent: seed.maxConcurrent,
        webhookUrl: seed.webhookUrl,
      },
      create: {
        workspaceId: axi.id,
        profileKey: seed.profileKey,
        name: seed.name,
        description: seed.description,
        avatar: seed.avatar,
        capabilities: seed.capabilities,
        maxConcurrent: seed.maxConcurrent,
        webhookUrl: seed.webhookUrl,
      },
    });
    persisted.push({
      id: agent.id,
      profileKey: agent.profileKey,
      name: agent.name,
      webhookUrl: agent.webhookUrl,
    });
    console.log(
      `[seed-agents] upsert agent profileKey=${agent.profileKey} id=${agent.id} webhookUrl=${agent.webhookUrl ?? "(null)"}`,
    );
  }

  // Best-effort ApiKey linkage.
  for (const seed of seeds) {
    const agent = persisted.find((p) => p.profileKey === seed.profileKey);
    if (!agent) continue;
    const key = await prisma.apiKey.findFirst({
      where: {
        workspaceId: axi.id,
        name: { contains: seed.apiKeyNameHint, mode: "insensitive" },
        revokedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });
    if (!key) {
      console.log(
        `[seed-agents] no active ApiKey matching "${seed.apiKeyNameHint}" — skipping link`,
      );
      continue;
    }
    if (key.linkedAgentId && key.linkedAgentId !== agent.id) {
      console.log(
        `[seed-agents] apiKey ${key.id} already linked to agent ${key.linkedAgentId} — leaving alone`,
      );
      continue;
    }
    if (key.linkedAgentId === agent.id) {
      console.log(
        `[seed-agents] apiKey ${key.id} already linked to ${seed.profileKey} — no-op`,
      );
      continue;
    }
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { linkedAgentId: agent.id },
    });
    console.log(
      `[seed-agents] linked apiKey ${key.id} (name="${key.name}") -> agent ${agent.id} (${seed.profileKey})`,
    );
  }

  console.log("[seed-agents] persisted:");
  for (const row of persisted) {
    console.log(
      `  - ${row.name.padEnd(8)} profileKey=${row.profileKey.padEnd(8)} id=${row.id} webhookUrl=${row.webhookUrl ?? "(null)"}`,
    );
  }
  console.log("[seed-agents] done");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
