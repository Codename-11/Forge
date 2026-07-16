import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { sweepHermesConnectorRetries } from "@/server/services/hermes-connector-retry";

const fixtures: TestFixture[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(disconnectPrisma);

describe("Hermes connector retry worker", () => {
  it.each(["RETRY_SCHEDULED", "PROCESSING"] as const)(
    "replays a due %s outbox row and finalizes the existing reply",
    async (initialStatus) => {
    const f = await createWorkspaceFixture({ keyPrefix: "HRT" });
    fixtures.push(f);
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/stream")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          'event: assistant.delta\ndata: {"event":"assistant.delta","seq":1,"run_id":"retry-run","session_id":"hs-1","delta":"Recovered "}\n\n',
          'event: assistant.completed\ndata: {"event":"assistant.completed","seq":2,"run_id":"retry-run","session_id":"hs-1","message_id":"hm-retry","content":"Recovered reply"}\n\n',
          'event: done\ndata: {"event":"done","seq":3,"run_id":"retry-run","session_id":"hs-1"}\n\n',
        ].join(""),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: { workspaceId: f.workspace.id, profileKey: "retry-hermes", name: "Retry Hermes" },
    });
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: f.workspace.id,
        ownerId: f.user.id,
        name: "Retry runtime",
        kind: "REMOTE_HTTP",
        adapterKey: "hermes",
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        secret: "test-only-secret",
      },
    });
    const thread = await prisma.chatThread.create({
      data: { workspaceId: f.workspace.id, userId: f.user.id, agentId: agent.id, title: "Retry" },
    });
    const session = await prisma.connectorSession.create({
      data: {
        workspaceId: f.workspace.id,
        runtimeId: runtime.id,
        agentId: agent.id,
        chatThreadId: thread.id,
        externalSessionId: "hs-1",
        memoryKey: "forge:v2:retry-test",
        lifecycle: "ERROR",
      },
    });
    const user = await prisma.chatMessage.create({
      data: {
        workspaceId: f.workspace.id,
        threadId: thread.id,
        role: "USER",
        body: "Please recover",
        sequence: 1,
        connectorSessionId: session.id,
        dispatchedAt: new Date(),
      },
    });
    const reply = await prisma.chatMessage.create({
      data: {
        workspaceId: f.workspace.id,
        threadId: thread.id,
        role: "AGENT",
        body: "",
        sequence: 2,
        connectorSessionId: session.id,
        replyToMessageId: user.id,
        contextSnapshot: { running: true },
      },
    });
    const delivery = await prisma.connectorDelivery.create({
      data: {
        workspaceId: f.workspace.id,
        connectorSessionId: session.id,
        direction: "OUTBOUND",
        externalEventId: "turn-retry-1",
        kind: "user.message",
        status: initialStatus,
        chatMessageId: user.id,
        attempt: 1,
        lastAttemptAt: initialStatus === "PROCESSING" ? new Date(Date.now() - 5_000) : null,
        nextAttemptAt: new Date(Date.now() - 1_000),
        payload: { body: user.body, messageId: user.id, threadId: thread.id },
      },
    });

    const result = await sweepHermesConnectorRetries(prisma);
    expect(result).toEqual({ attempted: 1, delivered: 1, rescheduled: 0, deadLettered: 0 });
    expect(await prisma.connectorDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toEqual(
      expect.objectContaining({ status: "DELIVERED", attempt: 2, lastError: null }),
    );
    expect(await prisma.chatMessage.findUniqueOrThrow({ where: { id: reply.id } })).toEqual(
      expect.objectContaining({ body: "Recovered ", externalMessageId: "hm-retry" }),
    );
    expect(await prisma.connectorSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(
      expect.objectContaining({ lifecycle: "ACTIVE", retryCount: 0, lastError: null }),
    );
    },
  );
});
