import "server-only";
import type { DispatchConnector, RunEvent, RunInput, RunStatus, StartedRun } from "./types";

/**
 * Deterministic in-process dispatch connector for **E2E tests only**.
 *
 * It streams scripted `RunEvent`s with no external service, so the full
 * RUNS chat path (start → stream deltas → terminal) and the approval loop are
 * exercisable in a browser test without a real Hermes / Codex endpoint or any
 * auth. Wired in `registry.ts` strictly behind `process.env.FORGE_E2E === "1"`
 * for runtimes whose `adapterKey === "mock-runs"`, so it can never resolve in
 * production.
 *
 * Scenario is chosen from the user's message so one seeded agent covers
 * several flows:
 *   - contains "approve"  → emits an approval request, completes once
 *     `approve()` resolves it (accept) or is declined.
 *   - contains "boom"     → emits an error (terminal).
 *   - otherwise           → streams a short reply and completes.
 */
export function makeMockRunsConnector(): DispatchConnector {
  type Pending = {
    input: RunInput;
    approval?: { resolve: (decision: string) => void; promise: Promise<string> };
    aborted: boolean;
  };
  const runs = new Map<string, Pending>();
  let seq = 0;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return {
    kind: "mock-runs",

    async startRun(input: RunInput): Promise<StartedRun> {
      const externalRunId = `mock-${++seq}-${Date.now()}`;
      runs.set(externalRunId, { input, aborted: false });
      return { externalRunId };
    },

    async subscribe(
      externalRunId: string,
      onEvent: (e: RunEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const run = runs.get(externalRunId);
      if (!run) {
        onEvent({ type: "error", message: "mock-runs: unknown run" });
        return;
      }
      if (signal) {
        if (signal.aborted) run.aborted = true;
        signal.addEventListener("abort", () => {
          run.aborted = true;
          run.approval?.resolve("deny");
        });
      }
      const msg = run.input.message.toLowerCase();

      if (msg.includes("boom")) {
        onEvent({ type: "error", message: "mock-runs: simulated failure" });
        return;
      }

      // Stream a short reply token-by-token.
      const reply = "E2E mock reply: pong";
      for (const chunk of reply.match(/.{1,4}/g) ?? [reply]) {
        if (run.aborted) break;
        onEvent({ type: "content_delta", delta: chunk });
        await sleep(15);
      }

      if (msg.includes("approve")) {
        // Raise an approval and wait for the operator's decision.
        let resolve!: (d: string) => void;
        const promise = new Promise<string>((r) => (resolve = r));
        run.approval = { resolve, promise };
        onEvent({
          type: "approval_required",
          choices: ["once", "session", "deny"],
          tool: "rm -rf ./scratch",
          raw: { command: "rm -rf ./scratch", _mockRunId: externalRunId },
        });
        const decision = await Promise.race([promise, sleep(20_000).then(() => "deny")]);
        onEvent({ type: "approval_resolved", choice: decision });
        if (decision === "deny") {
          onEvent({ type: "content_delta", delta: " — denied, stopping." });
          onEvent({ type: "completed", finalText: `${reply} — denied, stopping.` });
          return;
        }
        onEvent({ type: "content_delta", delta: " — approved, done." });
        onEvent({ type: "usage", tokensIn: 12, tokensOut: 8 });
        onEvent({ type: "completed", finalText: `${reply} — approved, done.` });
        return;
      }

      onEvent({ type: "usage", tokensIn: 10, tokensOut: 6 });
      onEvent({ type: "completed", finalText: reply });
    },

    async getStatus(externalRunId: string): Promise<RunStatus> {
      const run = runs.get(externalRunId);
      if (!run) return { state: "completed" };
      if (run.approval) return { state: "waiting_for_approval" };
      return { state: "running" };
    },

    async approve(externalRunId: string, choice: string): Promise<void> {
      runs.get(externalRunId)?.approval?.resolve(choice);
    },

    async stop(externalRunId: string): Promise<void> {
      const run = runs.get(externalRunId);
      if (run) {
        run.aborted = true;
        run.approval?.resolve("deny");
      }
    },
  };
}

let sharedMockRunsConnector: DispatchConnector | null = null;

/**
 * Worker dispatch resolves the connector separately for start, subscribe, and
 * poll. Keep one in-process instance in E2E mode so those calls observe the
 * same external run, matching a real managed runtime service.
 */
export function sharedMockRunsConnectorForTests(): DispatchConnector {
  sharedMockRunsConnector ??= makeMockRunsConnector();
  return sharedMockRunsConnector;
}
