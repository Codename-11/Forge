import { afterAll, afterEach, describe, expect, it } from "vitest";
import { commandPaletteRouter } from "@/server/routers/command-palette";
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

afterAll(disconnectPrisma);

describe("command palette issue search", () => {
  it("shares exact identifier and metadata semantics with issue.list", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PAL",
        name: "Palette Metadata",
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, { title: "Palette target", projectId: project.id });
    const caller = commandPaletteRouter.createCaller(await buildContext(fixture));

    for (const query of [
      `${fixture.workspace.key.toLowerCase()}-${issue.number}`,
      String(issue.number),
      `#${issue.number}`,
      "Palette Metadata",
    ]) {
      const result = await caller.search({
        query,
        workspaceId: fixture.workspace.id,
        limit: 6,
      });
      expect(
        result.issues.map((row) => row.id),
        query,
      ).toEqual([issue.id]);
    }

    const wrongKey = await caller.search({
      query: `WRONG-${issue.number}`,
      workspaceId: fixture.workspace.id,
      limit: 6,
    });
    expect(wrongKey.issues).toEqual([]);
  });
});
