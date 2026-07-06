import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { planIssueMove, executeIssueMove } from "@/server/services/cross-workspace-move";

/**
 * Integration coverage for the cross-workspace issue move (audit ask #2).
 * Real Postgres per CLAUDE.md. Two workspaces per test.
 */

const fixtures: TestFixture[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});
afterAll(async () => {
  await disconnectPrisma();
});

async function twoWorkspaces() {
  const source = await createWorkspaceFixture({ keyPrefix: "SRC" });
  const target = await createWorkspaceFixture({ keyPrefix: "DST" });
  fixtures.push(source, target);
  return { source, target, prisma: getPrisma() };
}

describe("cross-workspace issue move", () => {
  it("previews the remap and blocks entangled issues", async () => {
    const { source, target, prisma } = await twoWorkspaces();
    // Labels: "shared" in both, "sourceonly" only in source.
    const sharedSrc = await prisma.label.create({
      data: { workspaceId: source.workspace.id, name: "shared", color: "#111" },
    });
    await prisma.label.create({
      data: { workspaceId: target.workspace.id, name: "shared", color: "#222" },
    });
    const srcOnly = await prisma.label.create({
      data: { workspaceId: source.workspace.id, name: "sourceonly", color: "#333" },
    });

    const movable = await createIssue(source, { title: "movable", statusCategory: "TODO" });
    await prisma.issueLabel.createMany({
      data: [
        { issueId: movable.id, labelId: sharedSrc.id },
        { issueId: movable.id, labelId: srcOnly.id },
      ],
    });

    // Entangled issue: has an agent run → must be blocked.
    const entangled = await createIssue(source, { title: "entangled", statusCategory: "TODO" });
    const agent = await prisma.agent.create({
      data: { workspaceId: source.workspace.id, profileKey: `a-${Date.now()}`, name: "A" },
    });
    await prisma.agentRun.create({
      data: { workspaceId: source.workspace.id, issueId: entangled.id, agentId: agent.id },
    });

    const plan = await planIssueMove(prisma, {
      sourceWorkspaceId: source.workspace.id,
      targetWorkspaceId: target.workspace.id,
      issueIds: [movable.id, entangled.id],
    });

    expect(plan.movableIds).toEqual([movable.id]);
    expect(plan.blockedIds).toEqual([entangled.id]);
    const movEntry = plan.entries.find((e) => e.issueId === movable.id)!;
    expect(movEntry.newKey).toMatch(new RegExp(`^${target.workspace.key}-`));
    expect(movEntry.keptLabels).toEqual(["shared"]);
    expect(movEntry.droppedLabels).toEqual(["sourceonly"]);
    expect(movEntry.nulledFields).toContain("projectId");
    const blkEntry = plan.entries.find((e) => e.issueId === entangled.id)!;
    expect(blkEntry.blockedReasons.join(" ")).toMatch(/agent run/i);
  });

  it("executes: re-tenants the issue + content, renumbers, remaps status/labels", async () => {
    const { source, target, prisma } = await twoWorkspaces();
    const sharedSrc = await prisma.label.create({
      data: { workspaceId: source.workspace.id, name: "shared", color: "#111" },
    });
    const sharedDst = await prisma.label.create({
      data: { workspaceId: target.workspace.id, name: "shared", color: "#222" },
    });

    // Seed a pre-existing target issue so renumbering must advance past it.
    await createIssue(target, { title: "pre-existing" });

    const issue = await createIssue(source, { title: "movable", statusCategory: "TODO" });
    await prisma.issueLabel.create({ data: { issueId: issue.id, labelId: sharedSrc.id } });
    const comment = await prisma.comment.create({
      data: {
        workspaceId: source.workspace.id,
        issueId: issue.id,
        authorId: source.user.id,
        body: "hi",
      },
    });

    const res = await executeIssueMove(prisma, {
      sourceWorkspaceId: source.workspace.id,
      targetWorkspaceId: target.workspace.id,
      issueIds: [issue.id],
      actorId: source.user.id,
    });
    expect(res.moved).toHaveLength(1);

    const moved = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { workspaceId: true, number: true, statusId: true, projectId: true, labels: { select: { labelId: true } } },
    });
    // Re-tenanted + renumbered past the pre-existing target issue (#1 → #2).
    expect(moved.workspaceId).toBe(target.workspace.id);
    expect(moved.number).toBe(2);
    // Status now a target-workspace status (TODO category).
    const status = await prisma.status.findUniqueOrThrow({ where: { id: moved.statusId } });
    expect(status.workspaceId).toBe(target.workspace.id);
    expect(status.category).toBe("TODO");
    // Label remapped to the target "shared" label.
    expect(moved.labels.map((l) => l.labelId)).toEqual([sharedDst.id]);
    // Content child re-tenanted.
    const movedComment = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(movedComment.workspaceId).toBe(target.workspace.id);
    // MOVE audit event written in the target workspace.
    const audit = await prisma.auditLog.findFirst({
      where: { workspaceId: target.workspace.id, action: "cross_workspace_move" },
    });
    expect(audit).toBeTruthy();
  });

  it("refuses when every selected issue is blocked", async () => {
    const { source, target, prisma } = await twoWorkspaces();
    const issue = await createIssue(source, { title: "entangled" });
    const agent = await prisma.agent.create({
      data: { workspaceId: source.workspace.id, profileKey: `a-${Date.now()}`, name: "A" },
    });
    await prisma.agentRun.create({
      data: { workspaceId: source.workspace.id, issueId: issue.id, agentId: agent.id },
    });
    await expect(
      executeIssueMove(prisma, {
        sourceWorkspaceId: source.workspace.id,
        targetWorkspaceId: target.workspace.id,
        issueIds: [issue.id],
        actorId: source.user.id,
      }),
    ).rejects.toThrow(/blocked/i);
  });
});
