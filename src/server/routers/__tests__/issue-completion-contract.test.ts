import { afterAll, afterEach, describe, expect, it } from "vitest";
import { issueRouter } from "@/server/routers/issue";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "ICC" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = issueRouter.createCaller(ctx);
  return { fixture, caller };
}

describe("issue completion contract", () => {
  it("persists expectedOutput + verificationChecklist on update", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    await caller.update({
      id: issue.id,
      expectedOutput: "## Done means\n- migration applied\n- tests green",
      verificationChecklist: [
        { label: "Migration applied", kind: "command", value: "pnpm prisma migrate status" },
        { label: "Tests green", kind: "command", value: "pnpm test" },
      ],
      artifactRequired: true,
    });
    const row = await getPrisma().issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.expectedOutput).toContain("Done means");
    expect(row.artifactRequired).toBe(true);
    const checklist = row.verificationChecklist as Array<{ label: string; kind: string }>;
    expect(checklist).toHaveLength(2);
    expect(checklist[0].label).toBe("Migration applied");
  });

  it("clears expectedOutput when passed null", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    await caller.update({ id: issue.id, expectedOutput: "first pass" });
    await caller.update({ id: issue.id, expectedOutput: null });
    const row = await getPrisma().issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.expectedOutput).toBeNull();
  });
});
