import { afterAll, afterEach, describe, expect, it } from "vitest";
import { PluginScope } from "@prisma/client";
import { pluginRouter } from "@/server/routers/plugin";
import type { PluginManifest } from "@/server/services/plugin-manifest";
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
    const fixture = fixtures.pop()!;
    await fixture.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "PLG" });
  fixtures.push(fixture);
  const caller = pluginRouter.createCaller(await buildContext(fixture));
  return { fixture, caller };
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1 as const,
    slug: "qa-helper",
    name: "QA Helper",
    description: "Checks incoming issues.",
    version: "0.1.0",
    scopes: [PluginScope.READ_ISSUES],
    events: ["ISSUE_CREATED" as const],
    skills: [
      {
        name: "triage",
        description: "Summarize issue risk.",
        inputSchema: { type: "object" },
        runtime: "local" as const,
      },
    ],
    rateLimit: { perMinute: 120 },
    ...overrides,
  };
}

describe("pluginRouter lifecycle", () => {
  it("installs, updates, and forces review for changed manifests", async () => {
    const { caller } = await setup();
    const db = getPrisma();

    const created = await caller.register({ manifest: manifest() });
    expect(created.installAction).toBe("registered");
    expect(created.reviewRequired).toBe(true);
    expect(created.status).toBe("PENDING");

    await expect(
      caller.issueApiKey({
        pluginId: created.id,
        name: "pending-key",
        scopes: [PluginScope.READ_ISSUES],
      }),
    ).rejects.toThrow(/approved/i);

    await caller.approve({ id: created.id });
    const key = await caller.issueApiKey({
      pluginId: created.id,
      name: "read-key",
      scopes: [PluginScope.READ_ISSUES],
    });

    const updated = await caller.register({
      manifest: manifest({
        version: "0.2.0",
        scopes: [PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES],
        skills: [
          {
            name: "repair",
            description: "Suggest a fix.",
            inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
            runtime: "plugin" as const,
          },
        ],
      }),
      webhookUrl: "https://plugin.example.com/forge",
    });

    expect(updated.id).toBe(created.id);
    expect(updated.installAction).toBe("updated");
    expect(updated.reviewRequired).toBe(true);
    expect(updated.priorVersion).toBe("0.1.0");
    expect(updated.version).toBe("0.2.0");
    expect(updated.status).toBe("PENDING");
    expect(updated.addedScopes).toEqual([PluginScope.WRITE_ISSUES]);

    const detail = await caller.byId({ id: created.id });
    expect(detail.version).toBe("0.2.0");
    expect(detail.status).toBe("PENDING");
    expect(detail.scopes).toEqual([PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES]);
    expect(detail.skills.map((skill) => skill.name)).toEqual(["repair"]);
    expect(detail.apiKeys.map((apiKey) => apiKey.id)).toContain(key.id);

    await expect(
      caller.issueApiKey({
        pluginId: created.id,
        name: "write-key-before-review",
        scopes: [PluginScope.WRITE_ISSUES],
      }),
    ).rejects.toThrow(/approved/i);

    await caller.approve({ id: created.id });
    const writeKey = await caller.issueApiKey({
      pluginId: created.id,
      name: "write-key",
      scopes: [PluginScope.WRITE_ISSUES],
    });
    expect(writeKey.rawKey).toMatch(/^forge_sk_/);

    const row = await db.plugin.findUniqueOrThrow({
      where: { id: created.id },
      include: { skills: true, apiKeys: true },
    });
    expect(row.webhookUrl).toBe("https://plugin.example.com/forge");
    expect(row.skills.map((skill) => skill.name)).toEqual(["repair"]);
    expect(row.apiKeys).toHaveLength(2);
  });

  it("leaves an unchanged same-slug manifest approved", async () => {
    const { caller } = await setup();
    const created = await caller.register({ manifest: manifest() });
    await caller.approve({ id: created.id });

    const unchanged = await caller.register({ manifest: manifest() });

    expect(unchanged.id).toBe(created.id);
    expect(unchanged.installAction).toBe("unchanged");
    expect(unchanged.reviewRequired).toBe(false);
    expect(unchanged.status).toBe("APPROVED");
  });
});
