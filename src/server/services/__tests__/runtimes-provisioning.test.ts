import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
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

// Real signable key for the GitHub-App mint path.
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  githubAppTokenExpiresAt?: string | null;
};

/** Stub GitHub's token-mint endpoint for the GitHub-App provisioning path. */
function stubGithubMint(token: string, expiresAt = "2026-06-14T18:00:00Z") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/access_tokens"))
        return new Response(JSON.stringify({ token, expires_at: expiresAt }), { status: 201 });
      throw new Error(`unexpected url ${url}`);
    }),
  );
}

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

  it("mints a GitHub App token into GH_TOKEN and reports its expiry", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVG" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "g", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "g",
        profileKey: "prov-gha",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });
    await prisma.runtimeGithubApp.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        appId: "123456",
        installationId: "42",
        privateKeyEnc: encryptSecret(PEM),
      },
    });
    stubGithubMint("ghs_minted_token");

    const res = await provision(ctxFor(f, agent.id));
    expect(res.secrets).toEqual([{ key: "GH_TOKEN", value: "ghs_minted_token" }]);
    expect(res.githubAppTokenExpiresAt).toBe("2026-06-14T18:00:00Z");
  });

  it("App-minted GH_TOKEN supersedes a static GH_TOKEN secret", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVH" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "h", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "h",
        profileKey: "prov-ghb",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });
    // A leftover static PAT + an unrelated secret.
    await prisma.runtimeSecret.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        key: "GH_TOKEN",
        valueEnc: encryptSecret("ghp_stale_pat"),
      },
    });
    await prisma.runtimeSecret.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        key: "DEPLOY_KEY",
        valueEnc: encryptSecret("keep-me"),
      },
    });
    await prisma.runtimeGithubApp.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        appId: "1",
        installationId: "2",
        privateKeyEnc: encryptSecret(PEM),
      },
    });
    stubGithubMint("ghs_fresh");

    const res = await provision(ctxFor(f, agent.id));
    const gh = res.secrets.filter((s) => s.key === "GH_TOKEN");
    expect(gh).toEqual([{ key: "GH_TOKEN", value: "ghs_fresh" }]); // exactly one, the minted one
    // Unrelated secrets are preserved.
    expect(res.secrets.find((s) => s.key === "DEPLOY_KEY")?.value).toBe("keep-me");
  });
});
