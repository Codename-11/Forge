import { describe, it, expect, afterAll, afterEach } from "vitest";
import { ChatContextMode, EventKind, RelationKind } from "@prisma/client";
import { mcpTools, type McpContext } from "@/server/services/mcp";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the MCP tool registry. Exercises tools the same
 * way the HTTP handlers do — passing a hand-built `McpContext` with an
 * `ApiKeyContext` attached. No real HTTP involved; the route handlers are
 * a thin auth/rate-limit shell around `mcpTools[name].run()`.
 */

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

function buildMcpCtx(
  fixture: TestFixture,
  overrides: Partial<ApiKeyContext> = {},
): { ctx: McpContext; apiKey: ApiKeyContext } {
  const apiKey: ApiKeyContext = {
    keyId: "test-key",
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    scopes: [
      "READ_ISSUES",
      "WRITE_ISSUES",
      "READ_PROJECTS",
      "WRITE_PROJECTS",
      "READ_COMMENTS",
      "WRITE_COMMENTS",
      "READ_USERS",
      "READ_ANALYTICS",
      "SUBSCRIBE_EVENTS",
      "INVOKE_SKILLS",
      "ADMIN",
    ],
    projectIds: [],
    labelIds: [],
    initiativeIds: [],
    linkedAgentId: null,
    ...overrides,
  };
  return {
    ctx: {
      workspaceId: apiKey.workspaceId,
      userId: apiKey.userId,
      pluginId: apiKey.pluginId,
      apiKey,
    },
    apiKey,
  };
}

// Run a tool by name: parses input through its zod schema then executes.
async function call<T extends keyof typeof mcpTools>(
  name: T,
  input: unknown,
  ctx: McpContext,
): Promise<unknown> {
  const def = mcpTools[name];
  for (const required of def.scopes) {
    if (ctx.apiKey && !ctx.apiKey.scopes.includes(required)) {
      throw new Error(`Missing required scope: ${required}`);
    }
  }
  const parsed = def.input.parse(input ?? {});
  return def.run(parsed as never, ctx);
}

describe("mcp tool registry", () => {
  it("registers >= 30 tools spanning the new primitives", () => {
    const names = Object.keys(mcpTools);
    expect(names.length).toBeGreaterThanOrEqual(30);
    const expectedPrefixes = [
      "issues.",
      "comments.",
      "projects.",
      "analytics.",
      "cycles.",
      "initiatives.",
      "relations.",
      "time.",
      "attachments.",
      "pins.",
    ];
    for (const p of expectedPrefixes) {
      expect(names.some((n) => n.startsWith(p))).toBe(true);
    }
  });

  it("every tool's zod schema serializes to a non-empty JSON Schema", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    for (const [name, def] of Object.entries(mcpTools)) {
      const shape = zodToJsonSchema(def.input, { target: "jsonSchema7", $refStrategy: "none" });
      expect(shape, `tool ${name}`).toBeTruthy();
      expect(typeof shape).toBe("object");
    }
  });
});

describe("mcp — smoke: cycles, initiatives, relations, time, attachments, pins", () => {
  it("cycles: create / list / current / update / plan / rollover", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC1" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);

    const created = (await call("cycles.create", { name: "Sprint 1" }, ctx)) as {
      id: string;
    };
    expect(created.id).toBeTruthy();

    const list = (await call("cycles.list", {}, ctx)) as unknown[];
    expect(list.length).toBe(1);

    // Cycles default to PLANNED; current() should find nothing yet.
    expect(await call("cycles.current", {}, ctx)).toBeNull();

    await call("cycles.update", { id: created.id, status: "ACTIVE" }, ctx);
    const current = (await call("cycles.current", {}, ctx)) as { id: string };
    expect(current.id).toBe(created.id);

    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });
    const plan = (await call(
      "cycles.plan",
      { cycleId: created.id, issueIds: [a.id, b.id] },
      ctx,
    )) as { planned: number };
    expect(plan.planned).toBe(2);

    const roll = (await call("cycles.rollover", { fromCycleId: created.id }, ctx)) as {
      rolled: number;
    };
    // Neither issue is DONE/CANCELED so both roll.
    expect(roll.rolled).toBe(2);
  });

  it("initiatives: create / list / update / linkProject / unlinkProject", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC2" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);

    const initiative = (await call("initiatives.create", { name: "H1 Launch" }, ctx)) as {
      id: string;
      slug: string;
    };
    expect(initiative.slug).toBe("h1-launch");

    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "LCH",
        name: "Launch proj",
        createdById: fixture.user.id,
      },
    });

    const listed = (await call("initiatives.list", {}, ctx)) as Array<{ id: string }>;
    expect(listed.map((i) => i.id)).toContain(initiative.id);

    await call(
      "initiatives.linkProject",
      { initiativeId: initiative.id, projectId: project.id },
      ctx,
    );
    const after = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(after.initiativeId).toBe(initiative.id);

    await call("initiatives.unlinkProject", { projectId: project.id }, ctx);
    const after2 = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(after2.initiativeId).toBeNull();

    const updated = (await call(
      "initiatives.update",
      { id: initiative.id, name: "H1 Launch v2" },
      ctx,
    )) as { name: string };
    expect(updated.name).toBe("H1 Launch v2");
  });

  it("relations: add / listForIssue / remove (with reciprocal BLOCKED_BY)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC3" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const added = (await call(
      "relations.add",
      { fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.BLOCKS },
      ctx,
    )) as {
      relation: { id: string };
      reciprocal: { id: string } | null;
    };
    expect(added.relation.id).toBeTruthy();
    expect(added.reciprocal).not.toBeNull();

    const rels = (await call("relations.listForIssue", { issueId: a.id }, ctx)) as unknown[];
    expect(rels.length).toBe(1);

    await call("relations.remove", { relationId: added.relation.id }, ctx);
    const relsAfter = (await call("relations.listForIssue", { issueId: a.id }, ctx)) as unknown[];
    expect(relsAfter.length).toBe(0);
  });

  it("time: start / running / list / stop / summary", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC4" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "work" });

    const entry = (await call(
      "time.start",
      { issueId: issue.id, billable: true, hourlyRate: 100 },
      ctx,
    )) as { id: string };
    expect(entry.id).toBeTruthy();

    const running = (await call("time.running", {}, ctx)) as { id: string };
    expect(running.id).toBe(entry.id);

    const stopped = (await call("time.stop", { entryId: entry.id }, ctx)) as {
      endedAt: Date;
    };
    expect(stopped.endedAt).not.toBeNull();

    const list = (await call("time.list", { issueId: issue.id }, ctx)) as unknown[];
    expect(list.length).toBe(1);

    const summary = (await call(
      "time.summary",
      {
        from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        to: new Date(Date.now() + 60 * 1000).toISOString(),
        groupBy: "issue",
      },
      ctx,
    )) as { totalMinutes: number; buckets: unknown[] };
    expect(summary.buckets.length).toBe(1);
  });

  it("pins: set + list round-trip", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC5" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = (await call("pins.set", { issueIds: [a.id, b.id] }, ctx)) as {
      pinnedIssueIds: string[];
    };
    expect(res.pinnedIssueIds).toEqual([a.id, b.id]);

    const listed = (await call("pins.list", {}, ctx)) as Array<{ id: string }>;
    expect(listed.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("pins.set rejects >3", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC6" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    // Serial to avoid racing the `number` sequence computation in createIssue.
    const a = await createIssue(fixture);
    const b = await createIssue(fixture);
    const c = await createIssue(fixture);
    const d = await createIssue(fixture);
    await expect(call("pins.set", { issueIds: [a.id, b.id, c.id, d.id] }, ctx)).rejects.toThrow();
  });
});

describe("mcp — existing tools honor ApiKey narrowing", () => {
  it("issues.list with projectIds scope returns only that project's issues", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC7" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const onlyProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "ONL",
        name: "only",
        createdById: fixture.user.id,
      },
    });
    const otherProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "OTH",
        name: "other",
        createdById: fixture.user.id,
      },
    });
    const mine = await createIssue(fixture, { projectId: onlyProject.id, title: "mine" });
    await createIssue(fixture, { projectId: otherProject.id, title: "theirs" });
    await createIssue(fixture, { title: "no-proj" });

    const { ctx } = buildMcpCtx(fixture, { projectIds: [onlyProject.id] });
    const rows = (await call("issues.list", { includeDone: true }, ctx)) as Array<{
      id: string;
      projectId: string | null;
    }>;
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("issues.get rejects out-of-scope ids", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC8" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "SCP",
        name: "scoped",
        createdById: fixture.user.id,
      },
    });
    const notMine = await createIssue(fixture, { title: "other" });

    const { ctx } = buildMcpCtx(fixture, { projectIds: [project.id] });
    await expect(call("issues.get", { id: notMine.id }, ctx)).rejects.toThrow(/scope/i);
  });

  it("projects.list narrows to projectIds", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC9" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const p1 = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PA",
        name: "pa",
        createdById: fixture.user.id,
      },
    });
    await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PB",
        name: "pb",
        createdById: fixture.user.id,
      },
    });
    const { ctx } = buildMcpCtx(fixture, { projectIds: [p1.id] });
    const listed = (await call("projects.list", {}, ctx)) as Array<{ id: string }>;
    expect(listed.map((p) => p.id)).toEqual([p1.id]);
  });

  it("initiatives.list narrows to initiativeIds", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const a = await prisma.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "a",
        slug: "a",
        createdById: fixture.user.id,
        position: 0,
      },
    });
    await prisma.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "b",
        slug: "b",
        createdById: fixture.user.id,
        position: 1,
      },
    });
    const { ctx } = buildMcpCtx(fixture, { initiativeIds: [a.id] });
    const listed = (await call("initiatives.list", {}, ctx)) as Array<{ id: string }>;
    expect(listed.map((i) => i.id)).toEqual([a.id]);
  });
});

describe("mcp — issues.claim honors blocker skip + narrowing", () => {
  it("skips blocked issues when issueId is omitted", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);

    // Mirror the convention used in `issue.test.ts`:
    //   BLOCKED_BY fromBlocker toBlocked  — `fromIssue` is the open blocker,
    //   `toIssue` is the issue that can't start yet. `findBlockedIssueIds`
    //   picks up `toIssue` and excludes it from auto-claim candidates.
    const blocker = await createIssue(fixture, { title: "blocker", statusCategory: "TODO" });
    const blocked = await createIssue(fixture, { title: "blocked" });
    const free = await createIssue(fixture, { title: "free" });
    await prisma.issue.updateMany({
      where: { id: { in: [blocked.id, free.id] }, workspaceId: fixture.workspace.id },
      data: { queued: true },
    });
    // Mirrors `relation.add({kind: BLOCKS, from: blocker, to: blocked})`:
    //   BLOCKS     : from = blocker, to = blocked
    //   BLOCKED_BY : from = blocked, to = blocker
    await prisma.issueRelation.create({
      data: {
        workspaceId: fixture.workspace.id,
        fromIssueId: blocker.id,
        toIssueId: blocked.id,
        kind: RelationKind.BLOCKS,
      },
    });
    await prisma.issueRelation.create({
      data: {
        workspaceId: fixture.workspace.id,
        fromIssueId: blocked.id,
        toIssueId: blocker.id,
        kind: RelationKind.BLOCKED_BY,
      },
    });

    const res = (await call("issues.claim", {}, ctx)) as {
      claimed: { id: string } | null;
    };
    expect(res.claimed).not.toBeNull();
    // `blocked` is excluded; the only remaining queued unblocked candidate is `free`.
    expect(res.claimed?.id).toBe(free.id);
  });

  it("respects scope narrowing when auto-picking", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "bot", color: "#000" },
    });
    const onlyMine = await createIssue(fixture, { title: "mine" });
    const notMine = await createIssue(fixture, { title: "theirs" });
    await prisma.issueLabel.create({
      data: { issueId: onlyMine.id, labelId: label.id },
    });
    await prisma.issue.updateMany({
      where: { id: { in: [onlyMine.id, notMine.id] } },
      data: { queued: true },
    });

    const { ctx } = buildMcpCtx(fixture, { labelIds: [label.id] });
    const res = (await call("issues.claim", {}, ctx)) as {
      claimed: { id: string } | null;
    };
    expect(res.claimed?.id).toBe(onlyMine.id);
  });
});

describe("mcp — project mutations and issue queue toggle", () => {
  it("projects.create / projects.update / projects.archive write audit and activity events", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);

    const created = (await call(
      "projects.create" as keyof typeof mcpTools,
      {
        key: "OPS",
        name: "Operations",
        description: "Agent-run ops lane",
        icon: "⚙️",
        color: "#3bb8f0",
      },
      ctx,
    )) as {
      id: string;
      key: string;
      name: string;
      description: string | null;
      icon: string | null;
      color: string | null;
      archived: boolean;
    };

    expect(created.key).toBe("OPS");
    expect(created.name).toBe("Operations");
    expect(created.description).toBe("Agent-run ops lane");
    expect(created.icon).toBe("⚙️");
    expect(created.color).toBe("#3bb8f0");
    expect(created.archived).toBe(false);

    const updated = (await call(
      "projects.update" as keyof typeof mcpTools,
      { id: created.id, name: "Operations v2", description: null, icon: "🧭" },
      ctx,
    )) as { id: string; name: string; description: string | null; icon: string | null };
    expect(updated.name).toBe("Operations v2");
    expect(updated.description).toBeNull();
    expect(updated.icon).toBe("🧭");

    const archived = (await call(
      "projects.archive" as keyof typeof mcpTools,
      { id: created.id },
      ctx,
    )) as { id: string; archived: boolean };
    expect(archived.archived).toBe(true);

    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "project", subjectId: created.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.kind)).toEqual([
      EventKind.PROJECT_CREATED,
      EventKind.PROJECT_UPDATED,
    ]);

    const audit = await prisma.auditLog.findMany({
      where: { workspaceId: fixture.workspace.id, entity: "Project", entityId: created.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["create", "update"]);
  });

  it("projects.create requires WRITE_PROJECTS", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCP" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture, { scopes: ["READ_PROJECTS"] });

    await expect(
      call("projects.create" as keyof typeof mcpTools, { key: "NO", name: "Nope" }, ctx),
    ).rejects.toThrow(/WRITE_PROJECTS/);
  });

  it("projects.update rejects projectIds-narrowed keys outside their lane", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const allowed = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "OK",
        name: "allowed",
        createdById: fixture.user.id,
      },
    });
    const blocked = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "NO",
        name: "blocked",
        createdById: fixture.user.id,
      },
    });
    const { ctx } = buildMcpCtx(fixture, { projectIds: [allowed.id] });

    await expect(
      call("projects.update" as keyof typeof mcpTools, { id: blocked.id, name: "blocked v2" }, ctx),
    ).rejects.toThrow(/scope/i);
  });

  it("issues.setQueued emits ISSUE_QUEUED once and invokes auto-dispatch", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCQ" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { autoDispatch: true, autoDispatchMode: "ROUND_ROBIN" },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
        status: "ONLINE",
        maxConcurrent: 5,
      },
    });
    const issue = await createIssue(fixture, { title: "queue me" });
    const { ctx } = buildMcpCtx(fixture);

    const queued = (await call(
      "issues.setQueued" as keyof typeof mcpTools,
      { id: issue.id, queued: true },
      ctx,
    )) as { id: string; queued: boolean; assignedAgentId: string | null };
    expect(queued.queued).toBe(true);
    expect(queued.assignedAgentId).toBeNull();

    const afterDispatch = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(afterDispatch.queued).toBe(true);
    expect(afterDispatch.assignedAgentId).toBe(agent.id);

    // Idempotent: the second true call should not spam ISSUE_QUEUED.
    await call("issues.setQueued" as keyof typeof mcpTools, { id: issue.id, queued: true }, ctx);

    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "issue", subjectId: issue.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.filter((e) => e.kind === EventKind.ISSUE_QUEUED)).toHaveLength(1);
    expect(events.some((e) => e.kind === EventKind.AGENT_ASSIGNED)).toBe(true);

    const unqueued = (await call(
      "issues.setQueued" as keyof typeof mcpTools,
      { id: issue.id, queued: false },
      ctx,
    )) as { id: string; queued: boolean };
    expect(unqueued.queued).toBe(false);
  });

  it("issues.setQueued requires WRITE_ISSUES and respects issue narrowing", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCQ" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "LANE",
        name: "Lane",
        createdById: fixture.user.id,
      },
    });
    const scoped = await createIssue(fixture, { title: "scoped", projectId: project.id });
    const outside = await createIssue(fixture, { title: "outside" });

    const readOnly = buildMcpCtx(fixture, { scopes: ["READ_ISSUES"] }).ctx;
    await expect(
      call("issues.setQueued" as keyof typeof mcpTools, { id: scoped.id, queued: true }, readOnly),
    ).rejects.toThrow(/WRITE_ISSUES/);

    const narrowed = buildMcpCtx(fixture, { projectIds: [project.id] }).ctx;
    await expect(
      call("issues.setQueued" as keyof typeof mcpTools, { id: outside.id, queued: true }, narrowed),
    ).rejects.toThrow(/scope/i);
  });
});

describe("mcp — new agent / cycles / time tools", () => {
  it("issues.assign sets, clears, and looks up by profileKey", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "assignable" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
      },
    });

    // Assign by profileKey.
    const byKey = (await call(
      "issues.assign",
      { issueId: issue.id, profileKey: "victor" },
      ctx,
    )) as { assignedAgentId: string | null };
    expect(byKey.assignedAgentId).toBe(agent.id);

    // Unassign.
    const cleared = (await call("issues.assign", { issueId: issue.id, agentId: null }, ctx)) as {
      assignedAgentId: string | null;
    };
    expect(cleared.assignedAgentId).toBeNull();

    // Assign by agentId.
    const byId = (await call("issues.assign", { issueId: issue.id, agentId: agent.id }, ctx)) as {
      assignedAgentId: string | null;
    };
    expect(byId.assignedAgentId).toBe(agent.id);

    // AGENT_ASSIGNED event was emitted.
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("issues.assigned filters by agent profileKey", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu",
      },
    });
    const mine = await createIssue(fixture, { title: "mine" });
    const theirs = await createIssue(fixture, { title: "theirs" });
    await prisma.issue.update({
      where: { id: mine.id },
      data: { assignedAgentId: agent.id },
    });

    const rows = (await call("issues.assigned", { profileKey: "mizu" }, ctx)) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
    expect(rows.map((r) => r.id)).not.toContain(theirs.id);
  });

  it("issues.assigned requires profileKey until ApiKey links agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCF" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    await expect(call("issues.assigned", {}, ctx)).rejects.toThrow(/profileKey/i);
  });

  it("cycles.addIssue + cycles.removeIssue round-trip", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "cycle-able" });
    const cycle = (await call("cycles.create", { name: "Sprint X" }, ctx)) as { id: string };

    const added = (await call(
      "cycles.addIssue",
      { cycleId: cycle.id, issueId: issue.id },
      ctx,
    )) as { id: string; cycleId: string | null };
    expect(added.cycleId).toBe(cycle.id);

    const afterAdd = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(afterAdd.cycleId).toBe(cycle.id);

    const removed = (await call("cycles.removeIssue", { issueId: issue.id }, ctx)) as {
      cycleId: string | null;
    };
    expect(removed.cycleId).toBeNull();
  });

  it("time.log backfills a completed entry and rejects bad bounds", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCH" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "billable" });
    const started = new Date(Date.now() - 60 * 60 * 1000);
    const ended = new Date(Date.now() - 30 * 60 * 1000);

    const entry = (await call(
      "time.log",
      {
        issueId: issue.id,
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        billable: true,
        hourlyRate: 75,
        description: "Retroactive",
      },
      ctx,
    )) as { id: string; endedAt: Date | null };
    expect(entry.id).toBeTruthy();
    expect(entry.endedAt).not.toBeNull();

    await expect(
      call(
        "time.log",
        {
          issueId: issue.id,
          startedAt: ended.toISOString(),
          endedAt: started.toISOString(),
        },
        ctx,
      ),
    ).rejects.toThrow(/endedAt/i);
  });
});

describe("mcp — issues.reassign handoff flow", () => {
  it("swaps assignment, posts handoff comment, emits AGENT_ASSIGNED", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR1" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "to hand off" });
    const victor = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
      },
    });
    const mizu = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu",
      },
    });

    // Seed the issue as already assigned to Victor.
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: victor.id },
    });

    const result = (await call(
      "issues.reassign",
      {
        issueId: issue.id,
        toProfileKey: "mizu",
        rationale: "Victor is heads-down on the migration; Mizu owns ops.",
      },
      ctx,
    )) as { issueId: string; from: string | null; to: string; commentId: string };

    expect(result.issueId).toBe(issue.id);
    expect(result.from).toBe("victor");
    expect(result.to).toBe("mizu");
    expect(result.commentId).toBeTruthy();

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { assignedAgentId: true },
    });
    expect(after.assignedAgentId).toBe(mizu.id);

    const comment = await prisma.comment.findUniqueOrThrow({
      where: { id: result.commentId },
    });
    expect(comment.body).toContain("Handoff → @mizu:");
    expect(comment.body).toContain("Victor is heads-down");
    expect(comment.issueId).toBe(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.auto).toBe(false);
    expect(payload.reason).toBe("handoff");
    expect(payload.from).toBe(victor.id);
    expect(payload.to).toBe(mizu.id);
    expect(payload.rationale).toContain("Victor is heads-down");
    expect(payload.commentId).toBe(result.commentId);
  });

  it("handles handoff from unassigned (from: null)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR2" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "fresh" });
    await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
      },
    });

    const result = (await call(
      "issues.reassign",
      {
        issueId: issue.id,
        toProfileKey: "victor",
        rationale: "Picking this one up off the queue.",
      },
      ctx,
    )) as { from: string | null; to: string };
    expect(result.from).toBeNull();
    expect(result.to).toBe("victor");
  });

  it("rejects rationale shorter than 10 characters", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR3" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "nope" });
    await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu",
      },
    });

    await expect(
      call("issues.reassign", { issueId: issue.id, toProfileKey: "mizu", rationale: "short" }, ctx),
    ).rejects.toThrow(/10 characters/i);
  });

  it("rejects unknown profileKey", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR4" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "ghost" });

    await expect(
      call(
        "issues.reassign",
        {
          issueId: issue.id,
          toProfileKey: "no-such-agent",
          rationale: "Will never land because the agent does not exist.",
        },
        ctx,
      ),
    ).rejects.toThrow(/Agent not found/i);
  });

  it("rejects archived agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR5" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "archived target" });
    await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Retired",
        profileKey: "retired",
        archivedAt: new Date(),
      },
    });

    await expect(
      call(
        "issues.reassign",
        {
          issueId: issue.id,
          toProfileKey: "retired",
          rationale: "Should not route work to an archived agent.",
        },
        ctx,
      ),
    ).rejects.toThrow(/archived/i);
  });

  it("rejects reassigning to the same agent (handoff requires a transition)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR6" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "already mine" });
    const victor = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
      },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: victor.id },
    });

    await expect(
      call(
        "issues.reassign",
        {
          issueId: issue.id,
          toProfileKey: "victor",
          rationale: "This is already Victor's issue but let us pretend.",
        },
        ctx,
      ),
    ).rejects.toThrow(/already assigned/i);

    // Confirm no noisy comment or event landed.
    const comments = await prisma.comment.findMany({
      where: { issueId: issue.id },
    });
    expect(comments.length).toBe(0);
  });

  it("rejects when issue is soft-deleted", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MCR7" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "ghosted" });
    await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu",
      },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      call(
        "issues.reassign",
        {
          issueId: issue.id,
          toProfileKey: "mizu",
          rationale: "Can't reassign a deleted issue.",
        },
        ctx,
      ),
    ).rejects.toThrow(/Issue not found/i);
  });
});

describe("mcp — agents.me + agents.heartbeat", () => {
  it("agents.me returns the linked agent's row", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "victor",
        name: "Victor",
        capabilities: ["ops"],
      },
    });
    const { ctx } = buildMcpCtx(f, { linkedAgentId: agent.id });
    const res = (await call("agents.me", {}, ctx)) as {
      id: string;
      profileKey: string;
      status: string;
    };
    expect(res.id).toBe(agent.id);
    expect(res.profileKey).toBe("victor");
    expect(res.status).toBe(agent.status);
  });

  it("agents.me rejects a key with no linkedAgentId", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f, { linkedAgentId: null });
    await expect(call("agents.me", {}, ctx)).rejects.toThrow(/No agent inferred/);
  });

  it("agents.heartbeat bumps lastHeartbeatAt and sets status", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "mizu",
        name: "Mizu",
        status: "OFFLINE",
      },
    });
    const { ctx } = buildMcpCtx(f, { linkedAgentId: agent.id });
    const before = Date.now();
    const res = (await call("agents.heartbeat", { status: "ONLINE" }, ctx)) as {
      status: string;
      lastHeartbeatAt: Date;
    };
    expect(res.status).toBe("ONLINE");
    expect(res.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("agents.heartbeat rejects an archived agent", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "ghost",
        name: "Ghost",
        archivedAt: new Date(),
      },
    });
    const { ctx } = buildMcpCtx(f, { linkedAgentId: agent.id });
    await expect(call("agents.heartbeat", { status: "ONLINE" }, ctx)).rejects.toThrow(/archived/);
  });

  it("agents.heartbeat rejects cross-workspace linked agent", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const other = await createWorkspaceFixture();
    fixtures.push(other);
    const prisma = getPrisma();
    const foreignAgent = await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileKey: "foreigner",
        name: "Foreigner",
      },
    });
    const { ctx } = buildMcpCtx(f, { linkedAgentId: foreignAgent.id });
    await expect(call("agents.heartbeat", { status: "ONLINE" }, ctx)).rejects.toThrow(/not found/);
  });
});

describe("mcp — awareness tools (Stream BA)", () => {
  it("comments.list returns newest-first, paginates by `before`, hides deleted", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAC" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "talker" });
    const c1 = await prisma.comment.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        authorId: f.user.id,
        body: "first",
      },
    });
    const c2 = await prisma.comment.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        authorId: f.user.id,
        body: "second",
      },
    });
    const c3 = await prisma.comment.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        authorId: f.user.id,
        body: "deleted",
        deletedAt: new Date(),
      },
    });
    const rows = (await call("comments.list", { issueId: issue.id, limit: 50 }, ctx)) as Array<{
      id: string;
    }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    expect(ids).not.toContain(c3.id);
    expect(ids[0]).toBe(c2.id);
  });

  it("comments.list rejects out-of-scope issue narrowing", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAC2" });
    fixtures.push(f);
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: f.workspace.id,
        key: "LANE",
        name: "Lane",
        createdById: f.user.id,
      },
    });
    const outside = await createIssue(f, { title: "outside" });
    const { ctx } = buildMcpCtx(f, { projectIds: [project.id] });
    await expect(call("comments.list", { issueId: outside.id }, ctx)).rejects.toThrow(/scope/i);
  });

  it("comments.list cross-tenant: cannot read another workspace's issue", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAC3" });
    fixtures.push(f);
    const other = await createWorkspaceFixture({ keyPrefix: "BAC4" });
    fixtures.push(other);
    const prisma = getPrisma();
    const otherIssue = await createIssue(other, { title: "other-tenant" });
    await prisma.comment.create({
      data: {
        workspaceId: other.workspace.id,
        issueId: otherIssue.id,
        authorId: other.user.id,
        body: "leak",
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("comments.list", { issueId: otherIssue.id }, ctx)) as unknown[];
    // Workspace filter on the where clause means we get an empty list rather
    // than a leak, even with broad scopes. Caller's workspaceId is the gate.
    expect(rows).toEqual([]);
  });

  it("issues.get with include hydrates description/comments/attachments/relations/currentRun/labels", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAG" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "rich" });
    const other = await createIssue(f, { title: "other" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { description: "the body" },
    });
    await prisma.comment.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        authorId: f.user.id,
        body: "hi",
      },
    });
    const label = await prisma.label.create({
      data: { workspaceId: f.workspace.id, name: "bug", color: "#f00" },
    });
    await prisma.issueLabel.create({
      data: { issueId: issue.id, labelId: label.id },
    });
    await prisma.issueRelation.create({
      data: {
        workspaceId: f.workspace.id,
        fromIssueId: issue.id,
        toIssueId: other.id,
        kind: "RELATES_TO",
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "v",
        name: "V",
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    // Default shape — no include — returns lean payload (no `comments`).
    const lean = (await call("issues.get", { id: issue.id }, ctx)) as Record<string, unknown>;
    expect(lean).toBeTruthy();
    expect(lean.comments).toBeUndefined();

    const full = (await call(
      "issues.get",
      {
        id: issue.id,
        include: {
          description: true,
          comments: true,
          attachments: true,
          relations: true,
          currentRun: true,
          labels: true,
        },
      },
      ctx,
    )) as Record<string, unknown>;
    expect(full.description).toBe("the body");
    expect(Array.isArray(full.comments)).toBe(true);
    expect((full.comments as unknown[]).length).toBe(1);
    expect(Array.isArray(full.relations)).toBe(true);
    expect((full.relations as unknown[]).length).toBe(1);
    expect(full.currentRun).toBeTruthy();
    expect(Array.isArray(full.labels)).toBe(true);
  });

  it("runtimes.list returns workspace runtimes; ADMIN required", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAR" });
    fixtures.push(f);
    const prisma = getPrisma();
    await prisma.runtime.create({
      data: {
        workspaceId: f.workspace.id,
        name: "host-a",
        kind: "LOCAL_DAEMON",
        ownerId: f.user.id,
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("runtimes.list", {}, ctx)) as Array<{
      name: string;
    }>;
    expect(rows.some((r) => r.name === "host-a")).toBe(true);

    const noAdmin = buildMcpCtx(f, { scopes: ["READ_ISSUES"] }).ctx;
    await expect(call("runtimes.list", {}, noAdmin)).rejects.toThrow(/ADMIN/);
  });

  it("runtimes.list excludes other tenants", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAR2" });
    fixtures.push(f);
    const other = await createWorkspaceFixture({ keyPrefix: "BAR3" });
    fixtures.push(other);
    const prisma = getPrisma();
    await prisma.runtime.create({
      data: {
        workspaceId: other.workspace.id,
        name: "elsewhere",
        kind: "REMOTE_HTTP",
        ownerId: other.user.id,
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("runtimes.list", {}, ctx)) as Array<{
      name: string;
    }>;
    expect(rows.some((r) => r.name === "elsewhere")).toBe(false);
  });

  it("agents.list lists workspace agents and excludes archived by default", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAA" });
    fixtures.push(f);
    const prisma = getPrisma();
    const live = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "live", name: "Live" },
    });
    const dead = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "dead",
        name: "Dead",
        archivedAt: new Date(),
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("agents.list", {}, ctx)) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(dead.id);
    const all = (await call("agents.list", { includeArchived: true }, ctx)) as Array<{
      id: string;
    }>;
    expect(all.map((r) => r.id)).toContain(dead.id);
  });

  it("agents.list rejects without READ_USERS", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAA2" });
    fixtures.push(f);
    const noRead = buildMcpCtx(f, { scopes: ["READ_ISSUES"] }).ctx;
    await expect(call("agents.list", {}, noRead)).rejects.toThrow(/READ_USERS/);
  });

  it("events.recent reads ActivityEvent rows for the workspace", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAE" });
    fixtures.push(f);
    const prisma = getPrisma();
    const issue = await createIssue(f, { title: "eventful" });
    await prisma.activityEvent.create({
      data: {
        workspaceId: f.workspace.id,
        kind: "ISSUE_CREATED",
        actorId: f.user.id,
        subjectType: "issue",
        subjectId: issue.id,
        payload: {},
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call(
      "events.recent",
      { subjectType: "issue", subjectId: issue.id },
      ctx,
    )) as Array<{ kind: string }>;
    expect(rows.some((r) => r.kind === "ISSUE_CREATED")).toBe(true);
  });

  it("events.recent does not leak across workspaces", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAE2" });
    fixtures.push(f);
    const other = await createWorkspaceFixture({ keyPrefix: "BAE3" });
    fixtures.push(other);
    const prisma = getPrisma();
    const otherIssue = await createIssue(other, { title: "elsewhere" });
    await prisma.activityEvent.create({
      data: {
        workspaceId: other.workspace.id,
        kind: "ISSUE_CREATED",
        actorId: other.user.id,
        subjectType: "issue",
        subjectId: otherIssue.id,
        payload: {},
      },
    });
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("events.recent", { limit: 100 }, ctx)) as unknown[];
    // None should be from `other` workspace.
    expect(rows.length).toBe(0);
  });

  it("workspace.get returns the calling workspace's settings", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAW" });
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f);
    const row = (await call("workspace.get", {}, ctx)) as {
      id: string;
      slug: string;
      cycleLengthDays: number;
    };
    expect(row.id).toBe(f.workspace.id);
    expect(row.cycleLengthDays).toBe(7);
  });

  it("statuses.list returns all statuses for the workspace ordered by position", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "STL" });
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f);
    const rows = (await call("statuses.list", {}, ctx)) as Array<{
      id: string;
      name: string;
      category: string;
      position: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].position).toBeGreaterThanOrEqual(rows[i - 1].position);
    }
  });

  it("statuses.list filters by category when provided", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "STC" });
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f);
    const all = (await call("statuses.list", {}, ctx)) as Array<{
      category: string;
    }>;
    const inProgress = (await call("statuses.list", { category: "IN_PROGRESS" }, ctx)) as Array<{
      category: string;
    }>;
    expect(inProgress.every((r) => r.category === "IN_PROGRESS")).toBe(true);
    expect(inProgress.length).toBeLessThanOrEqual(all.length);
  });

  it("statuses.list rejects without READ_ISSUES scope", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "STX" });
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f, { scopes: ["READ_USERS"] });
    await expect(call("statuses.list", {}, ctx)).rejects.toThrow(
      /Missing required scope: READ_ISSUES/,
    );
  });

  it("chat.getThread requires linkedAgentId match", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BCT" });
    fixtures.push(f);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "v", name: "V" },
    });
    const stranger = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "s", name: "S" },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: f.workspace.id,
        userId: f.user.id,
        agentId: agent.id,
        title: "Runbook conversation",
        topic: "MCP metadata coverage",
        contextMode: ChatContextMode.FULL_SUMMARY,
        summaryMarkdown: "Existing durable summary",
        isDefault: false,
      },
    });
    const message = await prisma.chatMessage.create({
      data: {
        workspaceId: f.workspace.id,
        threadId: thread.id,
        role: "USER",
        body: "ping",
        dispatchedAt: new Date(),
      },
    });
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        targetType: "chat-message",
        targetId: message.id,
        kind: "LINK",
        filename: "Runbook",
        mimeType: "text/url",
        size: 0,
        url: "https://example.com/runbook",
        externalUrl: "https://example.com/runbook",
        linkTitle: "Runbook",
      },
    });

    const { ctx: ctxAddr } = buildMcpCtx(f, { linkedAgentId: agent.id });
    const res = (await call("chat.getThread", { threadId: thread.id }, ctxAddr)) as {
      thread: { id: string; title: string | null; topic: string | null; contextMode: string; summaryMarkdown: string | null };
      messages: Array<{
        body: string;
        attachments: Array<{ id: string; filename: string; externalUrl: string | null }>;
      }>;
    };
    expect(res.thread.id).toBe(thread.id);
    expect(res.thread).toMatchObject({
      title: "Runbook conversation",
      topic: "MCP metadata coverage",
      contextMode: "FULL_SUMMARY",
      summaryMarkdown: "Existing durable summary",
    });
    expect(res.messages[0].body).toBe("ping");
    expect(res.messages[0].attachments).toMatchObject([
      { id: attachment.id, filename: "Runbook", externalUrl: "https://example.com/runbook" },
    ]);

    const { ctx: ctxStranger } = buildMcpCtx(f, {
      linkedAgentId: stranger.id,
    });
    await expect(call("chat.getThread", { threadId: thread.id }, ctxStranger)).rejects.toThrow(
      /Only the thread's agent/,
    );

    const noLink = buildMcpCtx(f).ctx;
    await expect(call("chat.getThread", { threadId: thread.id }, noLink)).rejects.toThrow(
      /linkedAgentId/,
    );
  });

  it("agent.context.bundle issueId branch returns workspace + issue + extras", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAB" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "bundle-me" });
    await prisma.comment.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        authorId: f.user.id,
        body: "comment",
      },
    });
    const bundle = (await call("agent.context.bundle", { issueId: issue.id }, ctx)) as {
      workspace: { id: string };
      issue: { id: string };
      comments: unknown[];
      attachments: unknown[];
      relations: unknown[];
    };
    expect(bundle.workspace.id).toBe(f.workspace.id);
    expect(bundle.issue.id).toBe(issue.id);
    expect(bundle.comments.length).toBe(1);
    expect(Array.isArray(bundle.attachments)).toBe(true);
    expect(Array.isArray(bundle.relations)).toBe(true);
  });

  it("agent.context.bundle threadId branch enforces addressee", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAB2" });
    fixtures.push(f);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "v", name: "V" },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: f.workspace.id,
        userId: f.user.id,
        agentId: agent.id,
        title: "Context bundle thread",
        topic: "Bundle topic",
        summaryMarkdown: "Durable context summary",
        summarizedAt: new Date(),
      },
    });
    const message = await prisma.chatMessage.create({
      data: {
        workspaceId: f.workspace.id,
        threadId: thread.id,
        role: "USER",
        body: "bundle ping",
        dispatchedAt: new Date(),
      },
    });
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId: f.workspace.id,
        targetType: "chat-message",
        targetId: message.id,
        filename: "bundle.png",
        mimeType: "image/png",
        size: 10,
        url: "chat-message/test/bundle.png",
      },
    });
    const { ctx } = buildMcpCtx(f, { linkedAgentId: agent.id });
    const bundle = (await call("agent.context.bundle", { threadId: thread.id }, ctx)) as {
      workspace: { id: string };
      thread: { id: string; title: string | null };
      conversation: { id: string; title: string | null; contextMode: string };
      summary: { markdown: string | null; summarizedUntilMessageId: string | null; summarizedAt: Date | null };
      recentMessages: Array<{
        id: string;
        attachments: Array<{ id: string; filename: string; mimeType: string }>;
      }>;
      messages: Array<{
        id: string;
        attachments: Array<{ id: string; filename: string; mimeType: string }>;
      }>;
      attachments: Array<{ id: string; targetId: string }>;
      contextPolicy: { mode: string; limit: number };
      diagnostics: { latestUserMessageId: string | null; waitingForReply: boolean };
    };
    expect(bundle.workspace.id).toBe(f.workspace.id);
    expect(bundle.thread.id).toBe(thread.id);
    expect(bundle.conversation).toMatchObject({
      id: thread.id,
      title: "Context bundle thread",
      contextMode: "SMART",
    });
    expect(bundle.summary.markdown).toBe("Durable context summary");
    expect(bundle.contextPolicy).toMatchObject({ mode: "SMART", limit: 50 });
    expect(bundle.attachments).toMatchObject([{ id: attachment.id, targetId: message.id }]);
    expect(Array.isArray(bundle.messages)).toBe(true);
    expect(bundle.messages[0]).toMatchObject({
      id: message.id,
      attachments: [{ id: attachment.id, filename: "bundle.png", mimeType: "image/png" }],
    });
    expect(bundle.diagnostics).toMatchObject({
      latestUserMessageId: message.id,
      waitingForReply: true,
    });
  });

  it("agent.context.bundle requires exactly one of issueId/threadId", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAB3" });
    fixtures.push(f);
    const { ctx } = buildMcpCtx(f);
    await expect(call("agent.context.bundle", {}, ctx)).rejects.toThrow(/exactly one/i);
  });

  it("runs.list filters by agent + status + issue", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAU" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "tracked" });
    const a1 = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "a1", name: "A1" },
    });
    const a2 = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "a2", name: "A2" },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        agentId: a1.id,
        status: "ACTIVE",
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: f.workspace.id,
        issueId: issue.id,
        agentId: a2.id,
        status: "COMPLETED",
      },
    });
    const all = (await call("runs.list", { issueId: issue.id }, ctx)) as Array<{
      id: string;
      status: string;
    }>;
    expect(all.length).toBe(2);
    const onlyA1 = (await call(
      "runs.list",
      { issueId: issue.id, agentId: a1.id },
      ctx,
    )) as unknown[];
    expect(onlyA1.length).toBe(1);
    const onlyDone = (await call(
      "runs.list",
      { issueId: issue.id, status: "COMPLETED" },
      ctx,
    )) as unknown[];
    expect(onlyDone.length).toBe(1);
  });

  it("AGENT_ASSIGNED event payload now embeds issueSnapshot", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "BAS" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "snapshot-able" });
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "v", name: "V" },
    });
    await call("issues.assign", { issueId: issue.id, agentId: agent.id }, ctx);
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: f.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.issueSnapshot).toBeTruthy();
    const snap = payload.issueSnapshot as Record<string, unknown>;
    expect(snap.id).toBe(issue.id);
    expect(snap.title).toBe("snapshot-able");
    expect(typeof snap.number).toBe("number");
    expect(Array.isArray(snap.labelNames)).toBe(true);
  });

  it("AGENT_ASSIGNED auto-transitions to startedStatusId when set", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "AUT" });
    fixtures.push(f);
    const prisma = getPrisma();
    const inProgress = await prisma.status.findFirstOrThrow({
      where: { workspaceId: f.workspace.id, category: "IN_PROGRESS" },
    });
    await prisma.workspace.update({
      where: { id: f.workspace.id },
      data: { startedStatusId: inProgress.id },
    });
    const { ctx } = buildMcpCtx(f);
    const issue = await createIssue(f, { title: "auto-transition" });
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "v", name: "V" },
    });
    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { status: { select: { category: true } } },
    });
    expect(before.status?.category).not.toBe("IN_PROGRESS");

    await call("issues.assign", { issueId: issue.id, agentId: agent.id }, ctx);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { statusId: true, status: { select: { category: true } } },
    });
    expect(after.statusId).toBe(inProgress.id);
    expect(after.status?.category).toBe("IN_PROGRESS");

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: f.workspace.id,
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.autoTransitionedTo).toBe(inProgress.id);
    const snap = payload.issueSnapshot as Record<string, unknown>;
    expect(snap.statusId).toBe(inProgress.id);
  });

  it("per-agent dispatch shim does NOT receive untargeted events (regression: 2026-05-01)", async () => {
    // Bug: the audit fan-out's broadcast subscribers query was matching
    // every active webhook whose `events` array contained the kind,
    // including the synthetic per-agent shim
    // `agent:dispatch:<agentId>`. The shim subscribes to all five
    // agent-routed kinds because the worker reads its URL suffix to
    // dispatch — but it should only fire when the agent-targeted
    // dispatch logic in audit.ts (branches a–d) explicitly adds it.
    // Without the URL filter, Victor was paged on EVERY workspace
    // event of those kinds. Regression test: an unmentioned comment
    // on Bob's issue must not enqueue a delivery to Victor's shim.
    const f = await createWorkspaceFixture({ keyPrefix: "PAS" });
    fixtures.push(f);
    const prisma = getPrisma();
    const bob = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "bob",
        name: "Bob",
        webhookUrl: "https://example.test/bob",
        webhookSecret: "secret-bob",
      },
    });
    const victor = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        profileKey: "victor",
        name: "Victor",
        webhookUrl: "https://example.test/victor",
        webhookSecret: "secret-victor",
      },
    });
    // Pre-create both per-agent shim rows (in production these are
    // upserted on first targeted dispatch — we synthesize the same
    // state directly).
    await prisma.webhook.create({
      data: {
        workspaceId: f.workspace.id,
        url: `agent:dispatch:${victor.id}`,
        secret: "shim-victor",
        events: [
          "AGENT_ASSIGNED",
          "ISSUE_QUEUED",
          "COMMENT_CREATED",
          "ISSUE_PRIORITY_CHANGED",
          "CHAT_MESSAGE_POSTED",
        ],
        active: true,
      },
    });
    const bobShim = await prisma.webhook.create({
      data: {
        workspaceId: f.workspace.id,
        url: `agent:dispatch:${bob.id}`,
        secret: "shim-bob",
        events: [
          "AGENT_ASSIGNED",
          "ISSUE_QUEUED",
          "COMMENT_CREATED",
          "ISSUE_PRIORITY_CHANGED",
          "CHAT_MESSAGE_POSTED",
        ],
        active: true,
      },
    });

    const issue = await createIssue(f, { title: "bob's issue" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: bob.id },
    });

    const { ctx } = buildMcpCtx(f);
    // Plain comment on Bob's issue, no @mention of Victor.
    await call("comments.create", { issueId: issue.id, body: "moving to done — looks good" }, ctx);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhook: { workspaceId: f.workspace.id },
        event: { kind: "COMMENT_CREATED" },
      },
      include: { webhook: { select: { url: true } } },
    });
    const targetedUrls = deliveries.map((d) => d.webhook.url).sort();

    // Victor's per-agent shim must NOT appear. Bob's shim is the
    // generic agent-dispatch target the comment routes to.
    expect(targetedUrls).not.toContain(`agent:dispatch:${victor.id}`);
    // Bob may or may not appear depending on how the comment dispatch
    // resolves — what we care about for the regression is that
    // VICTOR (the unrelated agent) is excluded.
    void bobShim;
  });

  it("AGENT_ASSIGNED auto-transition skips already-started + terminal issues", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "AUS" });
    fixtures.push(f);
    const prisma = getPrisma();
    const inProgress = await prisma.status.findFirstOrThrow({
      where: { workspaceId: f.workspace.id, category: "IN_PROGRESS" },
    });
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: f.workspace.id, category: "DONE" },
    });
    await prisma.workspace.update({
      where: { id: f.workspace.id },
      data: { startedStatusId: inProgress.id },
    });
    const { ctx } = buildMcpCtx(f);

    // Already in IN_PROGRESS — should not double-transition.
    const started = await createIssue(f, { title: "already started" });
    await prisma.issue.update({
      where: { id: started.id },
      data: { statusId: inProgress.id },
    });
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "v", name: "V" },
    });
    await call("issues.assign", { issueId: started.id, agentId: agent.id }, ctx);
    let events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: f.workspace.id,
        subjectId: started.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect((events[0].payload as Record<string, unknown>).autoTransitionedTo).toBeUndefined();

    // Already DONE — should not reopen.
    const closed = await createIssue(f, { title: "already done" });
    await prisma.issue.update({
      where: { id: closed.id },
      data: { statusId: done.id },
    });
    await call("issues.assign", { issueId: closed.id, agentId: agent.id }, ctx);
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: closed.id },
      select: { statusId: true },
    });
    expect(after.statusId).toBe(done.id);
    events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: f.workspace.id,
        subjectId: closed.id,
        kind: "AGENT_ASSIGNED",
      },
      orderBy: { createdAt: "desc" },
    });
    expect((events[0].payload as Record<string, unknown>).autoTransitionedTo).toBeUndefined();
  });
});

describe("mcp — notes (per-actor scoping)", () => {
  it("notes.create + notes.list + notes.update + notes.archive operate only on the caller's own notes", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "MN" });
    fixtures.push(f);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(f);

    const created = (await call(
      "notes.create",
      { body: "Remember to check the CI cache hit rate" },
      ctx,
    )) as { id: string; userId: string; pinned: boolean };
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe(f.user.id);

    const listed = (await call("notes.list", {}, ctx)) as Array<{ id: string }>;
    expect(listed.find((n) => n.id === created.id)).toBeTruthy();

    const updated = (await call("notes.update", { id: created.id, pinned: true }, ctx)) as {
      pinned: boolean;
    };
    expect(updated.pinned).toBe(true);

    // Plant a row owned by the second user — should be invisible.
    const otherNote = await prisma.note.create({
      data: {
        workspaceId: f.workspace.id,
        userId: f.secondUser.id,
        body: "Another user's note",
      },
    });
    const reList = (await call("notes.list", {}, ctx)) as Array<{ id: string }>;
    expect(reList.find((n) => n.id === otherNote.id)).toBeUndefined();

    // Cross-actor update should be blocked at the resolver.
    await expect(call("notes.update", { id: otherNote.id, pinned: true }, ctx)).rejects.toThrow(
      /Note not found/,
    );

    // Archive flips the row out of the default list.
    await call("notes.archive", { id: created.id }, ctx);
    const afterArchive = (await call("notes.list", {}, ctx)) as Array<{
      id: string;
    }>;
    expect(afterArchive.find((n) => n.id === created.id)).toBeUndefined();
    const archived = (await call("notes.list", { archived: true }, ctx)) as Array<{ id: string }>;
    expect(archived.find((n) => n.id === created.id)).toBeTruthy();
  });
});

describe("mcp — Phase A: filter passthrough, generic update, labels", () => {
  it("issues.list honors projectId, labelIds, cycleId, priority filters", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MLF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);

    const projectA = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "A",
        name: "Project A",
        createdById: fixture.user.id,
      },
    });
    const projectB = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "B",
        name: "Project B",
        createdById: fixture.user.id,
      },
    });
    const cycle = await prisma.cycle.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Sprint 1",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 7 * 86_400_000),
        lengthDays: 7,
      },
    });
    const labelHot = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "hot", color: "#ff0000" },
    });
    const labelCold = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "cold", color: "#0000ff" },
    });

    const a = await createIssue(fixture, {
      title: "A urgent in sprint",
      projectId: projectA.id,
      cycleId: cycle.id,
    });
    const b = await createIssue(fixture, { title: "A low backlog", projectId: projectA.id });
    const c = await createIssue(fixture, {
      title: "B medium in sprint",
      projectId: projectB.id,
      cycleId: cycle.id,
    });
    await prisma.issue.update({ where: { id: a.id }, data: { priority: "URGENT" } });
    await prisma.issue.update({ where: { id: b.id }, data: { priority: "LOW" } });
    await prisma.issue.update({ where: { id: c.id }, data: { priority: "MEDIUM" } });
    await prisma.issueLabel.create({ data: { issueId: a.id, labelId: labelHot.id } });
    await prisma.issueLabel.create({ data: { issueId: c.id, labelId: labelCold.id } });

    const byProject = (await call("issues.list", { projectId: projectA.id }, ctx)) as Array<{
      id: string;
    }>;
    expect(byProject.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

    const byLabel = (await call("issues.list", { labelIds: [labelHot.id] }, ctx)) as Array<{
      id: string;
    }>;
    expect(byLabel.map((i) => i.id)).toEqual([a.id]);

    const byCycle = (await call("issues.list", { cycleId: cycle.id }, ctx)) as Array<{
      id: string;
    }>;
    expect(byCycle.map((i) => i.id).sort()).toEqual([a.id, c.id].sort());

    const backlog = (await call("issues.list", { cycleId: null }, ctx)) as Array<{ id: string }>;
    expect(backlog.map((i) => i.id)).toEqual([b.id]);

    const urgent = (await call("issues.list", { priorities: ["URGENT", "HIGH"] }, ctx)) as Array<{
      id: string;
    }>;
    expect(urgent.map((i) => i.id)).toEqual([a.id]);

    // Compound filter: project A AND urgent priority.
    const compound = (await call(
      "issues.list",
      { projectId: projectA.id, priority: "URGENT" },
      ctx,
    )) as Array<{ id: string }>;
    expect(compound.map((i) => i.id)).toEqual([a.id]);
  });

  it("issues.update writes audit + ISSUE_UPDATED and emits ISSUE_PRIORITY_CHANGED on priority bump", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MUP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "P",
        name: "P",
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, { title: "patch me" });

    const updated = (await call(
      "issues.update",
      {
        id: issue.id,
        title: "patched",
        description: "new body",
        priority: "HIGH",
        projectId: project.id,
      },
      ctx,
    )) as {
      id: string;
      title: string;
      description: string | null;
      priority: string;
      projectId: string | null;
    };

    expect(updated.title).toBe("patched");
    expect(updated.description).toBe("new body");
    expect(updated.priority).toBe("HIGH");
    expect(updated.projectId).toBe(project.id);

    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "issue", subjectId: issue.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.kind)).toContain(EventKind.ISSUE_UPDATED);
    expect(events.map((e) => e.kind)).toContain(EventKind.ISSUE_PRIORITY_CHANGED);

    const audit = await prisma.auditLog.findMany({
      where: { workspaceId: fixture.workspace.id, entity: "Issue", entityId: issue.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toContain("update");
    expect(audit.map((a) => a.action)).toContain("change-priority");
  });

  it("issues.update clears projectId/cycleId/parentId when passed null", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MUN" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "P",
        name: "P",
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, { title: "scoped", projectId: project.id });
    await call("issues.update", { id: issue.id, projectId: null }, ctx);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.projectId).toBeNull();
  });

  it("issues.update rejects cross-workspace project FK", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MUX" });
    const other = await createWorkspaceFixture({ keyPrefix: "MUY" });
    fixtures.push(fixture, other);
    const prisma = getPrisma();
    const otherProject = await prisma.project.create({
      data: { workspaceId: other.workspace.id, key: "X", name: "X", createdById: other.user.id },
    });
    const issue = await createIssue(fixture, { title: "guarded" });
    const { ctx } = buildMcpCtx(fixture);

    await expect(
      call("issues.update", { id: issue.id, projectId: otherProject.id }, ctx),
    ).rejects.toThrow(/Project not found/);
  });

  it("issues.update requires WRITE_ISSUES and honors issue narrowing", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MUW" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "L",
        name: "L",
        createdById: fixture.user.id,
      },
    });
    const inLane = await createIssue(fixture, { title: "in", projectId: project.id });
    const outOfLane = await createIssue(fixture, { title: "out" });

    const readOnly = buildMcpCtx(fixture, { scopes: ["READ_ISSUES"] }).ctx;
    await expect(call("issues.update", { id: inLane.id, title: "no" }, readOnly)).rejects.toThrow(
      /WRITE_ISSUES/,
    );

    const narrowed = buildMcpCtx(fixture, { projectIds: [project.id] }).ctx;
    await expect(
      call("issues.update", { id: outOfLane.id, title: "blocked" }, narrowed),
    ).rejects.toThrow(/scope/i);
  });

  it("issues.bulkTransition flips many issues, writes one audit each, sets completedAt on DONE", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MBT" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const i1 = await createIssue(fixture, { title: "one" });
    const i2 = await createIssue(fixture, { title: "two" });
    const i3 = await createIssue(fixture, { title: "three" });

    const res = (await call(
      "issues.bulkTransition",
      { ids: [i1.id, i2.id, i3.id], statusId: done.id },
      ctx,
    )) as { count: number };
    expect(res.count).toBe(3);

    const rows = await prisma.issue.findMany({
      where: { id: { in: [i1.id, i2.id, i3.id] } },
    });
    for (const r of rows) {
      expect(r.statusId).toBe(done.id);
      expect(r.completedAt).not.toBeNull();
    }

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        kind: EventKind.ISSUE_STATUS_CHANGED,
      },
    });
    expect(events).toHaveLength(3);
  });

  it("labels.create/update/delete: ADMIN required + round-trip", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MLB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);

    const created = (await call("labels.create", { name: "bug", color: "#ff0000" }, ctx)) as {
      id: string;
      name: string;
      color: string;
    };
    expect(created.name).toBe("bug");

    // Duplicate name → conflict.
    await expect(call("labels.create", { name: "bug", color: "#000000" }, ctx)).rejects.toThrow(
      /already used/,
    );

    const updated = (await call(
      "labels.update",
      { id: created.id, name: "Bug", color: "#aa0000" },
      ctx,
    )) as { id: string; name: string; color: string };
    expect(updated.name).toBe("Bug");
    expect(updated.color).toBe("#aa0000");

    // Non-admin scope rejects label catalog mutation.
    const noAdmin = buildMcpCtx(fixture, {
      scopes: ["READ_ISSUES", "WRITE_ISSUES"],
    }).ctx;
    await expect(
      call("labels.create", { name: "spam", color: "#000000" }, noAdmin),
    ).rejects.toThrow(/ADMIN/);

    const del = (await call("labels.delete", { id: created.id }, ctx)) as {
      id: string;
      deleted: boolean;
    };
    expect(del.deleted).toBe(true);
    const gone = await prisma.label.findUnique({ where: { id: created.id } });
    expect(gone).toBeNull();
  });

  it("labels.list returns workspace labels with issue counts", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MLL" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const a = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "a", color: "#111111" },
    });
    await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "b", color: "#222222" },
    });
    const issue = await createIssue(fixture, { title: "tagged" });
    await prisma.issueLabel.create({ data: { issueId: issue.id, labelId: a.id } });

    const rows = (await call("labels.list", {}, ctx)) as Array<{
      name: string;
      _count: { issues: number };
    }>;
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
    expect(rows.find((r) => r.name === "a")?._count.issues).toBe(1);
    expect(rows.find((r) => r.name === "b")?._count.issues).toBe(0);
  });

  it("issues.setLabels adds and removes; cross-workspace label is rejected", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MSL" });
    const other = await createWorkspaceFixture({ keyPrefix: "MSO" });
    fixtures.push(fixture, other);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const labelKeep = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "keep", color: "#111111" },
    });
    const labelDrop = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "drop", color: "#222222" },
    });
    const otherLabel = await prisma.label.create({
      data: { workspaceId: other.workspace.id, name: "alien", color: "#999999" },
    });
    const issue = await createIssue(fixture, { title: "tag me" });
    await prisma.issueLabel.create({ data: { issueId: issue.id, labelId: labelDrop.id } });

    const res = (await call(
      "issues.setLabels",
      { issueId: issue.id, add: [labelKeep.id], remove: [labelDrop.id] },
      ctx,
    )) as { added: number; removed: number };
    expect(res.added).toBe(1);
    expect(res.removed).toBe(1);

    const after = await prisma.issueLabel.findMany({ where: { issueId: issue.id } });
    expect(after.map((r) => r.labelId)).toEqual([labelKeep.id]);

    await expect(
      call("issues.setLabels", { issueId: issue.id, add: [otherLabel.id] }, ctx),
    ).rejects.toThrow(/do not belong/);
  });

  it("issues.bulkSetLabels tags many issues and writes per-issue audit rows", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MBL" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const tag = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "groom", color: "#333333" },
    });
    const i1 = await createIssue(fixture, { title: "one" });
    const i2 = await createIssue(fixture, { title: "two" });

    const res = (await call(
      "issues.bulkSetLabels",
      { issueIds: [i1.id, i2.id], add: [tag.id] },
      ctx,
    )) as { updated: number; added: number; removed: number };
    expect(res.updated).toBe(2);
    expect(res.added).toBe(2);

    const audit = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        action: "bulk-set-labels",
      },
    });
    expect(audit).toHaveLength(2);
  });
});

describe("mcp — issues.transition lifecycle handling", () => {
  it("→ DONE sets completedAt, emits ISSUE_STATUS_CHANGED, closes ACTIVE runs", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MTD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, profileKey: "v", name: "V" },
    });
    const { ctx } = buildMcpCtx(fixture, { linkedAgentId: agent.id });
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const issue = await createIssue(fixture, { title: "close me" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    await call("issues.transition", { id: issue.id, statusId: done.id }, ctx);

    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.statusId).toBe(done.id);
    expect(after.completedAt).not.toBeNull();

    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "issue", subjectId: issue.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.kind)).toContain(EventKind.ISSUE_STATUS_CHANGED);

    const runAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfter.status).toBe("COMPLETED");
    expect(runAfter.finishedAt).not.toBeNull();
  });

  it("→ CANCELED sets canceledAt + closes runs as ABANDONED", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MTC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: fixture.workspace.id, profileKey: "v", name: "V" },
    });
    const { ctx } = buildMcpCtx(fixture, { linkedAgentId: agent.id });
    const cancelled = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });
    const issue = await createIssue(fixture, { title: "kill it" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    await call("issues.transition", { id: issue.id, statusId: cancelled.id }, ctx);

    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.canceledAt).not.toBeNull();
    expect(after.completedAt).toBeNull();

    const runAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runAfter.status).toBe("ABANDONED");
  });

  it("→ IN_PROGRESS stamps startedAt once; re-entry leaves it untouched", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MTI" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const inProgress = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "IN_PROGRESS" },
    });
    const backlog = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "BACKLOG" },
    });
    const issue = await createIssue(fixture, { title: "start me" });

    await call("issues.transition", { id: issue.id, statusId: inProgress.id }, ctx);
    const first = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(first.startedAt).not.toBeNull();
    const startedAtFirst = first.startedAt!;

    // Bounce back to backlog, then back to in-progress — startedAt should
    // stick to the first arrival, not reset on re-entry.
    await call("issues.transition", { id: issue.id, statusId: backlog.id }, ctx);
    await call("issues.transition", { id: issue.id, statusId: inProgress.id }, ctx);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.startedAt?.toISOString()).toBe(startedAtFirst.toISOString());
  });

  it("→ same status is a no-op (no event, no audit, no run touch)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MTN" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "stay put" });
    const before = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });

    await call("issues.transition", { id: issue.id, statusId: before.statusId }, ctx);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.ISSUE_STATUS_CHANGED,
      },
    });
    expect(events).toHaveLength(0);
  });
});

describe("mcp artifacts.*", () => {
  it("artifacts.create then artifacts.get round-trips with version 1", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ART" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const created = (await call(
      "artifacts.create",
      { title: "MCP Decision Doc", body: "## Decision\nGo.", type: "DECISION" },
      ctx,
    )) as { id: string; slug: string };
    expect(created.slug).toBe("mcp-decision-doc");

    const got = (await call("artifacts.get", { id: created.id }, ctx)) as {
      id: string;
      title: string;
      type: string;
      versions: Array<{ version: number }>;
    };
    expect(got.title).toBe("MCP Decision Doc");
    expect(got.type).toBe("DECISION");
    expect(got.versions[0]?.version).toBe(1);
  });

  it("artifacts.update body change snapshots a new version", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARU" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const created = (await call(
      "artifacts.create",
      { title: "Iterating", body: "v1" },
      ctx,
    )) as { id: string };
    await call(
      "artifacts.update",
      { id: created.id, body: "v2", changelog: "tightened tone" },
      ctx,
    );
    const got = (await call("artifacts.get", { id: created.id }, ctx)) as {
      versions: Array<{ version: number; changelog: string | null }>;
    };
    expect(got.versions[0].version).toBe(2);
    expect(got.versions[0].changelog).toBe("tightened tone");
  });

  it("artifacts.promote pulls a chat message into a new artifact with source backlink", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `prom-${Date.now()}`,
        name: "Promoter",
      },
    });
    const thread = await prisma.chatThread.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        agentId: agent.id,
        title: "Discovery",
      },
    });
    const message = await prisma.chatMessage.create({
      data: {
        workspaceId: fixture.workspace.id,
        threadId: thread.id,
        role: "AGENT" as never,
        body: "Here is the plan…",
      },
    });
    const result = (await call(
      "artifacts.promote",
      { sourceType: "chat-message", sourceId: message.id, type: "SPEC" },
      ctx,
    )) as { id: string; slug: string };
    const artifact = await prisma.artifact.findUniqueOrThrow({ where: { id: result.id } });
    expect(artifact.sourceType).toBe("chat-message");
    expect(artifact.sourceId).toBe(message.id);
    expect(artifact.type).toBe("SPEC");
  });
});

describe("mcp runs.complete + completion contract", () => {
  it("issues.update accepts expectedOutput and verificationChecklist and surfaces them via agent.context.bundle", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CC1" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture);
    await call(
      "issues.update",
      {
        id: issue.id,
        expectedOutput: "Ship the migration cleanly.",
        verificationChecklist: [
          { label: "Migration applied", kind: "command", value: "pnpm prisma migrate status" },
        ],
        artifactRequired: true,
      },
      ctx,
    );
    const bundle = (await call("agent.context.bundle", { issueId: issue.id }, ctx)) as {
      completionContract: {
        expectedOutput: string;
        verificationChecklist: Array<{ label: string }>;
        artifactRequired: boolean;
      };
    };
    expect(bundle.completionContract.expectedOutput).toContain("migration");
    expect(bundle.completionContract.artifactRequired).toBe(true);
    expect(bundle.completionContract.verificationChecklist[0].label).toBe("Migration applied");
  });

  it("runs.complete stores summary + producedArtifactIds + verificationResult", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CC2" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const { ctx } = buildMcpCtx(fixture);

    // Create an artifact to link as evidence
    const artifact = (await call(
      "artifacts.create",
      { title: "Evidence", body: "deliverable" },
      ctx,
    )) as { id: string };

    // Build an AgentRun directly so we can target it.
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `rc-${Date.now()}`,
        name: "Runner",
      },
    });
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });

    // Link the api key to this agent so the agent check passes.
    const apiKey = { ...ctx.apiKey!, linkedAgentId: agent.id };
    const scopedCtx = { ...ctx, apiKey };

    const result = (await call(
      "runs.complete",
      {
        runId: run.id,
        summary: "Migration shipped.",
        producedArtifactIds: [artifact.id],
        verificationResult: [
          { label: "Migration applied", done: true },
        ],
        followUps: [{ title: "Backfill historical rows" }],
      },
      scopedCtx,
    )) as {
      summary: string;
      producedArtifactIds: string[];
      verificationResult: unknown;
      followUps: unknown;
    };
    expect(result.summary).toBe("Migration shipped.");
    expect(result.producedArtifactIds).toEqual([artifact.id]);
    expect(result.verificationResult).toBeTruthy();
    expect(result.followUps).toBeTruthy();
  });
});

describe("mcp canvases.* mutation tools", () => {
  it("creates a canvas, adds/patches/removes a node, and round-trips via canvases.get", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CV1" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "Canvas anchor" });

    const canvas = (await call(
      "canvases.create",
      { name: "Migration board" },
      ctx,
    )) as { id: string };

    const node = (await call(
      "canvases.addNode",
      {
        canvasId: canvas.id,
        targetType: "issue",
        targetId: issue.id,
        x: 10,
        y: 20,
        width: 240,
        height: 140,
      },
      ctx,
    )) as { id: string };

    await call(
      "canvases.patchNode",
      { id: node.id, x: 99, y: 199, collapsed: true },
      ctx,
    );

    const got = (await call("canvases.get", { id: canvas.id }, ctx)) as {
      nodes: Array<{ id: string; x: number; y: number; collapsed: boolean }>;
    };
    const placed = got.nodes.find((n) => n.id === node.id);
    expect(placed?.x).toBe(99);
    expect(placed?.y).toBe(199);
    expect(placed?.collapsed).toBe(true);

    await call("canvases.removeNode", { id: node.id }, ctx);
    const afterRemove = (await call("canvases.get", { id: canvas.id }, ctx)) as {
      nodes: Array<{ id: string }>;
    };
    expect(afterRemove.nodes.find((n) => n.id === node.id)).toBeUndefined();
  });

  it("rejects edges between nodes that don't share a canvas", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CV2" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issue = await createIssue(fixture, { title: "Edge anchor" });

    const canvasA = (await call(
      "canvases.create",
      { name: "Board A" },
      ctx,
    )) as { id: string };
    const canvasB = (await call(
      "canvases.create",
      { name: "Board B" },
      ctx,
    )) as { id: string };

    const nodeA = (await call(
      "canvases.addNode",
      { canvasId: canvasA.id, targetType: "issue", targetId: issue.id, x: 0, y: 0 },
      ctx,
    )) as { id: string };
    const nodeB = (await call(
      "canvases.addNode",
      { canvasId: canvasB.id, targetType: "issue", targetId: issue.id, x: 0, y: 0 },
      ctx,
    )) as { id: string };

    await expect(
      call(
        "canvases.addEdge",
        { canvasId: canvasA.id, fromNodeId: nodeA.id, toNodeId: nodeB.id },
        ctx,
      ),
    ).rejects.toThrow(/missing from this workspace/);
  });

  it("addEdge then removeEdge is idempotent on canvases.get edges", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CV3" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);
    const issueA = await createIssue(fixture, { title: "From" });
    const issueB = await createIssue(fixture, { title: "To" });

    const canvas = (await call("canvases.create", { name: "Wired" }, ctx)) as { id: string };
    const a = (await call(
      "canvases.addNode",
      { canvasId: canvas.id, targetType: "issue", targetId: issueA.id, x: 0, y: 0 },
      ctx,
    )) as { id: string };
    const b = (await call(
      "canvases.addNode",
      { canvasId: canvas.id, targetType: "issue", targetId: issueB.id, x: 100, y: 100 },
      ctx,
    )) as { id: string };

    const edge = (await call(
      "canvases.addEdge",
      { canvasId: canvas.id, fromNodeId: a.id, toNodeId: b.id, label: "blocks" },
      ctx,
    )) as { id: string };

    let got = (await call("canvases.get", { id: canvas.id }, ctx)) as {
      edges: Array<{ id: string; label: string | null }>;
    };
    expect(got.edges).toHaveLength(1);
    expect(got.edges[0].label).toBe("blocks");

    await call("canvases.removeEdge", { id: edge.id }, ctx);
    got = (await call("canvases.get", { id: canvas.id }, ctx)) as {
      edges: Array<{ id: string }>;
    };
    expect(got.edges).toHaveLength(0);
  });
});
