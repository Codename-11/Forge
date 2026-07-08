import { describe, it, expect, afterEach, afterAll } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { runtimeRouter } from "@/server/routers/runtime";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

// runtime.create/update write `config` (the host tool policy that decides
// whether an agent gets terminal/filesystem/git on the host), so both are
// admin-gated — matching the runtime's secrets/repos and the MCP
// `runtimes.configure` mirror. A plain workspace MEMBER must not be able to
// widen an agent's host access from the settings UI.

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    await fixtures.pop()!.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function seedRuntime(fixture: TestFixture) {
  return getPrisma().runtime.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.user.id,
      name: "seed runtime",
      kind: RuntimeKind.REMOTE_HTTP,
      adapterKey: "codex-app-server",
    },
    select: { id: true },
  });
}

describe("runtime create/update admin gating", () => {
  it("lets an OWNER update a runtime", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RGA" });
    fixtures.push(fixture);
    const runtime = await seedRuntime(fixture);

    const ownerCaller = runtimeRouter.createCaller(await buildContext(fixture));
    const updated = await ownerCaller.update({ id: runtime.id, name: "renamed by owner" });
    expect(updated.id).toBe(runtime.id);
    expect(updated.name).toBe("renamed by owner");
  });

  it("forbids a non-admin MEMBER from creating or updating a runtime", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RGB" });
    fixtures.push(fixture);
    const runtime = await seedRuntime(fixture);

    // secondUser is seeded as a MEMBER (not OWNER/ADMIN) by the fixture.
    const memberCaller = runtimeRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );

    await expect(
      memberCaller.create({ adapterKey: "codex-app-server", name: "member runtime" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      memberCaller.update({ id: runtime.id, name: "member rename" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The runtime is untouched.
    const row = await getPrisma().runtime.findUniqueOrThrow({
      where: { id: runtime.id },
      select: { name: true },
    });
    expect(row.name).toBe("seed runtime");
  });
});
