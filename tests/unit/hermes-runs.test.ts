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
});
