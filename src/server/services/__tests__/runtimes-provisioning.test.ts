import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentProvider, RuntimeKind } from "@prisma/client";
import { mcpTools, type McpContext } from "@/server/services/mcp";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import { encryptSecret } from "@/server/crypto";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

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

function ctxFor(fixture: TestFixture, linkedAgentId: string | null): McpContext {
  const apiKey: ApiKeyContext = {
    keyId: "test-key",
    workspaceId: fixture.workspace.id,
    userId: fixture.user.id,
    pluginId: null,
    scopes: [],
    projectIds: [],
    labelIds: [],
    initiativeIds: [],
    linkedAgentId,
  };
  return { workspaceId: apiKey.workspaceId, userId: apiKey.userId, pluginId: null, apiKey };
}

type ProvisioningResult = {
  runtimeId: string;
  secrets: Array<{ key: string; value: string }>;
  repos: Array<{ url: string; path: string; branch: string | null }>;
};

async function provision(ctx: McpContext): Promise<ProvisioningResult> {
  const def = mcpTools["runtimes.provisioning"];
  const parsed = def.input.parse({});
  return def.run(parsed as never, ctx) as Promise<ProvisioningResult>;
}

describe("runtimes.provisioning", () => {
  it("returns decrypted secrets + repos for the calling agent's runtime", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROV" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: f.workspace.id,
        name: "rt",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "codex-app-server",
        config: { workspaceRoot: "/work/forge" },
      },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "a",
        profileKey: "prov-agent",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });
    await prisma.runtimeSecret.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        key: "GH_TOKEN",
        valueEnc: encryptSecret("ghp_xyz"),
      },
    });
    await prisma.runtimeRepo.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        url: "https://github.com/acme/x.git",
        branch: "main",
        path: "x",
      },
    });

    const res = await provision(ctxFor(f, agent.id));
    expect(res.runtimeId).toBe(runtime.id);
    expect(res.secrets).toEqual([{ key: "GH_TOKEN", value: "ghp_xyz" }]);
    expect(res.repos).toEqual([
      { url: "https://github.com/acme/x.git", branch: "main", path: "x" },
    ]);
  });

  it("rejects a key with no linkedAgentId", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVN" });
    fixtures.push(f);
    await expect(provision(ctxFor(f, null))).rejects.toThrow(/agent-linked/i);
  });

  it("returns only the caller's runtime secrets, never another runtime's", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVS" });
    fixtures.push(f);
    const prisma = getPrisma();
    const rtA = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "A", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const rtB = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "B", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agentA = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "aA",
        profileKey: "prov-a",
        provider: AgentProvider.CODEX,
        runtimeId: rtA.id,
      },
      select: { id: true },
    });
    await prisma.runtimeSecret.create({
      data: {
        runtimeId: rtA.id,
        workspaceId: f.workspace.id,
        key: "A_SECRET",
        valueEnc: encryptSecret("a"),
      },
    });
    await prisma.runtimeSecret.create({
      data: {
        runtimeId: rtB.id,
        workspaceId: f.workspace.id,
        key: "B_SECRET",
        valueEnc: encryptSecret("b"),
      },
    });

    const res = await provision(ctxFor(f, agentA.id));
    expect(res.runtimeId).toBe(rtA.id);
    expect(res.secrets.map((s) => s.key)).toEqual(["A_SECRET"]);
    expect(res.secrets.find((s) => s.key === "B_SECRET")).toBeUndefined();
  });
});
