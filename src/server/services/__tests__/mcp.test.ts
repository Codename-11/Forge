import { describe, it, expect, afterAll, afterEach } from "vitest";
import { RelationKind } from "@prisma/client";
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

    const roll = (await call(
      "cycles.rollover",
      { fromCycleId: created.id },
      ctx,
    )) as { rolled: number };
    // Neither issue is DONE/CANCELED so both roll.
    expect(roll.rolled).toBe(2);
  });

  it("initiatives: create / list / update / linkProject / unlinkProject", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MC2" });
    fixtures.push(fixture);
    const { ctx } = buildMcpCtx(fixture);

    const initiative = (await call(
      "initiatives.create",
      { name: "H1 Launch" },
      ctx,
    )) as { id: string; slug: string };
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

    const rels = (await call(
      "relations.listForIssue",
      { issueId: a.id },
      ctx,
    )) as unknown[];
    expect(rels.length).toBe(1);

    await call("relations.remove", { relationId: added.relation.id }, ctx);
    const relsAfter = (await call(
      "relations.listForIssue",
      { issueId: a.id },
      ctx,
    )) as unknown[];
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

    const res = (await call(
      "pins.set",
      { issueIds: [a.id, b.id] },
      ctx,
    )) as { pinnedIssueIds: string[] };
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
    await expect(
      call("pins.set", { issueIds: [a.id, b.id, c.id, d.id] }, ctx),
    ).rejects.toThrow();
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
    const cleared = (await call(
      "issues.assign",
      { issueId: issue.id, agentId: null },
      ctx,
    )) as { assignedAgentId: string | null };
    expect(cleared.assignedAgentId).toBeNull();

    // Assign by agentId.
    const byId = (await call(
      "issues.assign",
      { issueId: issue.id, agentId: agent.id },
      ctx,
    )) as { assignedAgentId: string | null };
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

    const rows = (await call(
      "issues.assigned",
      { profileKey: "mizu" },
      ctx,
    )) as Array<{ id: string }>;
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
    const cycle = (await call(
      "cycles.create",
      { name: "Sprint X" },
      ctx,
    )) as { id: string };

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

    const removed = (await call(
      "cycles.removeIssue",
      { issueId: issue.id },
      ctx,
    )) as { cycleId: string | null };
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
      call(
        "issues.reassign",
        { issueId: issue.id, toProfileKey: "mizu", rationale: "short" },
        ctx,
      ),
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
    await expect(call("agents.me", {}, ctx)).rejects.toThrow(
      /No agent inferred/,
    );
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
    const res = (await call(
      "agents.heartbeat",
      { status: "ONLINE" },
      ctx,
    )) as { status: string; lastHeartbeatAt: Date };
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
    await expect(
      call("agents.heartbeat", { status: "ONLINE" }, ctx),
    ).rejects.toThrow(/archived/);
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
    await expect(
      call("agents.heartbeat", { status: "ONLINE" }, ctx),
    ).rejects.toThrow(/not found/);
  });
});
