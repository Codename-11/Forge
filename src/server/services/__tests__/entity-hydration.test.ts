import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hydrateEntityRef, hydrateEntityRefs } from "@/server/services/entity-hydration";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

let fixture: TestFixture;

beforeAll(async () => {
  fixture = await createWorkspaceFixture({ keyPrefix: "EHY" });
  fixtures.push(fixture);
});

afterEach(() => {
  // No per-test cleanup beyond what each test creates explicitly — the
  // workspace is torn down in afterAll.
});

afterAll(async () => {
  for (const f of fixtures) {
    await f.cleanup();
  }
  await disconnectPrisma();
});

describe("hydrateEntityRefs", () => {
  it("hydrates an issue ref with key, status, and url", async () => {
    const issue = await createIssue(fixture);
    const rows = await hydrateEntityRefs(
      { db: getPrisma(), workspaceId: fixture.workspace.id, workspaceSlug: fixture.workspace.slug },
      [{ type: "issue", id: issue.id }],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.type).toBe("issue");
    expect(row.missing).toBe(false);
    expect(row.subLabel).toBe(`${fixture.workspace.key}-${issue.number}`);
    expect(row.url).toContain(`/w/${fixture.workspace.slug}/i/`);
    expect(row.meta?.issueKey).toBe(`${fixture.workspace.key}-${issue.number}`);
  });

  it("marks missing refs without throwing", async () => {
    const rows = await hydrateEntityRefs(
      { db: getPrisma(), workspaceId: fixture.workspace.id, workspaceSlug: fixture.workspace.slug },
      [{ type: "issue", id: "no_such_issue_id", label: "fallback" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].missing).toBe(true);
    expect(rows[0].label).toBe("fallback");
  });

  it("preserves input order across heterogeneous ref types", async () => {
    const issue = await createIssue(fixture);
    const prisma = getPrisma();
    const note = await prisma.note.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        title: "Test note",
        body: "Note body",
      },
    });
    const rows = await hydrateEntityRefs(
      { db: prisma, workspaceId: fixture.workspace.id, workspaceSlug: fixture.workspace.slug },
      [
        { type: "note", id: note.id },
        { type: "issue", id: issue.id },
      ],
    );
    expect(rows.map((r) => r.type)).toEqual(["note", "issue"]);
    expect(rows[0].label).toBe("Test note");
  });

  it("returns null for a missing single ref through the convenience wrapper", async () => {
    const single = await hydrateEntityRef(
      { db: getPrisma(), workspaceId: fixture.workspace.id },
      { type: "issue", id: "no_such_id" },
    );
    expect(single).toBeNull();
  });

  it("returns missing rows for primitives not yet shipped (artifact)", async () => {
    const rows = await hydrateEntityRefs(
      { db: getPrisma(), workspaceId: fixture.workspace.id },
      [{ type: "artifact", id: "some_id", label: "Decision doc" }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].missing).toBe(true);
    expect(rows[0].label).toBe("Decision doc");
  });
});
