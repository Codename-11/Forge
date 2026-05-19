import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ActionRequestStatus, NotificationSeverity } from "@prisma/client";
import { actionRequestRouter } from "@/server/routers/action-request";
import { inboxRouter } from "@/server/routers/inbox";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ACR" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  return {
    fixture,
    prisma,
    ctx,
    arCaller: actionRequestRouter.createCaller(ctx),
    inboxCaller: inboxRouter.createCaller(ctx),
  };
}

describe("actionRequestRouter", () => {
  it("creates → resolves an action request and records audit", async () => {
    const { fixture, prisma, arCaller } = await setup();
    const issue = await createIssue(fixture);
    const created = await arCaller.create({
      title: "Need approval to ship",
      body: "Ready to deploy. Confirm?",
      severity: NotificationSeverity.WARNING,
      assignedUserId: fixture.user.id,
      issueId: issue.id,
    });
    const got = await arCaller.get({ id: created.id });
    expect(got.status).toBe(ActionRequestStatus.OPEN);
    expect(got.severity).toBe(NotificationSeverity.WARNING);
    expect(got.assignedUserId).toBe(fixture.user.id);

    await arCaller.resolve({ id: created.id, resolution: "Approved" });
    const after = await arCaller.get({ id: created.id });
    expect(after.status).toBe(ActionRequestStatus.RESOLVED);
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolution).toBe("Approved");

    const audit = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "action-request",
        entityId: created.id,
      },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2); // create + resolve
  });

  it("inbox.actionRequestsForMe surfaces only OPEN rows assigned to the caller", async () => {
    const { fixture, arCaller, inboxCaller } = await setup();
    const mine = await arCaller.create({
      title: "Mine",
      assignedUserId: fixture.user.id,
    });
    const theirs = await arCaller.create({
      title: "Theirs",
      assignedUserId: fixture.secondUser.id,
    });
    const resolved = await arCaller.create({
      title: "Resolved",
      assignedUserId: fixture.user.id,
    });
    await arCaller.resolve({ id: resolved.id });

    const list = await inboxCaller.actionRequestsForMe({ limit: 50 });
    const ids = list.items.map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(resolved.id);
  });
});
