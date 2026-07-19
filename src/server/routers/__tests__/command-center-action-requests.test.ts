import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ActionRequestKind, ActionRequestStatus, NotificationSeverity } from "@prisma/client";
import { commandCenterRouter } from "@/server/routers/command-center";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("commandCenterRouter — action requests", () => {
  it("returns every decision for an issue and gives reply-less legacy asks a safe dismissal", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Multiple recovery decisions" });
    const rows = await Promise.all(
      ["Legacy delivery conflict", "MCP status is unconfirmed"].map((title, index) =>
        prisma.actionRequest.create({
          data: {
            workspaceId: fixture.workspace.id,
            issueId: issue.id,
            assignedUserId: fixture.user.id,
            title,
            body: `${title} requires an explicit operator decision.`,
            status: ActionRequestStatus.OPEN,
            severity: index === 0 ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
            kind: ActionRequestKind.FREE_FORM,
            sourceType: "work-session",
            sourceId: `session-${issue.id}`,
            dedupeKey: `fixture-${issue.id}-${index}`,
          },
        }),
      ),
    );
    const caller = commandCenterRouter.createCaller(await buildContext(fixture));

    const summary = await caller.summary({ dueWindowDays: 7, limit: 20 });
    const returned = summary.actionRequests.filter((request) => request.issueId === issue.id);

    expect(returned.map((request) => request.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(summary.counts.actionRequests).toBe(2);
    for (const request of returned) {
      expect(request.presentation.protocol).toBe("GENERIC_FALLBACK");
      expect(request.presentation.actions.map((action) => action.id)).toEqual([
        "DISMISS",
        "OPEN_ISSUE",
      ]);
    }
  });
});
