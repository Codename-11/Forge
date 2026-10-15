import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mcpTools, type McpContext } from "@/server/services/mcp";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});
afterAll(disconnectPrisma);

function context(f: TestFixture, service = false): McpContext {
  return {
    workspaceId: f.workspace.id,
    userId: f.user.id,
    pluginId: null,
    apiKey: {
      keyId: "ownership-test",
      workspaceId: f.workspace.id,
      userId: f.user.id,
      kind: service ? "AGENT" : "PERSONAL",
      principalType: service ? "AGENT" : "USER",
      pluginId: null,
      linkedAgentId: null,
      scopes: ["ADMIN"],
      projectIds: [],
      labelIds: [],
      initiativeIds: [],
    },
  };
}
async function call(name: keyof typeof mcpTools, input: unknown, ctx: McpContext) {
  const tool = mcpTools[name];
  return tool.run(tool.input.parse(input) as never, ctx);
}

describe("MCP runtime ownership boundaries", () => {
  it("records personal ownership separately from a service key issuer", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const human = (await call(
      "runtimes.register",
      { name: "Personal fixture", kind: "REMOTE_HTTP" },
      context(f),
    )) as { id: string };
    const service = (await call(
      "runtimes.register",
      { name: "Service fixture", kind: "REMOTE_HTTP" },
      context(f, true),
    )) as { id: string };
    expect(await getPrisma().runtime.findUnique({ where: { id: human.id } })).toMatchObject({
      ownerType: "PERSONAL",
      ownerId: f.user.id,
      createdById: f.user.id,
    });
    expect(await getPrisma().runtime.findUnique({ where: { id: service.id } })).toMatchObject({
      ownerType: "UNASSIGNED",
      ownerId: null,
      createdById: f.user.id,
    });
  });

  it("does not lend an issuing instance admin's authority to service credentials", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    await getPrisma().user.update({
      where: { id: f.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    const runtime = await getPrisma().runtime.create({
      data: {
        workspaceId: f.workspace.id,
        name: "Service host",
        kind: "REMOTE_HTTP",
        adapterKey: "hermes",
        ownerType: "SERVICE",
      },
    });
    await expect(
      call("runtimes.configure", { runtimeId: runtime.id, config: {} }, context(f, true)),
    ).rejects.toThrow(/human administrator|runtime owner/);
    await expect(
      call("runtimes.archive", { runtimeId: runtime.id }, context(f, true)),
    ).rejects.toThrow(/human administrator|runtime owner/);
    await call("runtimes.configure", { runtimeId: runtime.id, config: {} }, context(f));
    await call("runtimes.archive", { runtimeId: runtime.id }, context(f));
    expect(
      await getPrisma().instanceAuditLog.count({
        where: { actorId: f.user.id, action: { in: ["runtime.configured", "runtime.archived"] } },
      }),
    ).toBe(2);
  });

  it("denies workspace-only management of shared service resources", async () => {
    const f = await createWorkspaceFixture();
    fixtures.push(f);
    const runtime = await getPrisma().runtime.create({
      data: {
        workspaceId: f.workspace.id,
        name: "Shared host",
        kind: "REMOTE_HTTP",
        adapterKey: "hermes",
        ownerType: "SERVICE",
        instanceShared: true,
      },
    });
    await expect(
      call("runtimes.configure", { runtimeId: runtime.id, config: {} }, context(f)),
    ).rejects.toThrow(/instance administrator/);
    await expect(call("runtimes.archive", { runtimeId: runtime.id }, context(f))).rejects.toThrow(
      /instance administrator/,
    );
    const other = await createWorkspaceFixture();
    fixtures.push(other);
    await getPrisma().runtime.update({
      where: { id: runtime.id },
      data: { workspaceId: other.workspace.id },
    });
    await expect(call("runtimes.archive", { runtimeId: runtime.id }, context(f))).rejects.toThrow(
      /not found in this workspace/,
    );
  });
});
