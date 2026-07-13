import { describe, expect, it } from "vitest";
import {
  chatStatusMetaFromDiagnostics,
  parsePersistedOutbox,
  readStreamedSnapshot,
  serializePersistedOutbox,
  type PersistedOutbound,
} from "@/components/mission-control/chat-ui-state";

describe("chatStatusMetaFromDiagnostics", () => {
  it("uses canonical diagnostics instead of inferring from message age", () => {
    expect(
      chatStatusMetaFromDiagnostics({
        dispatchState: "wake-sent",
        turnStatus: { phase: "delivered", label: "Delivered" },
      }),
    ).toEqual({ label: "delivered", tone: "sky" });
    expect(
      chatStatusMetaFromDiagnostics({
        dispatchState: "running",
        turnStatus: { phase: "awaiting_approval", label: "Approval required" },
      }),
    ).toEqual({ label: "approval", tone: "ember" });
    expect(
      chatStatusMetaFromDiagnostics({
        dispatchState: "idle",
        turnStatus: { phase: "failed", label: "Needs attention" },
      }),
    ).toEqual({ label: "failed", tone: "red" });
  });
});

describe("readStreamedSnapshot", () => {
  it("rehydrates a running partial response with reasoning and approvals", () => {
    expect(
      readStreamedSnapshot({
        streamed: true,
        running: true,
        partial_text: "Partial reply",
        thinking: "Checking the runtime",
        run_external_id: "run_123",
        clientTurnId: "turn_123",
        started_at: "2026-07-13T12:00:00.000Z",
        streamUpdatedAt: "2026-07-13T12:00:01.000Z",
        usage: { tokensIn: 120, tokensOut: 30, tokensCached: 10, costUsd: 0.0025 },
        tool_calls: [
          {
            id: "call_1",
            name: "issues.update",
            args: { id: "AXI-1" },
            status: "pending",
            requires_confirm: true,
          },
        ],
      }),
    ).toMatchObject({
      running: true,
      partialText: "Partial reply",
      thinking: "Checking the runtime",
      runExternalId: "run_123",
      turnId: "turn_123",
      streamUpdatedAt: Date.parse("2026-07-13T12:00:01.000Z"),
      usage: { tokensIn: 120, tokensOut: 30, tokensCached: 10, costUsd: 0.0025 },
      toolCalls: [
        expect.objectContaining({ id: "call_1", status: "pending", requiresConfirm: true }),
      ],
    });
  });

  it("distinguishes durable MCP drafts from direct runtime streams", () => {
    expect(
      readStreamedSnapshot({
        draft: true,
        draftId: "draft_1",
        running: true,
        partial_text: "Drafting",
      }),
    ).toMatchObject({
      draft: true,
      draftId: "draft_1",
      running: true,
      partialText: "Drafting",
    });
  });

  it("retains stopped and failed terminal state", () => {
    expect(readStreamedSnapshot({ streamed: true, aborted: true })).toMatchObject({
      running: false,
      stopped: true,
    });
    expect(readStreamedSnapshot({ streamed: true, error: "Gateway unavailable" })).toMatchObject({
      running: false,
      error: "Gateway unavailable",
    });
  });
});

describe("persisted chat outbox", () => {
  const row: PersistedOutbound = {
    id: "_q_turn-1",
    clientTurnId: "turn-1",
    body: "Continue the audit",
    context: { issueId: "issue-1" },
    createdAt: 1_752_408_000_000,
    displayFiles: [],
    status: "queued",
  };

  it("round-trips text turns with their stable idempotency identity", () => {
    expect(parsePersistedOutbox(serializePersistedOutbox([row]))).toEqual([row]);
  });

  it("does not silently retry recovered attachments without File objects", () => {
    const recovered = parsePersistedOutbox(
      serializePersistedOutbox([{ ...row, displayFiles: ["brief.pdf"] }]),
    );
    expect(recovered[0]).toMatchObject({
      status: "failed",
      error: "Reattach files before retrying this recovered message.",
    });
  });

  it("rejects malformed storage", () => {
    expect(parsePersistedOutbox("not-json")).toEqual([]);
    expect(parsePersistedOutbox(JSON.stringify([{ body: "missing identity" }]))).toEqual([]);
  });
});
