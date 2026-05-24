import { describe, it, expect } from "vitest";
import {
  mapCodexNotification,
  mapCodexUsage,
  makeCodexAppServerConnector,
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
});
