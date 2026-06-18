import "server-only";

/**
 * Pluggable agent-dispatch abstraction.
 *
 * Forge talks to several kinds of agent runtime (Hermes, webhook-based
 * remotes, local CLI daemons, plain OpenAI-compat models). This module
 * normalises "run an agent turn and stream its lifecycle" into one
 * interface so the chat route and the dispatcher don't bake in any single
 * provider's API. Each connector translates a provider's native protocol
 * into the shared `RunEvent` union; consumers map `RunEvent`s onto the SSE
 * vocabulary (chat) or `AgentRun` updates (dispatch / Mission Control).
 */

/** Which engine drives an agent's interactive chat. See `Agent.runEngine`. */
export type RunEngine = "COMPLETIONS" | "RUNS";

export interface RunMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export type RunEngagementMode = "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";

export interface RunToolPolicy {
  contractVersion: string;
  engagementMode: RunEngagementMode;
  allowedHostTools: string[];
  toolGrant?: {
    accessLevel: "READ_ONLY" | "FULL";
    scopePath?: string | null;
    approvedByUserId?: string | null;
    actionRequestId?: string | null;
    reason?: string | null;
  } | null;
  layers: Array<{
    kind: string;
    label: string;
    enforced: boolean;
    detail: string;
  }>;
}

export interface RunInput {
  /** The latest user message. */
  message: string;
  /** Prior conversation turns (chronological), excluding the system prompt. */
  history?: RunMessage[];
  /** System prompt / instructions for this run. */
  instructions?: string;
  /** Provider model override for this run, when the runtime supports it. */
  model?: string;
  /** Provider profile/session override for runtimes that host multiple profiles. */
  runtimeProfile?: string;
  /** Provider-native runtime mode/profile selector. Distinct from Forge engagement mode. */
  runtimeMode?: string;
  /** Force or disable YOLO/approval-bypass behavior for this run. Undefined inherits runtime config. */
  yoloMode?: boolean;
  /** Resolved Forge engagement mode for this run. Connectors may harden policy from it. */
  engagementMode?: RunEngagementMode;
  /** Forge run protocol/contract version injected into this dispatch. */
  contractVersion?: string;
  /** Effective runtime/tool policy snapshot for this run. */
  toolPolicy?: RunToolPolicy;
  /**
   * Optional memory-scope key. Connectors that support server-side memory
   * (Hermes long-term memory) scope the run to it; others ignore it.
   */
  sessionKey?: string;
}

/**
 * Normalised lifecycle events. A connector emits a subset; consumers
 * tolerate missing kinds. Terminal events are `completed` and `error`.
 */
export type RunEvent =
  | { type: "content_delta"; delta: string }
  | { type: "thinking"; text: string }
  | { type: "tool_started"; tool: string; preview?: string }
  | { type: "tool_completed"; tool: string; durationMs?: number; isError?: boolean }
  | {
      type: "approval_required";
      /** Allowed responses, e.g. ["once","session","always","deny"]. */
      choices: string[];
      tool?: string;
      raw: Record<string, unknown>;
    }
  | {
      /** A pending approval was resolved (by us or another client). Lets a
       * consumer clear a lingering approval card. */
      type: "approval_resolved";
      choice?: string;
    }
  | { type: "usage"; tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { type: "completed"; finalText?: string }
  | { type: "error"; message: string };

export interface StartedRun {
  /** Provider-side run id — stored on `AgentRun.externalRunId`. */
  externalRunId: string;
}

/** Pollable run status — used by the worker's dispatch ingestion. */
export interface RunStatus {
  state:
    | "running"
    | "waiting_for_approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown";
  /** Last lifecycle event name, e.g. "tool.completed" — drives currentStep. */
  lastEvent?: string;
  /** Final assistant text when terminal. */
  output?: string;
  usage?: { tokensIn?: number; tokensOut?: number; costUsd?: number };
}

/**
 * A dispatch connector for one provider family. `subscribe` resolves when
 * the run reaches a terminal state (or `signal` aborts); it must always
 * emit a terminal `completed`/`error` before resolving so consumers can
 * close their writer deterministically.
 */
export interface DispatchConnector {
  readonly kind: string;
  startRun(input: RunInput): Promise<StartedRun>;
  subscribe(
    externalRunId: string,
    onEvent: (e: RunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Poll current run status (used by worker dispatch ingestion). */
  getStatus?(externalRunId: string): Promise<RunStatus>;
  /** Resolve a pending approval (Hermes choices: once|session|always|deny). */
  approve?(externalRunId: string, choice: string): Promise<void>;
  /** Interrupt a running agent. */
  stop?(externalRunId: string): Promise<void>;
}
