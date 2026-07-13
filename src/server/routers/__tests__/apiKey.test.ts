import { describe, it, expect, afterAll, afterEach } from "vitest";
import { accessRouter } from "@/server/routers/access";
import { issueRouter } from "@/server/routers/issue";
import {
  assertKeyScope,
  buildKeyScopeWhere,
  type ApiKeyContext,
} from "@/server/services/api-key-auth";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "KEY" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const access = accessRouter.createCaller(ctx);
  const issues = issueRouter.createCaller(ctx);
  return { fixture, ctx, access, issues };
}

describe("apiKey (access) router — narrowing", () => {
  it("create accepts projectIds / labelIds / initiativeIds", async () => {
    const { access, fixture } = await setup();
    const prisma = getPrisma();

    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "lab", color: "#abc" },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PRJ",
        name: "Proj",
        createdById: fixture.user.id,
      },
    });

    const key = await access.create({
      name: "narrow-key",
      scopes: ["READ_ISSUES"],
      projectIds: [project.id],
      labelIds: [label.id],
      initiativeIds: [],
    });
    expect(key.projectIds).toEqual([project.id]);
    expect(key.labelIds).toEqual([label.id]);
    expect(key.rawKey).toMatch(/^forge_sk_/);
  });

  it("create rejects ids from another workspace", async () => {
    const { access } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(other);
    const prisma = getPrisma();
    const otherLabel = await prisma.label.create({
      data: { workspaceId: other.workspace.id, name: "x", color: "#000" },
    });
    await expect(
      access.create({
        name: "bad",
        scopes: ["READ_ISSUES"],
        labelIds: [otherLabel.id],
      }),
    ).rejects.toThrow();
  });

  it("update edits name + narrowing without touching the hash", async () => {
    const { access, fixture } = await setup();
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "UPD",
        name: "P",
        createdById: fixture.user.id,
      },
    });
    const key = await access.create({
      name: "k1",
      scopes: ["READ_ISSUES"],
    });
    const updated = await access.update({
      id: key.id,
      name: "k1-renamed",
      projectIds: [project.id],
    });
    expect(updated.name).toBe("k1-renamed");
    expect(updated.projectIds).toEqual([project.id]);
    // Prefix should still equal original (hash unchanged).
    expect(updated.prefix).toBe(key.prefix);
  });

  it("rotate preserves narrowing metadata", async () => {
    const { access, fixture } = await setup();
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "ROT",
        name: "P",
        createdById: fixture.user.id,
      },
    });
    const key = await access.create({
      name: "rotating",
      scopes: ["READ_ISSUES"],
      projectIds: [project.id],
    });
    const rotated = await access.rotate({ id: key.id });
    expect(rotated.projectIds).toEqual([project.id]);
    expect(rotated.id).not.toBe(key.id);
    expect(rotated.rawKey).toMatch(/^forge_sk_/);
  });

  it("buildKeyScopeWhere returns the expected Prisma fragments", async () => {
    const apiKey: ApiKeyContext = {
      keyId: "k",
      workspaceId: "w",
      userId: null,
      pluginId: null,
      scopes: [],
      projectIds: ["p1", "p2"],
      labelIds: ["l1"],
      initiativeIds: [],
      linkedAgentId: null,
    };
    const issueWhere = buildKeyScopeWhere({ apiKey }, "issue");
    expect(issueWhere).toHaveProperty("OR");
    const projectWhere = buildKeyScopeWhere({ apiKey }, "project");
    expect(projectWhere).toEqual({ id: { in: ["p1", "p2"] } });
    const initiativeWhere = buildKeyScopeWhere({ apiKey }, "initiative");
    expect(initiativeWhere).toEqual({});

    // No narrowing at all => empty object.
    const bare: ApiKeyContext = {
      ...apiKey,
      projectIds: [],
      labelIds: [],
      initiativeIds: [],
    };
    expect(buildKeyScopeWhere({ apiKey: bare }, "issue")).toEqual({});
  });

  it("assertKeyScope enforces issue narrowing via labels", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const redLabel = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "red", color: "#f00" },
    });
    const blueLabel = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "blue", color: "#00f" },
    });
    const redIssue = await createIssue(fixture);
    const blueIssue = await createIssue(fixture);
    await prisma.issueLabel.create({
      data: { issueId: redIssue.id, labelId: redLabel.id },
    });
    await prisma.issueLabel.create({
      data: { issueId: blueIssue.id, labelId: blueLabel.id },
    });

    const apiKey: ApiKeyContext = {
      keyId: "k",
      workspaceId: fixture.workspace.id,
      userId: null,
      pluginId: null,
      scopes: ["READ_ISSUES"],
      projectIds: [],
      labelIds: [redLabel.id],
      initiativeIds: [],
      linkedAgentId: null,
    };

    // Scoped issue passes.
    await expect(
      assertKeyScope({ apiKey, db: ctx.db }, { entity: "issue", id: redIssue.id }),
    ).resolves.toBeUndefined();
    // Out-of-scope issue throws FORBIDDEN.
    await expect(
      assertKeyScope({ apiKey, db: ctx.db }, { entity: "issue", id: blueIssue.id }),
    ).rejects.toThrow(/scope/i);
  });

  it("enforces initiative-only narrowing for issue reads and list filters", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const allowedInitiative = await prisma.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Allowed initiative",
        slug: `allowed-${Date.now().toString(36)}`,
        createdById: fixture.user.id,
      },
    });
    const otherInitiative = await prisma.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Other initiative",
        slug: `other-${Date.now().toString(36)}`,
        createdById: fixture.user.id,
      },
    });
    const allowedProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: `A${Date.now().toString(36)}`.slice(0, 10),
        name: "Allowed project",
        initiativeId: allowedInitiative.id,
        createdById: fixture.user.id,
      },
    });
    const otherProject = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: `B${Date.now().toString(36)}`.slice(0, 10),
        name: "Other project",
        initiativeId: otherInitiative.id,
        createdById: fixture.user.id,
      },
    });
    const allowedIssue = await createIssue(fixture, { projectId: allowedProject.id });
    const otherIssue = await createIssue(fixture, { projectId: otherProject.id });
    const apiKey: ApiKeyContext = {
      keyId: "initiative-key",
      workspaceId: fixture.workspace.id,
      userId: null,
      pluginId: null,
      scopes: ["READ_ISSUES"],
      projectIds: [],
      labelIds: [],
      initiativeIds: [allowedInitiative.id],
      linkedAgentId: null,
    };

    await expect(
      assertKeyScope({ apiKey, db: ctx.db }, { entity: "issue", id: allowedIssue.id }),
    ).resolves.toBeUndefined();
    await expect(
      assertKeyScope({ apiKey, db: ctx.db }, { entity: "issue", id: otherIssue.id }),
    ).rejects.toThrow(/scope/i);
    expect(buildKeyScopeWhere({ apiKey }, "issue")).toEqual({
      project: { initiativeId: { in: [allowedInitiative.id] } },
    });
  });

  it("issue.list honors narrowing when apiKey is on ctx", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "bot", color: "#b0b" },
    });
    const scoped = await createIssue(fixture);
    await createIssue(fixture); // unscoped
    await prisma.issueLabel.create({
      data: { issueId: scoped.id, labelId: label.id },
    });

    const narrowedCtx = {
      ...ctx,
      apiKey: {
        keyId: "k",
        workspaceId: fixture.workspace.id,
        userId: null,
        pluginId: null,
        scopes: ["READ_ISSUES"],
        projectIds: [],
        labelIds: [label.id],
        initiativeIds: [],
        linkedAgentId: null,
      } satisfies ApiKeyContext,
    };
    const caller = issueRouter.createCaller(narrowedCtx);
    const { items } = await caller.list();
    const ids = items.map((i) => i.id);
    expect(ids).toContain(scoped.id);
    expect(ids.length).toBe(1);
  });
});
