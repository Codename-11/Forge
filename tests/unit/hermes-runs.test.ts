import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeHermesRunsConnector,
  parseHermesRuntimeConfig,
} from "@/server/services/dispatch/hermes-runs";

describe("parseHermesRuntimeConfig", () => {
  it("keeps typed Hermes runtime controls", () => {
    expect(
      parseHermesRuntimeConfig({
        profile: " victor ",
        mode: "desktop",
        model: "nous/hermes-4",
        yoloMode: true,
      }),
    ).toEqual({
      profile: "victor",
      mode: "desktop",
      model: "nous/hermes-4",
      yoloMode: true,
    });
  });

  it("drops malformed controls", () => {
    expect(parseHermesRuntimeConfig({ profile: " ", mode: 1, yoloMode: "yes" })).toEqual({});
  });
});

describe("makeHermesRunsConnector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes runtime controls and run overrides on start", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ run_id: "run_1" }, { status: 202 });
      }),
    );

    const connector = makeHermesRunsConnector({
      baseUrl: "http://hermes.local/v1",
      token: "secret",
      profile: "victor",
      mode: "desktop",
      model: "runtime-model",
      yoloMode: false,
    });
    await connector.startRun({
      message: "hello",
      model: "thread-model",
      yoloMode: true,
      engagementMode: "DISCUSS",
    });

    expect(bodies[0]).toMatchObject({
      input: "hello",
      model: "thread-model",
      profile: "victor",
      profile_key: "victor",
      mode: "desktop",
      yolo_mode: true,
      permission_mode: "yolo",
      engagement_mode: "DISCUSS",
    });
  });

  it("auto-approves approval events when YOLO is enabled", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ url, body });
        if (url.endsWith("/runs")) return Response.json({ run_id: "run_yolo" }, { status: 202 });
        if (url.endsWith("/events")) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    event: "approval.request",
                    command: "rm -rf tmp",
                    choices: ["once", "deny"],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ event: "run.completed", output: "done" })}\n\n`,
                ),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({ ok: true });
      }),
    );

    const events: string[] = [];
    const connector = makeHermesRunsConnector({
      baseUrl: "http://hermes.local/v1",
      yoloMode: true,
    });
    const { externalRunId } = await connector.startRun({ message: "hello" });
    await connector.subscribe(externalRunId, (event) => events.push(event.type));

    expect(events).not.toContain("approval_required");
    expect(events).toContain("approval_resolved");
    expect(calls).toContainEqual({
      url: "http://hermes.local/v1/runs/run_yolo/approval",
      body: { choice: "once" },
    });
  });

  it("parses CRLF SSE, preserves tool call ids, and emits terminal usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/events")) {
          const payload = [
            {
              event: "tool.started",
              tool: "terminal",
              call_id: "call_1",
              preview: "pnpm test",
            },
            {
              event: "tool.completed",
              tool: "terminal",
              call_id: "call_1",
              duration: 0.25,
              error: false,
            },
            {
              event: "run.completed",
              output: "done",
              usage: { input_tokens: 11, output_tokens: 7 },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
            .join("");
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ run_id: "run_crlf" }, { status: 202 });
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const connector = makeHermesRunsConnector({ baseUrl: "http://hermes.local/v1" });
    const { externalRunId } = await connector.startRun({ message: "hello" });
    await connector.subscribe(externalRunId, (event) => events.push(event));

    expect(events).toContainEqual({
      type: "tool_started",
      tool: "terminal",
      callId: "call_1",
      preview: "pnpm test",
    });
    expect(events).toContainEqual({
      type: "tool_completed",
      tool: "terminal",
      callId: "call_1",
      durationMs: 250,
      isError: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", tokensIn: 11, tokensOut: 7 }),
    );
    expect(events).toContainEqual({ type: "completed", finalText: "done" });
  });

  it("reports a remotely cancelled run as stopped after the event stream closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/events")) {
          return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({ status: "cancelled", error: "Stopped by operator" });
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const connector = makeHermesRunsConnector({ baseUrl: "http://hermes.local/v1" });
    await connector.subscribe("run_cancelled", (event) => events.push(event));

    expect(events).toEqual([{ type: "stopped", reason: "Stopped by operator" }]);
  });

  it("maps a run.cancelled SSE terminal to stopped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/events")) {
          const payload = `data: ${JSON.stringify({
            event: "run.cancelled",
            reason: "Stopped by operator",
          })}\n\n`;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({ status: "cancelled" });
      }),
    );

    const events: Array<Record<string, unknown>> = [];
    const connector = makeHermesRunsConnector({ baseUrl: "http://hermes.local/v1" });
    await connector.subscribe("run_cancelled_sse", (event) => events.push(event));

    expect(events).toEqual([{ type: "stopped", reason: "Stopped by operator" }]);
  });
});
