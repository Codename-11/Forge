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

  it("exports a backup, removes the plugin, and restores without secrets or old keys", async () => {
    const { caller } = await setup();
    const db = getPrisma();

    const created = await caller.register({
      manifest: manifest(),
      webhookUrl: "https://plugin.example.com/forge",
    });
    expect("secret" in created).toBe(false);
    const listed = await caller.list();
    expect(listed).toHaveLength(1);
    expect("secret" in listed[0]).toBe(false);
    await caller.approve({ id: created.id });
    const key = await caller.issueApiKey({
      pluginId: created.id,
      name: "read-key",
      scopes: [PluginScope.READ_ISSUES],
    });
    const storedKey = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    const storedPlugin = await db.plugin.findUniqueOrThrow({ where: { id: created.id } });

    const backup = await caller.exportBackup({ id: created.id });
    const backupJson = JSON.stringify(backup);
    expect(backup.kind).toBe("forge.plugin.backup");
    expect(backup.plugin.manifest.slug).toBe("qa-helper");
    expect(backup.plugin.webhookUrl).toBe("https://plugin.example.com/forge");
    expect(backup.apiKeys[0]?.prefix).toBe(key.prefix);
    expect(backupJson).not.toContain(key.rawKey);
    expect(backupJson).not.toContain(storedKey.hashedKey);
    expect(backupJson).not.toContain(storedPlugin.secret ?? "");

    await caller.remove({ id: created.id });
    await expect(caller.byId({ id: created.id })).rejects.toThrow();

    const restored = await caller.restoreBackup({ backup });
    expect(restored.installAction).toBe("restored");
    expect(restored.status).toBe("PENDING");
    expect(restored.reviewRequired).toBe(true);
    expect(restored.webhookUrl).toBe("https://plugin.example.com/forge");

    const detail = await caller.byId({ id: restored.id });
    expect(detail.apiKeys).toHaveLength(0);
    expect(detail.skills.map((skill) => skill.name)).toEqual(["triage"]);
  });

  it("scopes admin lifecycle mutations to the current workspace", async () => {
    const { caller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "PLB" });
    fixtures.push(other);
    const otherCaller = pluginRouter.createCaller(await buildContext(other));

    const created = await caller.register({ manifest: manifest() });
    await caller.approve({ id: created.id });
    const key = await caller.issueApiKey({
      pluginId: created.id,
      name: "read-key",
      scopes: [PluginScope.READ_ISSUES],
    });

    await expect(otherCaller.approve({ id: created.id })).rejects.toThrow();
    await expect(otherCaller.suspend({ id: created.id })).rejects.toThrow();
    await expect(otherCaller.revokeApiKey({ id: key.id })).rejects.toThrow();
    await expect(otherCaller.exportBackup({ id: created.id })).rejects.toThrow();

    const detail = await caller.byId({ id: created.id });
    expect(detail.status).toBe("APPROVED");
    expect(detail.apiKeys).toHaveLength(1);
  });
});
