import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ApiKeyKind } from "@prisma/client";
import { purgeExpiredSessionKeys } from "@/server/services/api-key-purge";
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

afterAll(async () => {
  await disconnectPrisma();
});

async function makeKey(fixture: TestFixture, kind: ApiKeyKind, expiresAt: Date | null) {
  return getPrisma().apiKey.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: `${kind}-${expiresAt ? "exp" : "perm"}`,
      hashedKey: randomUUID(),
      prefix: "forge_sk_test",
      kind,
      expiresAt,
    },
    select: { id: true },
  });
}

describe("purgeExpiredSessionKeys", () => {
  it("deletes expired SESSION keys but keeps live sessions and non-SESSION keys", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "KP" });
    fixtures.push(fixture);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);

    const expiredSession = await makeKey(fixture, ApiKeyKind.SESSION, past);
    const liveSession = await makeKey(fixture, ApiKeyKind.SESSION, future);
    const expiredPersonal = await makeKey(fixture, ApiKeyKind.PERSONAL, past);
    const permanentAgent = await makeKey(fixture, ApiKeyKind.AGENT, null);

    const res = await purgeExpiredSessionKeys();
    expect(res.purged).toBeGreaterThanOrEqual(1);

    const prisma = getPrisma();
    // Expired SESSION key is gone; everything else survives.
    expect(await prisma.apiKey.findUnique({ where: { id: expiredSession.id } })).toBeNull();
    expect(await prisma.apiKey.findUnique({ where: { id: liveSession.id } })).not.toBeNull();
    expect(await prisma.apiKey.findUnique({ where: { id: expiredPersonal.id } })).not.toBeNull();
    expect(await prisma.apiKey.findUnique({ where: { id: permanentAgent.id } })).not.toBeNull();
  });
});
