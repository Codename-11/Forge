import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { RuntimeDiagnosticKind, RuntimeDiagnosticTrigger, RuntimeKind } from "@prisma/client";
import { runtimeRouter } from "@/server/routers/runtime";
import {
  executeQueuedRuntimeDiagnostic,
  executeRuntimeDiagnostic,
  runScheduledRuntimeProbe,
} from "@/server/services/runtime-diagnostics";
import {
  createWorkspaceFixture,
  buildContext,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];
const childWorkers: ChildProcess[] = [];

afterEach(async () => {
  while (childWorkers.length) {
    const child = childWorkers.pop()!;
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once("exit", () => resolveExit());
      setTimeout(resolveExit, 5_000).unref();
    });
  }
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => disconnectPrisma());

describe("runtime diagnostic execution plane", () => {
  async function startIsolatedWorker(blockedOrigin: string): Promise<ChildProcess> {
    const serverOnlyShim = resolve(process.cwd(), "scripts/ignore-server-only.cjs");
    const child = spawn(
      process.execPath,
      [
        resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        resolve(process.cwd(), "tests/fixtures/runtime-diagnostic-worker.ts"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FORGE_TEST_BLOCKED_RUNTIME_ORIGIN: blockedOrigin,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(serverOnlyShim)}`.trim(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    childWorkers.push(child);
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Isolated runtime diagnostic worker did not become ready.")),
        15_000,
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      child.stdout?.on("data", (chunk) => {
        if (!chunk.toString().includes("RUNTIME_DIAGNOSTIC_WORKER_READY")) return;
        clearTimeout(timer);
        ready();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Isolated runtime diagnostic worker exited ${code}: ${stderr}`));
      });
    });
    return child;
  }

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

  it("finalizes and sanitizes an unexpected worker executor failure", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RDF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Failing diagnostic worker",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "https://runtime.example.test/v1",
      },
    });
    const attempt = await prisma.runtimeDiagnosticAttempt.create({
      data: {
        requestId: "failed-worker-diagnostic",
        workspaceId: fixture.workspace.id,
        runtimeId: runtime.id,
        kind: RuntimeDiagnosticKind.PROBE,
        trigger: RuntimeDiagnosticTrigger.MANUAL_RUNTIME,
        requestedById: fixture.user.id,
      },
    });

    await expect(
      executeQueuedRuntimeDiagnostic(
        {
          requestId: attempt.requestId,
          workspaceId: fixture.workspace.id,
          runtimeId: runtime.id,
        },
        prisma,
        async () => {
          throw new Error(
            "authorization: Bearer super-secret https://runtime.example.test/private?token=bad",
          );
        },
      ),
    ).rejects.toThrow("super-secret");

    const finalized = await prisma.runtimeDiagnosticAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(finalized).toMatchObject({
      executor: "WORKER",
      attempted: true,
      reachable: false,
    });
    expect(finalized.completedAt).not.toBeNull();
    expect(finalized.detail).toContain("Worker diagnostic failed");
    expect(finalized.detail).not.toContain("super-secret");
    expect(finalized.detail).not.toContain("token=bad");
  });

  it("reports worker-plane failure even when the web process can reach the runtime", async () => {
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
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Establish the split explicitly: this Vitest/web process can reach the
      // endpoint, while the separate worker process below denies that origin.
      await expect(fetch(`${origin}/v1/models`)).resolves.toMatchObject({ ok: true });

      const fixture = await createWorkspaceFixture({ keyPrefix: "RDP" });
      fixtures.push(fixture);
      const runtime = await getPrisma().runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Split-plane diagnostic",
          kind: RuntimeKind.REMOTE_HTTP,
          adapterKey: "hermes",
          endpoint: `${origin}/v1`,
        },
      });
      await startIsolatedWorker(origin);

      const caller = runtimeRouter.createCaller(await buildContext(fixture));
      const result = await caller.verifyConnection({ id: runtime.id });

      expect(result.probe).toMatchObject({
        attempted: true,
        reachable: false,
        executor: "WORKER",
        trigger: "MANUAL_RUNTIME",
      });
      expect(result.probe.detail).toContain("Worker test egress blocked");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
