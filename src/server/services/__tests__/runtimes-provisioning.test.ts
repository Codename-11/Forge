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

type RuntimeInfoReportResult = {
  runtimeId: string;
  runtimeInfo: unknown;
  runtimeInfoSummary: { status: string; label: string };
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

async function reportInfo(
  input: unknown,
  ctx: McpContext,
): Promise<RuntimeInfoReportResult> {
  const def = mcpTools["runtimes.reportInfo"];
  const parsed = def.input.parse(input);
  return def.run(parsed as never, ctx) as Promise<RuntimeInfoReportResult>;
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
    const app = await prisma.githubApp.create({
      data: {
        workspaceId: f.workspace.id,
        name: "app",
        appId: "123456",
        installationId: "42",
        privateKeyEnc: encryptSecret(PEM),
      },
      select: { id: true },
    });
    await prisma.runtime.update({ where: { id: runtime.id }, data: { githubAppId: app.id } });
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
    const app = await prisma.githubApp.create({
      data: {
        workspaceId: f.workspace.id,
        name: "app",
        appId: "1",
        installationId: "2",
        privateKeyEnc: encryptSecret(PEM),
      },
      select: { id: true },
    });
    await prisma.runtime.update({ where: { id: runtime.id }, data: { githubAppId: app.id } });
    stubGithubMint("ghs_fresh");

    const res = await provision(ctxFor(f, agent.id));
    const gh = res.secrets.filter((s) => s.key === "GH_TOKEN");
    expect(gh).toEqual([{ key: "GH_TOKEN", value: "ghs_fresh" }]); // exactly one, the minted one
    // Unrelated secrets are preserved.
    expect(res.secrets.find((s) => s.key === "DEPLOY_KEY")?.value).toBe("keep-me");
  });

  it("materializes per-project repos (one runtime serves many codebases)", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVP" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "p", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "p",
        profileKey: "prov-proj",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });
    // A runtime-wide repo + two project repos (one with a branch).
    await prisma.runtimeRepo.create({
      data: {
        runtimeId: runtime.id,
        workspaceId: f.workspace.id,
        url: "https://github.com/acme/infra.git",
        path: "infra",
      },
    });
    await prisma.project.create({
      data: {
        workspaceId: f.workspace.id,
        key: "WEB",
        name: "Web",
        createdById: f.user.id,
        repoUrl: "https://github.com/acme/web.git",
        repoBranch: "develop",
      },
    });
    await prisma.project.create({
      data: {
        workspaceId: f.workspace.id,
        key: "API",
        name: "Api",
        createdById: f.user.id,
        repoUrl: "git@github.com:acme/api.git",
      },
    });

    const res = await provision(ctxFor(f, agent.id));
    const byPath = Object.fromEntries(res.repos.map((r) => [r.path, r]));
    expect(byPath.infra.url).toBe("https://github.com/acme/infra.git");
    expect(byPath.web).toEqual({
      url: "https://github.com/acme/web.git",
      branch: "develop",
      path: "web",
    });
    expect(byPath.api).toEqual({
      url: "git@github.com:acme/api.git",
      branch: null,
      path: "api",
    });
  });

  it("skips a GitHub App that isn't installed yet (no installation id)", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "PROVU" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "u", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "u",
        profileKey: "prov-uninst",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });
    const app = await prisma.githubApp.create({
      data: {
        workspaceId: f.workspace.id,
        name: "uninstalled",
        appId: "1",
        installationId: null,
        privateKeyEnc: encryptSecret(PEM),
      },
      select: { id: true },
    });
    await prisma.runtime.update({ where: { id: runtime.id }, data: { githubAppId: app.id } });
    // No fetch stub — if it tried to mint, the test would throw on real network.

    const res = await provision(ctxFor(f, agent.id));
    expect(res.githubAppTokenExpiresAt).toBeNull();
    expect(res.secrets.find((s) => s.key === "GH_TOKEN")).toBeUndefined();
  });
});

describe("runtimes.reportInfo", () => {
  it("lets an agent-linked runtime key report sanitized version metadata", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "INFO" });
    fixtures.push(f);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: f.workspace.id,
        name: "codex bridge",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "codex-app-server",
      },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "codex",
        profileKey: "codex-info",
        provider: AgentProvider.CODEX,
        runtimeId: runtime.id,
      },
      select: { id: true },
    });

    const res = await reportInfo(
      {
        info: {
          adapterKey: "codex-app-server",
          bridgeVersion: "1.0.0",
          codexVersion: "0.133.0",
          hostname: "codex-bridge",
          apiKey: "must-not-store",
        },
      },
      ctxFor(f, agent.id),
    );

    expect(res.runtimeId).toBe(runtime.id);
    expect(res.runtimeInfoSummary.label).toBe("Codex 0.133.0");
    expect(res.runtimeInfo).toMatchObject({
      adapterKey: "codex-app-server",
      bridgeVersion: "1.0.0",
      codexVersion: "0.133.0",
      hostname: "codex-bridge",
    });
    expect(res.runtimeInfo).not.toHaveProperty("apiKey");

    const stored = await prisma.runtime.findUniqueOrThrow({
      where: { id: runtime.id },
      select: { runtimeInfo: true, lastInfoAt: true },
    });
    expect(stored.lastInfoAt).not.toBeNull();
    expect(stored.runtimeInfo).toMatchObject({ codexVersion: "0.133.0" });
  });

  it("rejects runtime info reports from unlinked keys", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "INFN" });
    fixtures.push(f);
    await expect(
      reportInfo({ info: { bridgeVersion: "1.0.0" } }, ctxFor(f, null)),
    ).rejects.toThrow(/agent-linked/i);
  });

  it("prevents a linked key from reporting for another runtime", async () => {
    const f = await createWorkspaceFixture({ keyPrefix: "INFX" });
    fixtures.push(f);
    const prisma = getPrisma();
    const ownRuntime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "own", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const otherRuntime = await prisma.runtime.create({
      data: { workspaceId: f.workspace.id, name: "other", kind: RuntimeKind.REMOTE_HTTP },
      select: { id: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: f.workspace.id,
        name: "a",
        profileKey: "info-agent",
        provider: AgentProvider.CODEX,
        runtimeId: ownRuntime.id,
      },
      select: { id: true },
    });

    await expect(
      reportInfo(
        { runtimeId: otherRuntime.id, info: { bridgeVersion: "1.0.0" } },
        ctxFor(f, agent.id),
      ),
    ).rejects.toThrow(/own runtime/i);
  });
});
