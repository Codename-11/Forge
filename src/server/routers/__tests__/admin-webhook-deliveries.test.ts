import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind } from "@prisma/client";
import { adminRouter } from "@/server/routers/admin";
import { webhookQueue } from "@/server/queues";
import {
  buildContext,
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
  // Close the BullMQ queue so its Redis connection doesn't keep vitest
  // alive after the last test resolves.
  await webhookQueue.close().catch(() => {});
  await disconnectPrisma();
});

/**
 * Build a full delivery + webhook + event triad so we can exercise the
 * admin router against realistic rows. The helper returns all three ids
 * so callers can make targeted assertions.
 */
async function seedDeadLetterDelivery(fixture: TestFixture): Promise<{
  webhookId: string;
  eventId: string;
  deliveryId: string;
}> {
  const prisma = getPrisma();
  const webhook = await prisma.webhook.create({
    data: {
      workspaceId: fixture.workspace.id,
      url: "https://example.invalid/hook",
      secret: "s3cret-at-least-32-chars-padding-pad",
      events: [EventKind.ISSUE_UPDATED],
      active: true,
    },
  });
  const event = await prisma.activityEvent.create({
    data: {
      workspaceId: fixture.workspace.id,
      kind: EventKind.ISSUE_UPDATED,
      subjectType: "issue",
      subjectId: "fake-issue-id",
      payload: { patch: { title: "x" } },
    },
  });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      eventId: event.id,
      status: "DEAD_LETTER",
      attempt: 6,
      scheduledAt: new Date("2026-01-01T00:00:00Z"),
      responseStatus: 500,
      responseBody: "upstream exploded",
      deliveredAt: null,
    },
  });
  return { webhookId: webhook.id, eventId: event.id, deliveryId: delivery.id };
}

describe("admin.webhookDeliveries", () => {
  it("retry resets status, attempt, scheduledAt and writes an audit entry", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DLQ" });
    fixtures.push(fixture);
    const ctx = await buildContext(fixture);
    const caller = adminRouter.createCaller(ctx);
    const prisma = getPrisma();
    const { deliveryId } = await seedDeadLetterDelivery(fixture);

    const before = Date.now();
    const updated = await caller.webhookDeliveries.retry({ id: deliveryId });
    const after = Date.now();

    // Mutation return shape reflects the reset row.
    expect(updated.id).toBe(deliveryId);
    expect(updated.status).toBe("PENDING");
    expect(updated.attempt).toBe(0);
    expect(updated.responseStatus).toBeNull();
    expect(updated.responseBody).toBeNull();
    expect(updated.deliveredAt).toBeNull();
    const scheduledAtMs = updated.scheduledAt.getTime();
    expect(scheduledAtMs).toBeGreaterThanOrEqual(before);
    expect(scheduledAtMs).toBeLessThanOrEqual(after + 1_000);

    // DB state matches.
    const fromDb = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(fromDb.status).toBe("PENDING");
    expect(fromDb.attempt).toBe(0);
    expect(fromDb.responseStatus).toBeNull();
    expect(fromDb.responseBody).toBeNull();

    // AuditLog entry written in the same transaction.
    const audit = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "WebhookDelivery",
        entityId: deliveryId,
        action: "retry",
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(fixture.user.id);
    const beforePatch = audit[0].before as Record<string, unknown>;
    const afterPatch = audit[0].after as Record<string, unknown>;
    expect(beforePatch.status).toBe("DEAD_LETTER");
    expect(beforePatch.attempt).toBe(6);
    expect(afterPatch.status).toBe("PENDING");
    expect(afterPatch.attempt).toBe(0);
  });

  it("retry refuses deliveries from another workspace", async () => {
    const home = await createWorkspaceFixture({ keyPrefix: "HOM" });
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(home, other);
    const ctx = await buildContext(home);
    const caller = adminRouter.createCaller(ctx);
    const { deliveryId } = await seedDeadLetterDelivery(other);

    await expect(
      caller.webhookDeliveries.retry({ id: deliveryId }),
    ).rejects.toThrow();
  });

  it("list returns deliveries scoped to the workspace with a body preview", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "LIS" });
    fixtures.push(fixture);
    const ctx = await buildContext(fixture);
    const caller = adminRouter.createCaller(ctx);
    const prisma = getPrisma();
    const { deliveryId, webhookId } = await seedDeadLetterDelivery(fixture);

    // Write an oversized response body so we can confirm server-side
    // truncation to the 2KB preview cap.
    const huge = "x".repeat(5_000);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { responseBody: huge },
    });

    const { items } = await caller.webhookDeliveries.list({
      status: "DEAD_LETTER",
      limit: 50,
    });
    const row = items.find((d) => d.id === deliveryId);
    expect(row).toBeDefined();
    expect(row!.webhook.id).toBe(webhookId);
    expect(row!.responseBody?.length ?? 0).toBeLessThanOrEqual(2_048);
    expect(row!.responseBody?.startsWith("xxxx")).toBe(true);
  });
});
