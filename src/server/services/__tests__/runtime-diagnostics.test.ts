import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RuntimeDiagnosticKind, RuntimeDiagnosticTrigger, RuntimeKind } from "@prisma/client";
import {
  executeRuntimeDiagnostic,
  runScheduledRuntimeProbe,
} from "@/server/services/runtime-diagnostics";
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

afterAll(async () => disconnectPrisma());

describe("runtime diagnostic execution plane", () => {
  it("records worker provenance and preserves manual-vs-sweep history", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.url?.startsWith("/v1/runs")) {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const fixture = await createWorkspaceFixture({ keyPrefix: "RDX" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Diagnostic plane",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: `http://127.0.0.1:${port}/v1`,
      },
    });
    const manual = await prisma.runtimeDiagnosticAttempt.create({
      data: {
        requestId: "manual-worker-diagnostic",
        workspaceId: fixture.workspace.id,
        runtimeId: runtime.id,
        kind: RuntimeDiagnosticKind.PROBE,
        trigger: RuntimeDiagnosticTrigger.MANUAL_RUNTIME,
        requestedById: fixture.user.id,
      },
    });

    const passed = await executeRuntimeDiagnostic({
      requestId: manual.requestId,
      workspaceId: fixture.workspace.id,
      runtimeId: runtime.id,
    });
    expect(passed).toMatchObject({
      executor: "WORKER",
      trigger: "MANUAL_RUNTIME",
      reachable: true,
      requestedById: fixture.user.id,
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    const failed = await runScheduledRuntimeProbe({
      workspaceId: fixture.workspace.id,
      runtimeId: runtime.id,
    });
    expect(failed).toMatchObject({
      executor: "WORKER",
      trigger: "SCHEDULED_SWEEP",
      reachable: false,
    });

    const history = await prisma.runtimeDiagnosticAttempt.findMany({
      where: { runtimeId: runtime.id },
      orderBy: { createdAt: "asc" },
    });
    expect(history).toHaveLength(2);
    expect(history.map((attempt) => attempt.trigger)).toEqual([
      "MANUAL_RUNTIME",
      "SCHEDULED_SWEEP",
    ]);
    await expect(
      prisma.runtime.findUniqueOrThrow({ where: { id: runtime.id } }),
    ).resolves.toMatchObject({
      lastProbeReachable: false,
    });
  });
});
