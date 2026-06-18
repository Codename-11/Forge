import "server-only";
import { RuntimeSelfTestStatus, type Runtime } from "@prisma/client";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";
import {
  makeCodexAppServerConnector,
  parseCodexRuntimeConfig,
} from "@/server/services/dispatch/codex-app-server";
import {
  makeHermesRunsConnector,
  parseHermesRuntimeConfig,
} from "@/server/services/dispatch/hermes-runs";
import type { DispatchConnector, RunEvent, RunInput } from "@/server/services/dispatch/types";
import { sanitizeRuntimeProbeDetail } from "@/server/services/runtime-status";

type RuntimeSelfTestRuntime = Pick<
  Runtime,
  "adapterKey" | "endpoint" | "secret" | "config"
>;

export type RuntimeSelfTestTone = "success" | "warning" | "danger" | "muted";

export type RuntimeSelfTestSummaryStatus = RuntimeSelfTestStatus | "NOT_RUN";

export interface RuntimeSelfTestSummary {
  status: RuntimeSelfTestSummaryStatus;
  label: string;
  tone: RuntimeSelfTestTone;
  detail: string;
  lastRunAt: Date | string | null;
  durationMs: number | null;
  supported: boolean;
  expectation: string;
}

export interface RuntimeSelfTestResult {
  attempted: boolean;
  status: RuntimeSelfTestStatus;
  detail: string;
  durationMs: number | null;
}

const SELF_TEST_MARKER = "FORGE_RUNTIME_SELF_TEST_OK";
const SELF_TEST_TIMEOUT_MS = 45_000;

const SELF_TEST_INPUT: RunInput = {
  message:
    `Forge runtime self-test. Reply with exactly ${SELF_TEST_MARKER}. ` +
    "Do not inspect files, run commands, or call tools.",
  instructions:
    `You are running a Forge runtime connectivity self-test. Reply with exactly ${SELF_TEST_MARKER}. ` +
    "Do not use tools, inspect files, make network calls, or change state.",
  engagementMode: "DISCUSS",
  yoloMode: false,
  sessionKey: "forge-runtime-self-test",
};

const SELF_TEST_SUPPORTED_ADAPTERS = new Set(["hermes", "codex-app-server"]);

export function supportsRuntimeSelfTest(adapterKey: string | null | undefined): boolean {
  return !!adapterKey && SELF_TEST_SUPPORTED_ADAPTERS.has(adapterKey);
}

export function summarizeRuntimeSelfTest(input: {
  adapterKey: string | null;
  lastSelfTestAt: Date | string | null;
  lastSelfTestStatus: RuntimeSelfTestStatus | null;
  lastSelfTestDetail: string | null;
  lastSelfTestDurationMs: number | null;
}): RuntimeSelfTestSummary {
  const adapter = getRuntimeAdapter(input.adapterKey);
  const supported = supportsRuntimeSelfTest(input.adapterKey);
  const adapterLabel = adapter?.title ?? input.adapterKey ?? "this runtime";
  const expectation = supported
    ? "Runs a minimal no-tool adapter turn and verifies the runtime can start and complete work."
    : `${adapterLabel} does not expose a self-test turn that Forge can drive.`;

  if (!input.lastSelfTestStatus) {
    return {
      status: "NOT_RUN",
      label: supported ? "not run" : "unsupported",
      tone: "muted",
      detail: supported
        ? "No self-test turn has been recorded for this runtime."
        : expectation,
      lastRunAt: input.lastSelfTestAt,
      durationMs: input.lastSelfTestDurationMs,
      supported,
      expectation,
    };
  }

  if (input.lastSelfTestStatus === RuntimeSelfTestStatus.PASSED) {
    return {
      status: input.lastSelfTestStatus,
      label: "self-test passed",
      tone: "success",
      detail: input.lastSelfTestDetail ?? "Runtime self-test passed.",
      lastRunAt: input.lastSelfTestAt,
      durationMs: input.lastSelfTestDurationMs,
      supported,
      expectation,
    };
  }

  if (input.lastSelfTestStatus === RuntimeSelfTestStatus.UNSUPPORTED) {
    return {
      status: input.lastSelfTestStatus,
      label: "self-test unsupported",
      tone: "muted",
      detail: input.lastSelfTestDetail ?? expectation,
      lastRunAt: input.lastSelfTestAt,
      durationMs: input.lastSelfTestDurationMs,
      supported,
      expectation,
    };
  }

  return {
    status: input.lastSelfTestStatus,
    label: "self-test failed",
    tone: "danger",
    detail: input.lastSelfTestDetail ?? "Runtime self-test failed.",
    lastRunAt: input.lastSelfTestAt,
    durationMs: input.lastSelfTestDurationMs,
    supported,
    expectation,
  };
}

export async function runRuntimeSelfTest(
  runtime: RuntimeSelfTestRuntime,
  opts: { timeoutMs?: number } = {},
): Promise<RuntimeSelfTestResult> {
  const adapter = getRuntimeAdapter(runtime.adapterKey);
  const adapterLabel = adapter?.title ?? runtime.adapterKey ?? "Runtime";
  if (!supportsRuntimeSelfTest(runtime.adapterKey)) {
    return {
      attempted: false,
      status: RuntimeSelfTestStatus.UNSUPPORTED,
      detail: `${adapterLabel} does not support Forge-driven self-test turns yet.`,
      durationMs: null,
    };
  }

  if (!runtime.endpoint) {
    return {
      attempted: false,
      status: RuntimeSelfTestStatus.FAILED,
      detail: `${adapterLabel} self-test cannot run because no endpoint is configured.`,
      durationMs: null,
    };
  }

  const connector = connectorForRuntime(runtime);
  if (!connector) {
    return {
      attempted: false,
      status: RuntimeSelfTestStatus.FAILED,
      detail: `${adapterLabel} self-test cannot build a runtime connector from the saved settings.`,
      durationMs: null,
    };
  }

  return runConnectorSelfTest(connector, {
    timeoutMs: opts.timeoutMs ?? SELF_TEST_TIMEOUT_MS,
  });
}

function connectorForRuntime(runtime: RuntimeSelfTestRuntime): DispatchConnector | null {
  if (runtime.adapterKey === "hermes") {
    const hermes = parseHermesRuntimeConfig(runtime.config);
    return makeHermesRunsConnector({
      baseUrl: runtime.endpoint,
      token: runtime.secret,
      profile: hermes.profile,
      mode: hermes.mode,
      model: hermes.model,
      yoloMode: hermes.yoloMode,
    });
  }

  if (runtime.adapterKey === "codex-app-server") {
    const codex = parseCodexRuntimeConfig(runtime.config);
    return makeCodexAppServerConnector({
      baseUrl: runtime.endpoint,
      token: runtime.secret,
      sandboxMode: codex.sandboxMode,
      approvalPolicy: codex.approvalPolicy,
      model: codex.model,
      yoloMode: codex.yoloMode,
      workspaceRoot: codex.workspaceRoot,
    });
  }

  return null;
}

async function runConnectorSelfTest(
  connector: DispatchConnector,
  opts: { timeoutMs: number },
): Promise<RuntimeSelfTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let externalRunId: string | null = null;
  let output = "";
  let completed = false;
  let failure: string | null = null;

  const remainingMs = () => Math.max(1, opts.timeoutMs - (Date.now() - startedAt));
  const stopRun = () => {
    if (externalRunId && connector.stop) {
      void connector.stop(externalRunId).catch(() => {});
    }
  };

  try {
    const started = await withTimeout(
      connector.startRun(SELF_TEST_INPUT),
      remainingMs(),
      `Self-test did not start within ${opts.timeoutMs}ms.`,
    );
    externalRunId = started.externalRunId;

    await withTimeout(
      connector.subscribe(
        externalRunId,
        (event) => {
          const outcome = consumeSelfTestEvent(event);
          if (outcome.output) output += outcome.output;
          if (outcome.completed) completed = true;
          if (outcome.failure && !failure) {
            failure = outcome.failure;
            stopRun();
          }
        },
        controller.signal,
      ),
      remainingMs(),
      `Self-test did not complete within ${opts.timeoutMs}ms.`,
      () => {
        controller.abort();
        stopRun();
      },
    );

    const durationMs = Date.now() - startedAt;
    if (failure) {
      return failedSelfTest(failure, durationMs);
    }
    if (!completed) {
      return failedSelfTest("Self-test stream ended without a completion event.", durationMs);
    }
    if (!output.includes(SELF_TEST_MARKER)) {
      const suffix = output.trim() ? ` Runtime replied: ${output.trim()}` : "";
      return failedSelfTest(
        `Self-test turn completed but did not return the expected marker.${suffix}`,
        durationMs,
      );
    }
    return {
      attempted: true,
      status: RuntimeSelfTestStatus.PASSED,
      detail: `Self-test turn completed and returned ${SELF_TEST_MARKER}.`,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    stopRun();
    return failedSelfTest(errorMessage(err), durationMs);
  }
}

function consumeSelfTestEvent(event: RunEvent): {
  output?: string;
  completed?: boolean;
  failure?: string;
} {
  switch (event.type) {
    case "content_delta":
      return { output: event.delta };
    case "completed":
      return { completed: true, output: event.finalText };
    case "error":
      return { failure: event.message };
    case "approval_required":
      return {
        failure: `Self-test requested approval for ${event.tool ?? "a runtime action"}; expected a no-tool diagnostic turn.`,
      };
    default:
      return {};
  }
}

function failedSelfTest(raw: string, durationMs: number): RuntimeSelfTestResult {
  return {
    attempted: true,
    status: RuntimeSelfTestStatus.FAILED,
    detail: diagnosticFailureDetail(raw),
    durationMs,
  };
}

function diagnosticFailureDetail(raw: string): string {
  const detail = sanitizeDetail(raw);
  if (looksLikeAuthFailure(detail)) {
    return sanitizeDetail(
      `Authentication failed: ${detail}. Re-authenticate the runtime/provider credentials, refresh or replace the runtime token, then retry.`,
    );
  }
  return detail;
}

function looksLikeAuthFailure(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    /\b(401|403)\b/.test(d) ||
    d.includes("unauthorized") ||
    d.includes("unauthenticated") ||
    d.includes("forbidden") ||
    d.includes("auth") ||
    d.includes("token") ||
    d.includes("credential") ||
    d.includes("login")
  );
}

function sanitizeDetail(detail: string): string {
  return sanitizeRuntimeProbeDetail(detail) ?? "Self-test failed.";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "Self-test failed.";
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
