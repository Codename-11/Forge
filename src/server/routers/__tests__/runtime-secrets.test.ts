import { describe, it, expect, afterAll, afterEach } from "vitest";
import { RuntimeKind } from "@prisma/client";
import { runtimeRouter } from "@/server/routers/runtime";
import { decryptSecret } from "@/server/crypto";
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
  await disconnectPrisma();
});

async function setup(keyPrefix: string) {
  const fixture = await createWorkspaceFixture({ keyPrefix });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const runtime = await getPrisma().runtime.create({
    data: {
      workspaceId: fixture.workspace.id,
      ownerId: fixture.user.id,
      name: "test runtime",
      kind: RuntimeKind.REMOTE_HTTP,
      adapterKey: "codex-app-server",
    },
    select: { id: true },
  });
  return { fixture, runtime, caller: runtimeRouter.createCaller(ctx) };
}

describe("runtime secrets + repos", () => {
  it("stores a secret encrypted and never returns the value", async () => {
    const { runtime, caller } = await setup("RSEC");
    const prisma = getPrisma();

    const created = await caller.setSecret({
      runtimeId: runtime.id,
      key: "GH_TOKEN",
      value: "ghp_supersecret_value",
      description: "github pat",
    });
    // The mutation result carries only metadata — no value/valueEnc.
    expect(created.key).toBe("GH_TOKEN");
    expect(created).not.toHaveProperty("value");
    expect(created).not.toHaveProperty("valueEnc");

    // listSecrets must never expose the value either.
    const listed = await caller.listSecrets({ runtimeId: runtime.id });
    expect(listed).toHaveLength(1);
    expect(listed[0].key).toBe("GH_TOKEN");
    expect(listed[0]).not.toHaveProperty("value");
    expect(listed[0]).not.toHaveProperty("valueEnc");

    // The stored ciphertext round-trips back to the original plaintext.
    const row = await prisma.runtimeSecret.findFirstOrThrow({
      where: { runtimeId: runtime.id, key: "GH_TOKEN" },
      select: { valueEnc: true },
    });
    expect(row.valueEnc).not.toContain("ghp_supersecret_value");
    expect(decryptSecret(row.valueEnc)).toBe("ghp_supersecret_value");
  });

  it("upserts a secret by (runtime, key) and deletes it", async () => {
    const { runtime, caller } = await setup("RSEC2");
    const prisma = getPrisma();

    await caller.setSecret({ runtimeId: runtime.id, key: "GH_TOKEN", value: "v1" });
    await caller.setSecret({ runtimeId: runtime.id, key: "GH_TOKEN", value: "v2" });
    const rows = await prisma.runtimeSecret.findMany({ where: { runtimeId: runtime.id } });
    expect(rows).toHaveLength(1); // upsert, not duplicate
    expect(decryptSecret(rows[0].valueEnc)).toBe("v2");

    await caller.deleteSecret({ runtimeId: runtime.id, key: "GH_TOKEN" });
    expect(await caller.listSecrets({ runtimeId: runtime.id })).toHaveLength(0);
  });

  it("manages repo bindings (upsert by path, list, delete)", async () => {
    const { runtime, caller } = await setup("RREPO");

    const repo = await caller.setRepo({
      runtimeId: runtime.id,
      url: "https://github.com/acme/widget.git",
      branch: "main",
      path: "widget",
    });
    expect(repo.path).toBe("widget");
    expect(repo.url).toContain("widget.git");

    // Upsert by path — same path updates rather than duplicating.
    await caller.setRepo({
      runtimeId: runtime.id,
      url: "https://github.com/acme/widget2.git",
      path: "widget",
    });
    const listed = await caller.listRepos({ runtimeId: runtime.id });
    expect(listed).toHaveLength(1);
    expect(listed[0].url).toContain("widget2.git");

    await caller.deleteRepo({ runtimeId: runtime.id, id: listed[0].id });
    expect(await caller.listRepos({ runtimeId: runtime.id })).toHaveLength(0);
  });

  it("rejects a path traversal in a repo binding", async () => {
    const { runtime, caller } = await setup("RTRAV");
    await expect(
      caller.setRepo({
        runtimeId: runtime.id,
        url: "https://github.com/acme/x.git",
        path: "../escape",
      }),
    ).rejects.toThrow();
  });

  it("does not let one workspace touch another's runtime secrets", async () => {
    const a = await setup("RWSA");
    const other = await createWorkspaceFixture({ keyPrefix: "RWSB" });
    fixtures.push(other);
    const otherCaller = runtimeRouter.createCaller(await buildContext(other));

    // Workspace B cannot read or write workspace A's runtime.
    await expect(
      otherCaller.listSecrets({ runtimeId: a.runtime.id }),
    ).rejects.toThrow(/not found/i);
    await expect(
      otherCaller.setSecret({ runtimeId: a.runtime.id, key: "X", value: "y" }),
    ).rejects.toThrow(/not found/i);
  });
});
