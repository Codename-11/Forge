import { describe, expect, it, vi } from "vitest";
import {
  HERMES_SESSIONS_PROTOCOL_V1,
  HermesSessionSseParser,
  buildHermesMemoryKey,
  connectorRetryDecision,
  hermesSessionExternalEventId,
  makeHermesSessionsClient,
  negotiateHermesCapabilities,
  redactConnectorDiagnostic,
} from "@/server/services/hermes-sessions";

function installedCapabilities(overrides: Record<string, unknown> = {}) {
  return {
    object: "hermes.api_server.capabilities",
    platform: "hermes-agent",
    features: {
      session_resources: true,
      session_chat: true,
      session_chat_streaming: true,
      tool_progress_events: true,
      approval_events: true,
      session_key_header: "X-Hermes-Session-Key",
    },
    endpoints: {
      sessions: { method: "GET", path: "/api/sessions" },
      session_create: { method: "POST", path: "/api/sessions" },
      session: { method: "GET", path: "/api/sessions/{session_id}" },
      session_delete: { method: "DELETE", path: "/api/sessions/{session_id}" },
      session_messages: { method: "GET", path: "/api/sessions/{session_id}/messages" },
      session_chat_stream: {
        method: "POST",
        path: "/api/sessions/{session_id}/chat/stream",
      },
    },
    ...overrides,
  };
}

describe("Hermes Sessions memory isolation", () => {
  const base = {
    runtimeId: "runtime_1",
    workspaceId: "workspace_1",
    userId: "user_1",
    agentId: "agent_1",
    chatThreadId: "thread_1",
  };

  it("is stable, opaque, versioned, and isolated by every identity boundary", () => {
    const key = buildHermesMemoryKey(base);
    expect(key).toMatch(/^forge:v2:[A-Za-z0-9_-]{43}$/);
    expect(key).toBe(buildHermesMemoryKey(base));
    expect(key).not.toContain(base.workspaceId);

    for (const [field, value] of Object.entries(base)) {
      expect(buildHermesMemoryKey({ ...base, [field]: `${value}_other` })).not.toBe(key);
    }
  });
});

describe("Hermes Sessions capability negotiation", () => {
  it("recognizes the installed native Sessions contract and fails closed for absent features", () => {
    const result = negotiateHermesCapabilities(installedCapabilities());
    expect(result).toMatchObject({
      protocolVersion: HERMES_SESSIONS_PROTOCOL_V1,
      sessions: true,
      streaming: true,
      toolEvents: true,
      approvals: false,
      attachments: false,
      resume: false,
      proactiveDelivery: false,
      stop: false,
      sessionKeyHeader: "X-Hermes-Session-Key",
    });
  });

  it("requires the exact feature and endpoint contract", () => {
    const wrongEndpoint = installedCapabilities({
      endpoints: {
        ...installedCapabilities().endpoints,
        session_chat_stream: { method: "POST", path: "/v1/runs" },
      },
    });
    expect(negotiateHermesCapabilities(wrongEndpoint).streaming).toBe(false);

    const incompatible = installedCapabilities({ protocol_version: "hermes.sessions.v99" });
    expect(negotiateHermesCapabilities(incompatible)).toMatchObject({
      protocolVersion: null,
      sessions: false,
      streaming: false,
    });
  });

  it("enables optional features only when explicitly session-scoped", () => {
    const base = installedCapabilities();
    const raw = {
      ...base,
      features: {
        ...base.features,
        session_approval_events: true,
        session_attachments: true,
        session_resume: true,
        session_proactive_delivery: true,
        session_stop: true,
      },
    };
    expect(negotiateHermesCapabilities(raw)).toMatchObject({
      approvals: true,
      attachments: true,
      resume: true,
      proactiveDelivery: true,
      stop: true,
    });
  });
});

describe("Hermes Sessions SSE parsing", () => {
  it("parses installed named events across CRLF and split chunks", () => {
    const parser = new HermesSessionSseParser();
    expect(parser.push(": heartbeat\r\nevent: assistant.delta\r\nid: evt_1\r\ndata: {\"session_id\":\"s1\","))
      .toEqual([]);
    const events = parser.push(
      "\"run_id\":\"r1\",\"message_id\":\"m1\",\"seq\":3,\"delta\":\"hi\"}\r\n\r\n",
    );
    expect(events).toEqual([
      expect.objectContaining({
        name: "assistant.delta",
        known: true,
        sseId: "evt_1",
        sessionId: "s1",
        runId: "r1",
        messageId: "m1",
        sequence: 3,
      }),
    ]);
  });

  it("handles tool and terminal events and preserves unknown future events", () => {
    const parser = new HermesSessionSseParser();
    const events = parser.push(
      [
        "event: tool.started\ndata: {\"session_id\":\"s1\",\"run_id\":\"r1\",\"seq\":4,\"tool_name\":\"terminal\"}\n\n",
        "event: run.completed\ndata: {\"session_id\":\"s1\",\"seq\":5,\"completed\":true}\n\n",
        "event: provider.new\ndata: {\"session_id\":\"s1\",\"seq\":6}\n\n",
      ].join(""),
    );
    expect(events.map((event) => [event.name, event.known, event.sequence])).toEqual([
      ["tool.started", true, 4],
      ["run.completed", true, 5],
      ["provider.new", false, 6],
    ]);
    expect(hermesSessionExternalEventId(events[0]!)).toBe("r1:4:tool.started");
  });

  it("rejects malformed event JSON instead of advancing a cursor", () => {
    const parser = new HermesSessionSseParser();
    expect(() => parser.push("event: done\ndata: nope\n\n")).toThrow(/invalid JSON/);
  });
});

describe("Hermes Sessions retry and diagnostics", () => {
  it("uses settings-driven exponential backoff with bounded jitter", () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    expect(
      connectorRetryDecision({
        attempt: 3,
        maxAttempts: 6,
        initialSeconds: 5,
        maxSeconds: 300,
        now,
        random: () => 0.5,
      }),
    ).toEqual({
      deadLetter: false,
      delaySeconds: 20,
      nextAttemptAt: new Date("2026-07-16T00:00:20.000Z"),
    });
    expect(
      connectorRetryDecision({
        attempt: 6,
        maxAttempts: 6,
        initialSeconds: 5,
        maxSeconds: 300,
      }),
    ).toEqual({ deadLetter: true, delaySeconds: null, nextAttemptAt: null });
  });

  it("redacts secrets and URLs from persisted diagnostics", () => {
    const text = redactConnectorDiagnostic(
      "Bearer abc.def token=supersecret failed at https://gateway.example/v1/capabilities",
    );
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).toContain("token=[REDACTED]");
    expect(text).toContain("[REDACTED_URL]");
    expect(text).not.toContain("supersecret");
  });
});

describe("Hermes Sessions native client", () => {
  it("uses capabilities and /api/sessions without touching /v1/runs", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(installedCapabilities()))
      .mockResolvedValueOnce(
        Response.json(
          { object: "hermes.session", session: { id: "session_1", title: "Forge chat" } },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ object: "hermes.session", session: { id: "session_1" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = makeHermesSessionsClient({
      baseUrl: "https://hermes.example/v1",
      token: "secret-token",
      requestTimeoutMs: 5_000,
      fetchImpl,
    });

    await client.negotiateCapabilities();
    const created = await client.createSession({
      sessionId: "session_1",
      title: "Forge chat",
      memoryKey: "forge:v2:opaque",
      idempotencyKey: "delivery_1",
    });
    await client.getSession(created.id, "forge:v2:opaque");
    await client.deleteSession(created.id, "forge:v2:opaque");

    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://hermes.example/v1/capabilities",
      "https://hermes.example/api/sessions",
      "https://hermes.example/api/sessions/session_1",
      "https://hermes.example/api/sessions/session_1",
    ]);
    expect(urls.join(" ")).not.toContain("/v1/runs");
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-token",
      "x-hermes-session-key": "forge:v2:opaque",
      "idempotency-key": "delivery_1",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      id: "session_1",
      title: "Forge chat",
    });
  });

  it("streams the installed native event vocabulary", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "event: run.started\ndata: {\"session_id\":\"s1\",\"run_id\":\"r1\",\"seq\":1}\n\n" +
              "event: assistant.delta\ndata: {\"session_id\":\"s1\",\"run_id\":\"r1\",\"message_id\":\"m1\",\"seq\":2,\"delta\":\"hi\"}\n\n" +
              "event: done\ndata: {\"session_id\":\"s1\",\"run_id\":\"r1\",\"seq\":3,\"state\":\"final\"}\n\n",
          ),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const client = makeHermesSessionsClient({
      baseUrl: "https://hermes.example/v1",
      requestTimeoutMs: 5_000,
      fetchImpl,
    });
    const events = [];
    for await (const event of client.streamMessage({
      sessionId: "s1",
      memoryKey: "forge:v2:opaque",
      message: "hello",
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "assistant.delta",
      "done",
    ]);
  });
});
