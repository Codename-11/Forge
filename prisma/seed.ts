/**
 * Forge dev seed — rich, idempotent fixtures for local UI iteration.
 *
 * Creates one "forge" workspace (key FRG) owned by `owner@forge.local`
 * (the default `dev:local` ADMIN_EMAIL, so you can sign in straight
 * away), plus teammates, agents, statuses, labels, initiatives,
 * projects, sprints/cycles, ~24 issues across the board with
 * assignees / labels / relations, and a few comment threads.
 *
 * Safe to re-run: everything keys off a natural unique constraint and
 * upserts, except comments (no natural key) which are only created when
 * the workspace has none yet.
 *
 *   pnpm prisma:seed          # against $DATABASE_URL
 *   pnpm dev:local            # runs this automatically on an empty DB
 */
import {
  PrismaClient,
  Role,
  StatusCategory,
  Priority,
  CycleStatus,
  InitiativeStatus,
  RelationKind,
  AgentProvider,
  AgentRole,
  AgentStatus,
  RuntimeKind,
  RunEngine,
} from "@prisma/client";

const prisma = new PrismaClient();

const DAY = 86_400_000;

async function main() {
  // ---- People --------------------------------------------------------
  const owner = await prisma.user.upsert({
    where: { email: "owner@forge.local" },
    update: {},
    create: { email: "owner@forge.local", name: "Forge Owner", handle: "owner" },
  });
  const dev = await prisma.user.upsert({
    where: { email: "dev@forge.local" },
    update: {},
    create: { email: "dev@forge.local", name: "Dana Dev", handle: "dana" },
  });
  const pm = await prisma.user.upsert({
    where: { email: "pm@forge.local" },
    update: {},
    create: { email: "pm@forge.local", name: "Priya PM", handle: "priya" },
  });

  // ---- Workspace -----------------------------------------------------
  const workspace = await prisma.workspace.upsert({
    where: { slug: "forge" },
    update: {},
    create: {
      slug: "forge",
      name: "Forge",
      key: "FRG",
      timeTrackingEnabled: true,
      autoDispatch: true,
      autoDispatchMode: "CAPABILITY_MATCH",
      memberships: {
        create: [
          { userId: owner.id, role: Role.OWNER },
          { userId: dev.id, role: Role.ADMIN },
          { userId: pm.id, role: Role.MEMBER },
        ],
      },
    },
  });
  const wid = workspace.id;

  // ---- Statuses ------------------------------------------------------
  const statusDefs = [
    { name: "Backlog", category: StatusCategory.BACKLOG, color: "#78716c", position: 0, isDefault: true },
    { name: "Todo", category: StatusCategory.TODO, color: "#a8a29e", position: 1 },
    { name: "In Progress", category: StatusCategory.IN_PROGRESS, color: "#d97706", position: 2 },
    { name: "In Review", category: StatusCategory.IN_REVIEW, color: "#ca8a04", position: 3 },
    { name: "Done", category: StatusCategory.DONE, color: "#65a30d", position: 4 },
    { name: "Canceled", category: StatusCategory.CANCELED, color: "#57534e", position: 5 },
  ];
  for (const s of statusDefs) {
    await prisma.status.upsert({
      where: { workspaceId_name: { workspaceId: wid, name: s.name } },
      update: {},
      create: { ...s, workspaceId: wid },
    });
  }
  const statuses = await prisma.status.findMany({ where: { workspaceId: wid } });
  const byStatus = (name: string) => statuses.find((s) => s.name === name)!;

  // ---- Labels --------------------------------------------------------
  const labelDefs = [
    { name: "bug", color: "#dc2626" },
    { name: "feature", color: "#2563eb" },
    { name: "chore", color: "#78716c" },
    { name: "design", color: "#db2777" },
    { name: "urgent", color: "#ea580c" },
    { name: "backend", color: "#0891b2" },
    { name: "frontend", color: "#7c3aed" },
  ];
  for (const l of labelDefs) {
    await prisma.label.upsert({
      where: { workspaceId_name: { workspaceId: wid, name: l.name } },
      update: {},
      create: { ...l, workspaceId: wid },
    });
  }
  const labels = await prisma.label.findMany({ where: { workspaceId: wid } });
  const byLabel = (name: string) => labels.find((l) => l.name === name)!;

  // ---- Initiatives ---------------------------------------------------
  const q2 = await prisma.initiative.upsert({
    where: { workspaceId_slug: { workspaceId: wid, slug: "q2-platform" } },
    update: {},
    create: {
      workspaceId: wid,
      name: "Q2 Platform Bets",
      slug: "q2-platform",
      description: "Foundational platform work for the quarter.",
      status: InitiativeStatus.ACTIVE,
      color: "#d97706",
      position: 0,
      createdById: owner.id,
      targetDate: new Date(Date.now() + 60 * DAY),
    },
  });
  const growth = await prisma.initiative.upsert({
    where: { workspaceId_slug: { workspaceId: wid, slug: "growth" } },
    update: {},
    create: {
      workspaceId: wid,
      name: "Growth & Onboarding",
      slug: "growth",
      description: "Reduce time-to-first-value for new workspaces.",
      status: InitiativeStatus.PLANNED,
      color: "#65a30d",
      position: 1,
      createdById: pm.id,
    },
  });

  // ---- Projects ------------------------------------------------------
  const projectDefs = [
    { key: "CORE", name: "Core Platform", description: "Foundational work for Forge.", color: "#d97706", initiativeId: q2.id },
    { key: "API", name: "Public API", description: "tRPC + MCP surface and docs.", color: "#0891b2", initiativeId: q2.id },
    { key: "ONB", name: "Onboarding", description: "First-run experience and sample data.", color: "#65a30d", initiativeId: growth.id },
  ];
  for (const p of projectDefs) {
    await prisma.project.upsert({
      where: { workspaceId_key: { workspaceId: wid, key: p.key } },
      update: {},
      create: { ...p, workspaceId: wid, createdById: owner.id },
    });
  }
  const projects = await prisma.project.findMany({ where: { workspaceId: wid } });
  const byProject = (key: string) => projects.find((p) => p.key === key)!;

  // ---- Cycles / Sprints ---------------------------------------------
  const now = new Date();
  const active = await prisma.cycle.upsert({
    where: { workspaceId_name: { workspaceId: wid, name: "Sprint 1" } },
    update: {},
    create: {
      workspaceId: wid,
      name: "Sprint 1",
      startsAt: new Date(now.getTime() - 3 * DAY),
      endsAt: new Date(now.getTime() + 4 * DAY),
      lengthDays: 7,
      status: CycleStatus.ACTIVE,
    },
  });
  const planned = await prisma.cycle.upsert({
    where: { workspaceId_name: { workspaceId: wid, name: "Sprint 2" } },
    update: {},
    create: {
      workspaceId: wid,
      name: "Sprint 2",
      startsAt: new Date(now.getTime() + 4 * DAY),
      endsAt: new Date(now.getTime() + 11 * DAY),
      lengthDays: 7,
      status: CycleStatus.PLANNED,
    },
  });

  // ---- Agents --------------------------------------------------------
  const victor = await prisma.agent.upsert({
    where: { workspaceId_profileKey: { workspaceId: wid, profileKey: "victor" } },
    update: {},
    create: {
      workspaceId: wid,
      profileKey: "victor",
      name: "Victor",
      description: "Lead engineering agent — architecture & backend.",
      avatar: "🔷",
      provider: AgentProvider.HERMES,
      role: AgentRole.WORKER,
      status: AgentStatus.ONLINE,
      capabilities: ["backend", "feature", "code-review"],
      maxConcurrent: 2,
      lastHeartbeatAt: new Date(),
    },
  });
  const mizu = await prisma.agent.upsert({
    where: { workspaceId_profileKey: { workspaceId: wid, profileKey: "mizu" } },
    update: {},
    create: {
      workspaceId: wid,
      profileKey: "mizu",
      name: "Mizu",
      description: "Growth & frontend agent.",
      avatar: "💧",
      provider: AgentProvider.HERMES,
      role: AgentRole.WORKER,
      status: AgentStatus.OFFLINE,
      capabilities: ["frontend", "design"],
      maxConcurrent: 1,
    },
  });

  // ---- E2E fixtures (only when FORGE_E2E=1) --------------------------
  // Deterministic runtimes + an agent the browser suite drives without any
  // external service. `e2e-mock` resolves to the in-process mock-runs
  // connector (registry.ts, also FORGE_E2E-gated); `e2e-codex` exists so the
  // Codex sandbox config panel + enable/disable toggle have a real row.
  if (process.env.FORGE_E2E === "1") {
    const mockRuntime = await prisma.runtime.upsert({
      where: { id: "e2e-mock-runtime" },
      update: { disabledAt: null },
      create: {
        id: "e2e-mock-runtime",
        workspaceId: wid,
        name: "E2E Mock Runtime",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "mock-runs",
        endpoint: "mock://e2e",
        ownerId: owner.id,
        heartbeatAt: new Date(),
        connectedAt: new Date(),
      },
    });
    await prisma.agent.upsert({
      where: { workspaceId_profileKey: { workspaceId: wid, profileKey: "e2ebot" } },
      update: { runtimeId: mockRuntime.id, runEngine: RunEngine.RUNS, status: AgentStatus.ONLINE },
      create: {
        workspaceId: wid,
        profileKey: "e2ebot",
        name: "E2E Bot",
        description: "Scripted mock-runs agent for the E2E suite.",
        avatar: "🤖",
        provider: AgentProvider.CUSTOM,
        role: AgentRole.WORKER,
        status: AgentStatus.ONLINE,
        runEngine: RunEngine.RUNS,
        runtimeId: mockRuntime.id,
        capabilities: ["e2e"],
        maxConcurrent: 2,
        lastHeartbeatAt: new Date(),
      },
    });
    await prisma.runtime.upsert({
      where: { id: "e2e-codex-runtime" },
      update: { disabledAt: null, config: {} },
      create: {
        id: "e2e-codex-runtime",
        workspaceId: wid,
        name: "E2E Codex Runtime",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "codex-app-server",
        endpoint: "ws://127.0.0.1:4505",
        config: {},
        ownerId: owner.id,
      },
    });
  }

  // ---- Issues --------------------------------------------------------
  // [title, projectKey, statusName, priority, labelNames, assigneeUserId?,
  //  assignedAgentId?, cycleId?, queued?]
  type Seed = {
    title: string;
    project: string;
    status: string;
    priority: Priority;
    labels: string[];
    assignee?: string;
    agent?: string;
    cycle?: string;
    queued?: boolean;
  };
  const issueSeeds: Seed[] = [
    { title: "Set up workspace key immutability guard", project: "CORE", status: "Done", priority: Priority.HIGH, labels: ["backend"], assignee: dev.id },
    { title: "Add density-aware text utilities", project: "CORE", status: "Done", priority: Priority.MEDIUM, labels: ["frontend", "design"], assignee: dev.id },
    { title: "Runtime adapter registry", project: "CORE", status: "In Review", priority: Priority.HIGH, labels: ["backend", "feature"], agent: victor.id, cycle: active.id },
    { title: "Mission Control chat streaming", project: "CORE", status: "In Progress", priority: Priority.HIGH, labels: ["frontend", "feature"], assignee: dev.id, cycle: active.id },
    { title: "Auto-dispatch capability matching", project: "CORE", status: "In Progress", priority: Priority.URGENT, labels: ["backend", "urgent"], agent: victor.id, cycle: active.id },
    { title: "Fix dropped agent reply in chat", project: "CORE", status: "Todo", priority: Priority.HIGH, labels: ["bug"], cycle: active.id, queued: true },
    { title: "Attachment quota enforcement", project: "CORE", status: "Backlog", priority: Priority.MEDIUM, labels: ["backend", "chore"] },
    { title: "Soft-delete cascade audit", project: "CORE", status: "Backlog", priority: Priority.LOW, labels: ["chore"] },

    { title: "Document MCP tool namespaces", project: "API", status: "In Progress", priority: Priority.MEDIUM, labels: ["chore"], assignee: pm.id, cycle: active.id },
    { title: "Rate-limit per-procedure tuning", project: "API", status: "Todo", priority: Priority.MEDIUM, labels: ["backend"], cycle: active.id },
    { title: "Granular ApiKey scope examples", project: "API", status: "Todo", priority: Priority.LOW, labels: ["backend", "feature"], queued: true },
    { title: "tRPC error envelope consistency", project: "API", status: "Backlog", priority: Priority.MEDIUM, labels: ["bug", "backend"] },
    { title: "Webhook delivery retry backoff", project: "API", status: "Done", priority: Priority.HIGH, labels: ["backend"], assignee: dev.id },
    { title: "Session-scoped API keys (TTL)", project: "API", status: "In Review", priority: Priority.MEDIUM, labels: ["feature", "backend"], agent: victor.id },

    { title: "First-run sample data seeding", project: "ONB", status: "In Progress", priority: Priority.HIGH, labels: ["feature", "frontend"], assignee: dev.id, cycle: active.id },
    { title: "Empty-state illustrations", project: "ONB", status: "Todo", priority: Priority.LOW, labels: ["design", "frontend"], agent: mizu.id, cycle: planned.id },
    { title: "Keyboard shortcut cheat sheet", project: "ONB", status: "Todo", priority: Priority.MEDIUM, labels: ["frontend", "feature"], cycle: planned.id, queued: true },
    { title: "Workspace switcher onboarding tour", project: "ONB", status: "Backlog", priority: Priority.MEDIUM, labels: ["frontend", "design"] },
    { title: "Invite teammate flow polish", project: "ONB", status: "Backlog", priority: Priority.LOW, labels: ["frontend"] },
    { title: "Sample plugin: issue-triage walkthrough", project: "ONB", status: "Backlog", priority: Priority.LOW, labels: ["feature", "chore"] },

    { title: "Investigate slow board query on large workspaces", project: "CORE", status: "Todo", priority: Priority.URGENT, labels: ["bug", "backend", "urgent"], agent: victor.id, queued: true, cycle: active.id },
    { title: "Redis pub/sub reconnect storm", project: "CORE", status: "Backlog", priority: Priority.HIGH, labels: ["bug", "backend"] },
    { title: "Dark mode token contrast pass", project: "ONB", status: "Done", priority: Priority.LOW, labels: ["design"], assignee: dev.id },
    { title: "Cycle rollover edge cases", project: "CORE", status: "Canceled", priority: Priority.LOW, labels: ["chore"] },
  ];

  // Determine the next issue number so re-running appends rather than
  // colliding on the workspaceId_number unique constraint.
  const maxIssue = await prisma.issue.aggregate({
    where: { workspaceId: wid },
    _max: { number: true },
  });
  let n = maxIssue._max.number ?? 0;
  const existingCount = await prisma.issue.count({ where: { workspaceId: wid } });

  const createdIssueIds: string[] = [];
  if (existingCount === 0) {
    for (const s of issueSeeds) {
      n += 1;
      const st = byStatus(s.status);
      const completed =
        st.category === "DONE" ? new Date(now.getTime() - DAY) : null;
      const canceled =
        st.category === "CANCELED" ? new Date(now.getTime() - DAY) : null;
      const issue = await prisma.issue.create({
        data: {
          workspaceId: wid,
          number: n,
          title: s.title,
          description: `Seed-generated issue: **${s.title}**.\n\nDemo content for local UI iteration.`,
          projectId: byProject(s.project).id,
          statusId: st.id,
          priority: s.priority,
          authorId: owner.id,
          assignedAgentId: s.agent ?? null,
          cycleId: s.cycle ?? null,
          queued: s.queued ?? false,
          startedAt: st.category === "IN_PROGRESS" ? new Date(now.getTime() - 2 * DAY) : null,
          completedAt: completed,
          canceledAt: canceled,
          assignees: s.assignee
            ? { create: [{ userId: s.assignee }] }
            : undefined,
          labels: {
            create: s.labels.map((name) => ({ labelId: byLabel(name).id })),
          },
        },
      });
      createdIssueIds.push(issue.id);
    }

    // ---- Relations (a couple of blocks/related links) ----------------
    if (createdIssueIds.length >= 6) {
      await prisma.issueRelation.create({
        data: {
          workspaceId: wid,
          fromIssueId: createdIssueIds[5], // "Fix dropped agent reply"
          toIssueId: createdIssueIds[3], // "Mission Control chat streaming"
          kind: RelationKind.BLOCKS,
        },
      });
      await prisma.issueRelation.create({
        data: {
          workspaceId: wid,
          fromIssueId: createdIssueIds[20], // slow board query
          toIssueId: createdIssueIds[21], // redis reconnect storm
          kind: RelationKind.RELATES_TO,
        },
      });
    }

    // ---- Comments ----------------------------------------------------
    await prisma.comment.create({
      data: {
        workspaceId: wid,
        issueId: createdIssueIds[3],
        authorId: pm.id,
        body: "Can we get the token-by-token streaming behind a flag for the demo?",
      },
    });
    await prisma.comment.create({
      data: {
        workspaceId: wid,
        issueId: createdIssueIds[3],
        authorId: dev.id,
        body: "Yep — wiring it through the same SSE vocab now.",
      },
    });
    await prisma.comment.create({
      data: {
        workspaceId: wid,
        issueId: createdIssueIds[4],
        authorId: owner.id,
        body: "Prioritising this — it's blocking the dispatch demo.",
      },
    });
  }

  console.log(
    `Seed complete: workspace ${workspace.slug} (${workspace.key}), ` +
      `${projects.length} projects, ${issueSeeds.length} issue templates, ` +
      `2 agents, 2 sprints. New issues created: ${createdIssueIds.length}.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
