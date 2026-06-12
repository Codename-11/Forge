import { describe, it, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  mapCodexNotification,
  mapCodexUsage,
  makeCodexAppServerConnector,
  parseCodexRuntimeConfig,
} from "@/server/services/dispatch/codex-app-server";

/**
 * The live WebSocket plumbing needs a running `codex app-server` to exercise
 * end-to-end; these tests pin the pure protocol-mapping logic (notification →
 * RunEvent, usage extraction) and the endpoint guard so the connector wires
 * correctly when an operator points a runtime at a real instance.
 */
describe("mapCodexNotification", () => {
  it("maps agent message deltas to content", () => {
    expect(mapCodexNotification("item/agentMessage/delta", { delta: "Hi" })).toEqual({
      type: "content_delta",
      delta: "Hi",
    });
  });

  it("maps reasoning summary deltas to thinking", () => {
    expect(
      mapCodexNotification("item/reasoning/summaryTextDelta", { delta: "thinking…" }),
    ).toEqual({ type: "thinking", text: "thinking…" });
  });

  it("surfaces command items as tool events with a command label", () => {
    const started = mapCodexNotification("item/started", {
      type: "commandExecution",
      command: "ls -la",
    });
    expect(started).toEqual({ type: "tool_started", tool: "ls -la" });
    const done = mapCodexNotification("item/completed", {
      type: "commandExecution",
      command: "ls -la",
      exitCode: 0,
    });
    expect(done).toEqual({ type: "tool_completed", tool: "ls -la", isError: false });
  });

  it("flags a non-zero exit as a tool error", () => {
    const done = mapCodexNotification("item/completed", {
      type: "commandExecution",
      command: "false",
      exitCode: 1,
    });
    expect(done).toMatchObject({ type: "tool_completed", isError: true });
  });

  it("does NOT emit tool cards for plain agent/user message items", () => {
    expect(mapCodexNotification("item/started", { type: "agentMessage" })).toBeNull();
    expect(mapCodexNotification("item/completed", { type: "userMessage" })).toBeNull();
  });

  it("maps turn completion and failure to terminal events (status under params.turn)", () => {
    // Verified shape against codex-cli 0.133: { threadId, turn: { status, error } }.
    expect(
      mapCodexNotification("turn/completed", { turn: { status: "completed" } }),
    ).toEqual({ type: "completed" });
    expect(
      mapCodexNotification("turn/completed", {
        turn: { status: "failed", error: { message: "boom" } },
      }),
    ).toEqual({ type: "error", message: "boom" });
  });

  it("treats real agentMessage deltas (plain string) as content", () => {
    // Verified shape: { threadId, turnId, itemId, delta: "Hello" }
    expect(
      mapCodexNotification("item/agentMessage/delta", {
        itemId: "msg_1",
        delta: "Hello",
      }),
    ).toEqual({ type: "content_delta", delta: "Hello" });
  });

  it("ignores non-chat notifications", () => {
    expect(mapCodexNotification("turn/diff/updated", {})).toBeNull();
    expect(mapCodexNotification("model/rerouted", {})).toBeNull();
  });
});

describe("mapCodexUsage", () => {
  it("extracts camelCase + snake_case token counts", () => {
    expect(mapCodexUsage({ inputTokens: 10, outputTokens: 20 })).toEqual({
      tokensIn: 10,
      tokensOut: 20,
    });
    expect(mapCodexUsage({ input_tokens: 3, output_tokens: 4 })).toEqual({
      tokensIn: 3,
      tokensOut: 4,
    });
  });
  it("returns undefined when no token data present", () => {
    expect(mapCodexUsage(undefined)).toBeUndefined();
    expect(mapCodexUsage({})).toBeUndefined();
  });
});

describe("makeCodexAppServerConnector", () => {
  it("returns null without an endpoint (so it stays inert until configured)", () => {
    expect(makeCodexAppServerConnector({ baseUrl: null })).toBeNull();
    expect(makeCodexAppServerConnector({ baseUrl: "  " })).toBeNull();
  });
  it("builds a connector when given a ws endpoint", () => {
    const c = makeCodexAppServerConnector({ baseUrl: "ws://127.0.0.1:4500" });
    expect(c?.kind).toBe("codex-app-server");
    expect(typeof c?.startRun).toBe("function");
    expect(typeof c?.approve).toBe("function");
    expect(typeof c?.stop).toBe("function");
  });

  it("shares active run state across connector instances for the same process", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const sockets = new Set<WebSocket>();
    const threadId = `thread-${Date.now()}`;
    const turnId = `turn-${Date.now()}`;

    server.on("connection", (ws) => {
      sockets.add(ws);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          method?: string;
        };
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        } else if (msg.method === "thread/start") {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: threadId } } }));
        } else if (msg.method === "turn/start") {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }));
        }
      });
    });

    try {
      const first = makeCodexAppServerConnector({ baseUrl: `ws://127.0.0.1:${port}` });
      const second = makeCodexAppServerConnector({ baseUrl: `ws://127.0.0.1:${port}` });
      const { externalRunId } = await first!.startRun({ message: "hello" });

      await expect(second!.getStatus!(externalRunId)).resolves.toMatchObject({
        state: "running",
      });

      const subscribed = second!.subscribe(externalRunId, () => undefined);
      for (const ws of sockets) {
        ws.send(
          JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          }),
        );
      }
      await subscribed;
    } finally {
      for (const ws of sockets) ws.close();
      server.close();
    }
  });

  it("sends model and YOLO turn policy for discuss runs", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const threadId = `thread-yolo-${Date.now()}`;
    const turnId = `turn-yolo-${Date.now()}`;
    let threadStartParams: Record<string, unknown> | null = null;
    let turnStartParams: Record<string, unknown> | null = null;

    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        } else if (msg.method === "thread/start") {
          threadStartParams = msg.params ?? {};
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: threadId } } }));
        } else if (msg.method === "turn/start") {
          turnStartParams = msg.params ?? {};
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }));
          ws.send(
            JSON.stringify({
              method: "turn/completed",
              params: { turn: { status: "completed" } },
            }),
          );
        }
      });
    });

    try {
      const connector = makeCodexAppServerConnector({
        baseUrl: `ws://127.0.0.1:${port}`,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        model: "gpt-5.5-codex",
        yoloMode: true,
        workspaceRoot: "/work",
      });
      const { externalRunId } = await connector!.startRun({
        message: "hello",
        engagementMode: "DISCUSS",
      });
      await connector!.subscribe(externalRunId, () => undefined);

      expect(threadStartParams).toMatchObject({ cwd: "/work", model: "gpt-5.5-codex" });
      expect(turnStartParams).toMatchObject({
        cwd: "/work",
        model: "gpt-5.5-codex",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    } finally {
      server.close();
    }
  });

  it("maps a session-scope approval to acceptForSession on the live socket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const threadId = `thread-appr-${Date.now()}`;
    const turnId = `turn-appr-${Date.now()}`;
    const approvalId = 9001;
    let decision: string | null = null;
    let sawApprovalRequest = false;

    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          id?: number;
          method?: string;
          result?: { decision?: string };
        };
        // Client → server reply carrying the operator's approval decision.
        if (msg.method === undefined && msg.id === approvalId && msg.result) {
          decision = msg.result.decision ?? null;
          return;
        }
        if (msg.id === undefined) return;
        if (msg.method === "initialize") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        } else if (msg.method === "thread/start") {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: threadId } } }));
        } else if (msg.method === "turn/start") {
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }));
          // Server → client approval request mid-turn (e.g. `rg --files`).
          ws.send(
            JSON.stringify({
              id: approvalId,
              method: "item/commandExecution/requestApproval",
              params: { command: "rg --files" },
            }),
          );
          sawApprovalRequest = true;
        }
      });
    });

    try {
      const connector = makeCodexAppServerConnector({
        baseUrl: `ws://127.0.0.1:${port}`,
        approvalPolicy: "on-request",
      });
      const { externalRunId } = await connector!.startRun({ message: "hi" });
      // Wait until the connector registers the pending approval.
      for (let i = 0; i < 50; i++) {
        const st = await connector!.getStatus!(externalRunId);
        if (st.state === "waiting_for_approval") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await connector!.approve!(externalRunId, "session");
      for (let i = 0; i < 50 && decision === null; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(sawApprovalRequest).toBe(true);
      expect(decision).toBe("acceptForSession");
    } finally {
      server.close();
    }
  });

  it("reports unknown runs as unknown instead of completed", async () => {
    const c = makeCodexAppServerConnector({ baseUrl: "ws://127.0.0.1:4500" });

    await expect(c!.getStatus!("missing#run")).resolves.toMatchObject({
      state: "unknown",
    });
  });
});

describe("parseCodexRuntimeConfig", () => {
  it("returns empty config for null/garbage (connector falls back to safe defaults)", () => {
    expect(parseCodexRuntimeConfig(null)).toEqual({});
    expect(parseCodexRuntimeConfig("nope")).toEqual({});
    expect(parseCodexRuntimeConfig(42)).toEqual({});
  });
  it("keeps only valid sandbox/approval values", () => {
    expect(
      parseCodexRuntimeConfig({
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        model: "gpt-5.5-codex",
        yoloMode: true,
        workspaceRoot: "/work",
      }),
    ).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      model: "gpt-5.5-codex",
      yoloMode: true,
      workspaceRoot: "/work",
    });
  });
  it("drops unknown enum values rather than passing them through", () => {
    expect(
      parseCodexRuntimeConfig({ sandboxMode: "yolo", approvalPolicy: "maybe" }),
    ).toEqual({});
  });
  it("trims and drops a blank workspaceRoot", () => {
    expect(parseCodexRuntimeConfig({ workspaceRoot: "  /scoped  " })).toEqual({
      workspaceRoot: "/scoped",
    });
    expect(parseCodexRuntimeConfig({ workspaceRoot: "   " })).toEqual({});
  });
});
