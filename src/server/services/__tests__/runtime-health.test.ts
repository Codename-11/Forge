import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus, RuntimeKind } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { sweepRuntimeHealth } from "@/server/services/runtime-health";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the active runtime-health probe. Real Postgres +
 * a real in-process WebSocket server (no mocks) so the Codex app-server probe
 * path is exercised end-to-end.
 */

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

async function makeRuntime(workspaceId: string, endpoint: string): Promise<{ id: string }> {
  return getPrisma().runtime.create({
    data: {
      workspaceId,
      name: "Codex app server",
      kind: RuntimeKind.REMOTE_HTTP,
      adapterKey: "codex-app-server",
      endpoint,
    },
    select: { id: true },
  });
}

async function makeAgent(workspaceId: string, runtimeId: string): Promise<{ id: string }> {
  return getPrisma().agent.create({
    data: {
      workspaceId,
      name: "codex",
      profileKey: "codex",
      status: AgentStatus.OFFLINE,
      runtimeMode: "PERSISTENT",
      runtimeId,
      lastHeartbeatAt: null,
    },
    select: { id: true },
  });
}

describe("runtime-health — sweepRuntimeHealth", () => {
  it("a reachable app-server endpoint brings its persistent agent ONLINE", async () => {
    // Minimal Codex app server stand-in: replies to any message (the probe
    // sends `initialize` and treats the first reply as reachable).
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (socket) => {
      socket.on("message", () =>
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "codex-bridge", version: "1.0.0" },
            },
          }),
        ),
      );
    });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as AddressInfo).port;

    try {
      const fixture = await createWorkspaceFixture();
      fixtures.push(fixture);
      const prisma = getPrisma();
      const rt = await makeRuntime(fixture.workspace.id, `ws://127.0.0.1:${port}`);
      const agent = await makeAgent(fixture.workspace.id, rt.id);

      const res = await sweepRuntimeHealth();
      expect(res.reachable).toBeGreaterThanOrEqual(1);

      const after = await prisma.agent.findUniqueOrThrow({
        where: { id: agent.id },
        select: { status: true, lastHeartbeatAt: true },
      });
      expect(after.status).toBe(AgentStatus.ONLINE);
      expect(after.lastHeartbeatAt).not.toBeNull();

      const runtime = await prisma.runtime.findUniqueOrThrow({
        where: { id: rt.id },
        select: { heartbeatAt: true, runtimeInfo: true, lastInfoAt: true },
      });
      expect(runtime.heartbeatAt).not.toBeNull();
      expect(runtime.lastInfoAt).not.toBeNull();
      expect(runtime.runtimeInfo).toMatchObject({
        adapterKey: "codex-app-server",
        runtimeName: "codex-bridge",
        runtimeVersion: "1.0.0",
        protocolVersion: "2024-11-05",
      });
    } finally {
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  it("sweeps reachable Hermes gateways as diagnostic-only probes without minting a heartbeat", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "hermes-agent" }] }));
        return;
      }
      if (req.url?.startsWith("/v1/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", platform: "hermes-agent", version: "0.18.2" }));
        return;
      }
      if (req.url?.startsWith("/v1/capabilities")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "hermes.api_server.capabilities",
            platform: "hermes-agent",
            features: {
              session_resources: true,
              session_chat: true,
              session_chat_streaming: true,
            },
            endpoints: {
              sessions: { method: "GET", path: "/api/sessions" },
              session_create: { method: "POST", path: "/api/sessions" },
              session: { method: "GET", path: "/api/sessions/{session_id}" },
              session_chat_stream: {
                method: "POST",
                path: "/api/sessions/{session_id}/chat/stream",
              },
            },
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v1/runs")) {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const fixture = await createWorkspaceFixture();
      fixtures.push(fixture);
      const prisma = getPrisma();
      const rt = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Hermes",
          kind: RuntimeKind.REMOTE_HTTP,
          adapterKey: "hermes",
          endpoint: `http://127.0.0.1:${port}/v1`,
          heartbeatAt: null,
        },
        select: { id: true },
      });

      await sweepRuntimeHealth();

      const runtime = await prisma.runtime.findUniqueOrThrow({
        where: { id: rt.id },
        select: {
          heartbeatAt: true,
          lastProbeAt: true,
          lastProbeAttempted: true,
          lastProbeReachable: true,
          lastProbeDetail: true,
          runtimeInfo: true,
          lastInfoAt: true,
        },
      });
      expect(runtime.heartbeatAt).toBeNull();
      expect(runtime.lastProbeAt).not.toBeNull();
      expect(runtime.lastProbeAttempted).toBe(true);
      expect(runtime.lastProbeReachable).toBe(true);
      expect(runtime.lastProbeDetail).toContain("Gateway contract ok");
      expect(runtime.lastInfoAt).not.toBeNull();
      expect(runtime.runtimeInfo).toMatchObject({
        adapterKey: "hermes",
        runtimeName: "hermes-agent",
        runtimeVersion: "0.18.2",
        transport: "runs-api",
        protocolVersion: "hermes.sessions.v1",
        details: {
          hermesSessions: "true",
          hermesSessionsStreaming: "true",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("persists redacted Hermes auth mismatch diagnostics", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const fixture = await createWorkspaceFixture();
      fixtures.push(fixture);
      const prisma = getPrisma();
      const rt = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Hermes",
          kind: RuntimeKind.REMOTE_HTTP,
          adapterKey: "hermes",
          endpoint: `http://127.0.0.1:${port}/v1?token=super-secret`,
          secret: "bad-secret",
        },
        select: { id: true },
      });

      await sweepRuntimeHealth();

      const runtime = await prisma.runtime.findUniqueOrThrow({
        where: { id: rt.id },
        select: {
          heartbeatAt: true,
          lastProbeAt: true,
          lastProbeAttempted: true,
          lastProbeReachable: true,
          lastProbeDetail: true,
        },
      });
      expect(runtime.heartbeatAt).toBeNull();
      expect(runtime.lastProbeAt).not.toBeNull();
      expect(runtime.lastProbeAttempted).toBe(true);
      expect(runtime.lastProbeReachable).toBe(false);
      expect(runtime.lastProbeDetail).toContain("Gateway rejected auth");
      expect(runtime.lastProbeDetail).not.toContain("super-secret");
      expect(runtime.lastProbeDetail).not.toContain("bad-secret");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("flags Hermes gateways that answer models but do not expose the runs API", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "hermes-agent" }] }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const fixture = await createWorkspaceFixture();
      fixtures.push(fixture);
      const prisma = getPrisma();
      const rt = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "Hermes",
          kind: RuntimeKind.REMOTE_HTTP,
          adapterKey: "hermes",
          endpoint: `http://127.0.0.1:${port}/v1`,
        },
        select: { id: true },
      });

      await sweepRuntimeHealth();

      const runtime = await prisma.runtime.findUniqueOrThrow({
        where: { id: rt.id },
        select: {
          heartbeatAt: true,
          lastProbeAt: true,
          lastProbeAttempted: true,
          lastProbeReachable: true,
          lastProbeDetail: true,
        },
      });
      expect(runtime.heartbeatAt).toBeNull();
      expect(runtime.lastProbeAt).not.toBeNull();
      expect(runtime.lastProbeAttempted).toBe(true);
      expect(runtime.lastProbeReachable).toBe(false);
      expect(runtime.lastProbeDetail).toContain("Hermes runs API missing");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("an unreachable endpoint leaves the agent OFFLINE and persists sanitized probe diagnostics", async () => {
    const fixture = await createWorkspaceFixture();
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Port 1 refuses fast — the probe resolves not-reachable.
    const rt = await makeRuntime(fixture.workspace.id, "ws://127.0.0.1:1");
    const agent = await makeAgent(fixture.workspace.id, rt.id);

    await sweepRuntimeHealth();

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
      select: { status: true, lastHeartbeatAt: true },
    });
    expect(after.status).toBe(AgentStatus.OFFLINE);
    expect(after.lastHeartbeatAt).toBeNull();

    const runtime = await prisma.runtime.findUniqueOrThrow({
      where: { id: rt.id },
      select: {
        heartbeatAt: true,
        lastProbeAt: true,
        lastProbeAttempted: true,
        lastProbeReachable: true,
        lastProbeDetail: true,
      },
    });
    expect(runtime.heartbeatAt).toBeNull();
    expect(runtime.lastProbeAt).not.toBeNull();
    expect(runtime.lastProbeAttempted).toBe(true);
    expect(runtime.lastProbeReachable).toBe(false);
    expect(runtime.lastProbeDetail).toMatch(/ECONNREFUSED|refused|connect/i);
  });
});
