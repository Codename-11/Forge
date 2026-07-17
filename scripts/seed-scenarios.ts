import {
  AgentConnectionKind,
  AgentConnectionLiveness,
  AgentConnectionStatus,
  AgentRunStatus,
  EventKind,
  LivenessConfidence,
  PrismaClient,
  Priority,
  Role,
  WorkSessionSource,
  WorkSessionStatus,
} from "@prisma/client";
import { LOCAL_DATABASE_URL, validateLocalScenarioTarget } from "./lib/local-data-target";
import {
  buildScenarioPlan,
  parseScenarioNames,
  scenarioId,
  scenarioPrefix,
  type ScenarioName,
  type ScenarioPlan,
} from "./scenarios/plan";

const ANCHOR = new Date("2026-07-01T12:00:00.000Z");
const MINUTE = 60_000;

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const names = parseScenarioNames(argValue("--scenarios"));
const scale = Number(argValue("--scale") ?? "1");
const plan = buildScenarioPlan(names, scale);

if (process.argv.includes("--list")) {
  for (const item of buildScenarioPlan(parseScenarioNames("all"), 1)) {
    console.log(`${item.name.padEnd(25)} ${item.description}`);
  }
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
validateLocalScenarioTarget(databaseUrl);

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function removeScenario(name: ScenarioName) {
  const prefixes = [scenarioPrefix(name), `scenario-${name}-`];
  const owned = { OR: prefixes.map((prefix) => ({ id: { startsWith: prefix } })) };
  await prisma.$transaction([
    prisma.activityEvent.deleteMany({ where: owned }),
    prisma.auditLog.deleteMany({ where: owned }),
    prisma.agentRunEvent.deleteMany({ where: owned }),
    prisma.agentRun.deleteMany({ where: owned }),
    prisma.workSession.deleteMany({ where: owned }),
    prisma.externalResourceLink.deleteMany({ where: owned }),
    prisma.externalResource.deleteMany({ where: owned }),
    prisma.agentConnection.deleteMany({ where: owned }),
    prisma.issue.deleteMany({ where: owned }),
    prisma.agent.deleteMany({ where: owned }),
    prisma.user.deleteMany({ where: owned }),
  ]);
  if (name === "tenancy") {
    await prisma.workspace.deleteMany({
      where: { id: { in: [scenarioId(name, "workspace"), "scenario-tenancy-workspace-0000"] } },
    });
  }
}

async function context() {
  const workspace = await prisma.workspace.findUnique({ where: { slug: "forge" } });
  const owner = await prisma.user.findUnique({ where: { email: "owner@forge.local" } });
  if (!workspace || !owner) throw new Error("Run `pnpm prisma:seed` before named scenarios");
  const status = await prisma.status.findFirst({
    where: { workspaceId: workspace.id, category: "TODO" },
    orderBy: { position: "asc" },
  });
  const agents = await prisma.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { profileKey: "asc" },
  });
  if (!status || agents.length === 0) throw new Error("Base seed is missing statuses or agents");
  return { workspace, owner, status, agent: agents[0] };
}

async function createIssue(input: {
  scenario: ScenarioName;
  index: number;
  number: number;
  title: string;
  workspaceId: string;
  statusId: string;
  authorId: string;
  agentId?: string;
}) {
  return prisma.issue.create({
    data: {
      id: scenarioId(input.scenario, "issue", input.index),
      workspaceId: input.workspaceId,
      number: input.number,
      title: input.title,
      description: `Deterministic local scenario fixture: ${input.scenario}.`,
      statusId: input.statusId,
      priority: input.index % 7 === 0 ? Priority.HIGH : Priority.MEDIUM,
      authorId: input.authorId,
      assignedAgentId: input.agentId,
      createdAt: new Date(ANCHOR.getTime() + input.index * MINUTE),
      updatedAt: new Date(ANCHOR.getTime() + input.index * MINUTE),
    },
  });
}

async function createScenarioAgent(
  scenario: ScenarioName,
  ctx: Awaited<ReturnType<typeof context>>,
  maxConcurrent: number,
) {
  return prisma.agent.create({
    data: {
      id: scenarioId(scenario, "agent"),
      workspaceId: ctx.workspace.id,
      name: `Scenario ${scenario}`,
      profileKey: `scenario-${scenario}`,
      description: "Isolated deterministic local scenario agent.",
      capabilities: ["scenario"],
      status: "ONLINE",
      lastHeartbeatAt: ANCHOR,
      maxConcurrent,
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
    },
  });
}

async function seedDelivery(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const states = ["open", "merged"];
  for (let i = 0; i < plan.issueCount; i++) {
    const issue = await createIssue({
      scenario: plan.name,
      index: i,
      number: 51_000 + i,
      title: `Scenario delivery ${states[i]}`,
      ...ctx,
      workspaceId: ctx.workspace.id,
      statusId: ctx.status.id,
      authorId: ctx.owner.id,
    });
    const resource = await prisma.externalResource.create({
      data: {
        id: scenarioId(plan.name, "github", i),
        workspaceId: ctx.workspace.id,
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "Codename-11/forge",
        number: 900 + i,
        externalId: String(900 + i),
        url: `https://github.com/Codename-11/forge/pull/${900 + i}`,
        title: `Scenario PR ${states[i]}`,
        state: states[i],
        authorLogin: "scenario-bot",
        metadata: {
          isDraft: false,
          reviewDecision: i ? "APPROVED" : "REVIEW_REQUIRED",
          checks: i ? "SUCCESS" : "PENDING",
          mergedAt: i ? ANCHOR.toISOString() : null,
        },
        lastSyncedAt: ANCHOR,
        externalUpdatedAt: ANCHOR,
        createdAt: ANCHOR,
        updatedAt: ANCHOR,
      },
    });
    await prisma.externalResourceLink.create({
      data: {
        id: scenarioId(plan.name, "link", i),
        workspaceId: ctx.workspace.id,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
        createdById: ctx.owner.id,
        createdAt: ANCHOR,
      },
    });
    await prisma.workSession.create({
      data: {
        id: scenarioId(plan.name, "session", i),
        workspaceId: ctx.workspace.id,
        issueId: issue.id,
        ownerUserId: ctx.owner.id,
        source: WorkSessionSource.CODEX_DESKTOP,
        status: i ? WorkSessionStatus.MERGED : WorkSessionStatus.IN_REVIEW,
        repoFullName: "Codename-11/forge",
        branch: `codex/scenario-${i}`,
        baseBranch: "main",
        headSha: `scenariohead${i}`,
        pullRequestId: resource.id,
        lastHeartbeatAt: ANCHOR,
        mergedAt: i ? ANCHOR : null,
        createdAt: ANCHOR,
        updatedAt: ANCHOR,
      },
    });
  }
}

async function seedFreshness(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const states = [
    AgentRunStatus.ACTIVE,
    AgentRunStatus.ACTIVE,
    AgentRunStatus.STALLED,
    AgentRunStatus.WAITING,
  ];
  const labels = ["fresh", "quiet", "stale", "waiting"];
  const agent = await createScenarioAgent(plan.name, ctx, 4);
  const connection = await prisma.agentConnection.create({
    data: {
      id: scenarioId(plan.name, "connection"),
      workspaceId: ctx.workspace.id,
      agentId: agent.id,
      kind: AgentConnectionKind.MCP_CLIENT,
      livenessModel: AgentConnectionLiveness.LEASE,
      status: AgentConnectionStatus.ACTIVE,
      confidence: LivenessConfidence.CONFIRMED,
      instanceKey: "scenario-freshness",
      displayName: "Scenario MCP",
      firstSeenAt: ANCHOR,
      lastSeenAt: ANCHOR,
      connectedAt: ANCHOR,
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
    },
  });
  for (let i = 0; i < plan.issueCount; i++) {
    const issue = await createIssue({
      scenario: plan.name,
      index: i,
      number: 52_000 + i,
      title: `Scenario status ${labels[i]}`,
      workspaceId: ctx.workspace.id,
      statusId: ctx.status.id,
      authorId: ctx.owner.id,
      agentId: agent.id,
    });
    const lastEventAt = new Date(ANCHOR.getTime() - [1, 10, 180, 30][i] * MINUTE);
    await prisma.agentRun.create({
      data: {
        id: scenarioId(plan.name, "run", i),
        workspaceId: ctx.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        connectionId: connection.id,
        status: states[i],
        lifecycleConfidence: LivenessConfidence.CONFIRMED,
        startedAt: new Date(ANCHOR.getTime() - 240 * MINUTE),
        lastEventAt,
        currentStep: labels[i],
        finishedAt: i === 2 ? lastEventAt : null,
      },
    });
  }
}

async function seedActivity(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const issue = await createIssue({
    scenario: plan.name,
    index: 0,
    number: 53_000,
    title: "Scenario activity overflow and grouping",
    workspaceId: ctx.workspace.id,
    statusId: ctx.status.id,
    authorId: ctx.owner.id,
  });
  for (let i = 0; i < plan.eventCount; i++) {
    await prisma.activityEvent.create({
      data: {
        id: scenarioId(plan.name, "event", i),
        workspaceId: ctx.workspace.id,
        kind: i % 6 < 4 ? EventKind.ISSUE_UPDATED : EventKind.ISSUE_STATUS_CHANGED,
        actorId: ctx.owner.id,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { scenario: plan.name, group: Math.floor(i / 4), index: i },
        createdAt: new Date(ANCHOR.getTime() + i * 1000),
      },
    });
  }
}

async function seedTenancy(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const workspace = await prisma.workspace.create({
    data: {
      id: scenarioId(plan.name, "workspace"),
      slug: "scenario-tenant",
      key: "SCN",
      name: "Scenario Tenant",
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
    },
  });
  await prisma.membership.create({
    data: {
      id: scenarioId(plan.name, "membership"),
      workspaceId: workspace.id,
      userId: ctx.owner.id,
      role: Role.OWNER,
      createdAt: ANCHOR,
    },
  });
  const status = await prisma.status.create({
    data: {
      id: scenarioId(plan.name, "status"),
      workspaceId: workspace.id,
      name: "Todo",
      category: "TODO",
      color: "#78716c",
      position: 0,
    },
  });
  for (let i = 0; i < plan.issueCount; i++)
    await createIssue({
      scenario: plan.name,
      index: i,
      number: i + 1,
      title: `Overlapping tenant issue ${i + 1}`,
      workspaceId: workspace.id,
      statusId: status.id,
      authorId: ctx.owner.id,
    });
}

async function seedConcurrency(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const agent = await createScenarioAgent(plan.name, ctx, 2);
  for (let i = 0; i < plan.issueCount; i++)
    await createIssue({
      scenario: plan.name,
      index: i,
      number: 54_000 + i,
      title: `Scenario invited teammate work ${i + 1}`,
      workspaceId: ctx.workspace.id,
      statusId: ctx.status.id,
      authorId: ctx.owner.id,
      agentId: agent.id,
    });
  for (let i = 0; i < 3; i++) {
    const email = `scenario-invite-${i}@forge.local`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { name: `Scenario Invite ${i + 1}` },
      create: {
        id: scenarioId(plan.name, "user", i),
        email,
        name: `Scenario Invite ${i + 1}`,
        handle: `scenario-invite-${i}`,
      },
    });
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: ctx.workspace.id } },
      update: { role: i === 0 ? Role.ADMIN : Role.MEMBER },
      create: {
        id: scenarioId(plan.name, "membership", i),
        userId: user.id,
        workspaceId: ctx.workspace.id,
        role: i === 0 ? Role.ADMIN : Role.MEMBER,
        createdAt: ANCHOR,
      },
    });
  }
}

async function seedLarge(plan: ScenarioPlan, ctx: Awaited<ReturnType<typeof context>>) {
  const batch = Array.from({ length: plan.issueCount }, (_, i) => ({
    id: scenarioId(plan.name, "issue", i),
    workspaceId: ctx.workspace.id,
    number: 60_000 + i,
    title: `Scenario performance issue ${String(i + 1).padStart(4, "0")}`,
    description: "Deterministic large-workspace fixture",
    statusId: ctx.status.id,
    priority: i % 10 === 0 ? Priority.HIGH : Priority.NONE,
    authorId: ctx.owner.id,
    createdAt: new Date(ANCHOR.getTime() + i * MINUTE),
    updatedAt: new Date(ANCHOR.getTime() + i * MINUTE),
  }));
  await prisma.issue.createMany({ data: batch });
}

async function main() {
  const ctx = await context();
  for (const item of plan) {
    await removeScenario(item.name);
    if (item.name === "delivery-github") await seedDelivery(item, ctx);
    else if (item.name === "status-freshness") await seedFreshness(item, ctx);
    else if (item.name === "activity-overflow") await seedActivity(item, ctx);
    else if (item.name === "tenancy") await seedTenancy(item, ctx);
    else if (item.name === "invitations-concurrency") await seedConcurrency(item, ctx);
    else await seedLarge(item, ctx);
    console.log(`[scenarios] ${item.name}: ${item.issueCount} issues, ${item.eventCount} events`);
  }
}

main().finally(() => prisma.$disconnect());
