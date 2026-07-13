import "server-only";
import WebSocket from "ws";
import { logger } from "@/server/logger";
import { redisPub, redisSub } from "@/server/redis";
import type {
  DispatchConnector,
  RunEvent,
  RunInput,
  RunStatus,
  StartedRun,
} from "./types";

/**
 * Connector for the **Codex app server** — OpenAI's long-lived agent process
 * exposing a bidirectional **JSON-RPC 2.0** interface (the same surface that
 * powers the Codex web/desktop/VS Code clients). Started by the operator as:
 *
 *   codex app-server --listen ws://HOST:PORT      (WebSocket — what we dial)
 *   codex app-server --listen unix://…            (Unix socket)
 *   codex app-server                              (stdio; daemon-mediated only)
 *
 * This makes a Codex agent **first-class** (Tier 1), the OpenAI analogue to
 * the Hermes gateway: the runtime owns the loop and the agent answers as
 * itself. The `Runtime.endpoint` is the `ws(s)://` URL; `Runtime.secret`, when
 * set, is sent as a Bearer header for deployments that gate the socket.
 *
 * Protocol (see https://developers.openai.com/codex/app-server and
 * openai/codex `codex-rs/app-server/README.md`). The `"jsonrpc":"2.0"` field
 * is omitted on the wire; messages are `{id,method,params}` (request),
 * `{id,result|error}` (response), `{method,params}` (notification):
 *   initialize → initialized (handshake, once per connection)
 *   thread/start → { thread:{id} }            ·  turn/start → { turn:{id} }
 *   item/agentMessage/delta {delta}           ·  item/reasoning/summaryTextDelta {delta}
 *   item/started / item/completed {type,…}    ·  turn/completed {status,usage}
 *   item/commandExecution/requestApproval (server→client request) → {decision}
 *   turn/interrupt {threadId,turnId}
 *
 * Each run owns one WebSocket for its lifetime; `startRun` opens + handshakes +
 * starts the turn, `subscribe` drains notifications until `turn/completed`.
 */

type JsonRpcId = number;

interface PendingRun {
  ws: WebSocket;
  threadId: string;
  turnId: string;
  /** id of the most recent server→client approval request awaiting a reply. */
  pendingApprovalId: JsonRpcId | null;
  /** Resolvers for our outbound requests, keyed by JSON-RPC id. */
  awaiting: Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Buffered notifications that arrive before `subscribe` attaches. */
  buffer: RunEvent[];
  onEvent: ((e: RunEvent) => void) | null;
  terminal: boolean;
  terminalStopped?: boolean;
  terminalError?: string;
  usage?: RunStatus["usage"];
  finalText: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const TERMINAL_RUN_RETENTION_MS = 5 * 60_000;
const runs = new Map<string, PendingRun>();

/** Encode/decode the externalRunId that correlates startRun ↔ subscribe. */
function encodeRunId(threadId: string, turnId: string): string {
  return `${threadId}#${turnId}`;
}

function scheduleRunCleanup(externalRunId: string) {
  const run = runs.get(externalRunId);
  if (!run || run.cleanupTimer) return;
  run.cleanupTimer = setTimeout(() => runs.delete(externalRunId), TERMINAL_RUN_RETENTION_MS);
  run.cleanupTimer.unref?.();
}

/**
 * Cross-process control channel. A Codex run's WebSocket + `pendingApprovalId`
 * live only in the process that called `startRun` — for dispatched work that's
 * the **forge-worker** container (where the runs-dispatch poll runs). But the
 * operator's Approve/Reject button hits the `respondApproval` tRPC mutation in
 * the **web** container, which has an empty `runs` map. Resolving the approval
 * directly there is a silent no-op, so the run flips running↔waiting forever
 * (see instrumentation.ts on split in-process worker state).
 *
 * Fix: the owning process subscribes here on `startRun`; the other process
 * publishes the decision and the owner applies it to the live socket.
 */
const CODEX_CONTROL_CHANNEL = "forge:codex:control";

interface CodexControlMsg {
  externalRunId: string;
  action: "approve" | "stop";
  choice?: string;
}

let controlSub: ReturnType<typeof redisSub.duplicate> | null = null;

function ensureControlSubscriber() {
  if (controlSub) return;
  // Unit tests exercise startRun against a local ws server with no Redis;
  // the cross-process relay isn't under test there, so stay inert.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  const sub = redisSub.duplicate();
  controlSub = sub;
  // A missing/blipping Redis must never crash the dispatch process — log and
  // let ioredis reconnect on its own schedule.
  sub.on("error", (err: Error) =>
    logger.warn({ err }, "codex-app-server: control channel error"),
  );
  void sub.subscribe(CODEX_CONTROL_CHANNEL).catch((err) => {
    logger.warn({ err }, "codex-app-server: control subscribe failed");
  });
  sub.on("message", (_channel: string, raw: string) => {
    let msg: CodexControlMsg;
    try {
      msg = JSON.parse(raw) as CodexControlMsg;
    } catch {
      return;
    }
    const run = runs.get(msg.externalRunId);
    if (!run) return; // socket not owned by this process — another owner will apply
    if (msg.action === "approve") applyApproveLocal(run, msg.choice ?? "once");
    else if (msg.action === "stop") applyStopLocal(run);
  });
}

/** Reply to a server→client request: {id,result}. */
function rawRespond(ws: WebSocket, id: JsonRpcId, result: unknown) {
  ws.send(JSON.stringify({ id, result }));
}

/** Outbound notification: {method,params?}. */
function rawNotify(ws: WebSocket, method: string, params?: unknown) {
  const msg: Record<string, unknown> = { method };
  if (params !== undefined) msg.params = params;
  ws.send(JSON.stringify(msg));
}

/**
 * Resolve a pending approval on a locally-owned run. Maps Forge's choice
 * vocabulary (once|session|always|deny) onto Codex's decision enum. Returns
 * false when there's nothing to resolve.
 */
function applyApproveLocal(run: PendingRun, choice: string): boolean {
  if (run.pendingApprovalId === null) return false;
  const decision =
    choice === "session" || choice === "always"
      ? "acceptForSession"
      : choice === "deny" || choice === "decline"
        ? "decline"
        : "accept";
  rawRespond(run.ws, run.pendingApprovalId, { decision });
  run.pendingApprovalId = null;
  return true;
}

/** Cancel any pending approval and interrupt the turn on a locally-owned run. */
function applyStopLocal(run: PendingRun) {
  try {
    if (run.pendingApprovalId !== null) {
      rawRespond(run.ws, run.pendingApprovalId, { decision: "cancel" });
      run.pendingApprovalId = null;
    }
    if (run.turnId) {
      rawNotify(run.ws, "turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    }
  } catch (err) {
    logger.warn({ err }, "codex-app-server: stop failed");
  }
}

/**
 * Pure map from a Codex JSON-RPC **notification** to a normalised `RunEvent`,
 * or null when the notification carries no chat-relevant signal. Extracted so
 * the (live-socket) connector stays thin and this mapping is unit-tested
 * without a running Codex instance.
 */
export function mapCodexNotification(
  method: string,
  params: Record<string, unknown>,
): RunEvent | null {
  switch (method) {
    case "item/agentMessage/delta": {
      const delta = typeof params.delta === "string" ? params.delta : "";
      return delta ? { type: "content_delta", delta } : null;
    }
    case "item/reasoning/summaryTextDelta": {
      const delta = typeof params.delta === "string" ? params.delta : "";
      return delta ? { type: "thinking", text: delta } : null;
    }
    case "item/started": {
      // Surface command/tool work as a tool card. Plain agentMessage items
      // stream via the delta event above, so skip them here.
      const type = typeof params.type === "string" ? params.type : "";
      if (type === "agentMessage" || type === "userMessage" || !type) return null;
      return {
        type: "tool_started",
        tool: codexItemLabel(type, params),
        callId: codexItemId(params),
      };
    }
    case "item/completed": {
      const type = typeof params.type === "string" ? params.type : "";
      if (type === "agentMessage" || type === "userMessage" || !type) return null;
      const isError = codexItemIsError(params);
      return {
        type: "tool_completed",
        tool: codexItemLabel(type, params),
        callId: codexItemId(params),
        isError,
      };
    }
    case "turn/completed": {
      // Status lives at params.turn.status (verified against codex-cli 0.133).
      const turn = params.turn as { status?: string; error?: unknown } | undefined;
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      if (status === "failed") {
        return { type: "error", message: codexFailureMessage(turn ?? params) };
      }
      if (status === "interrupted" || status === "cancelled" || status === "canceled") {
        return { type: "stopped", reason: "Codex turn was interrupted." };
      }
      return { type: "completed" };
    }
    case "model/rerouted":
    case "turn/started":
    case "turn/plan/updated":
    case "turn/diff/updated":
      return null;
    default:
      return null;
  }
}

function codexItemId(params: Record<string, unknown>): string | undefined {
  const item =
    params.item && typeof params.item === "object" && !Array.isArray(params.item)
      ? (params.item as Record<string, unknown>)
      : null;
  const raw = params.itemId ?? params.item_id ?? params.id ?? item?.id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function codexItemLabel(type: string, params: Record<string, unknown>): string {
  if (type === "commandExecution") {
    const cmd = params.command;
    if (typeof cmd === "string" && cmd.length > 0) {
      return cmd.length > 64 ? `${cmd.slice(0, 61)}…` : cmd;
    }
    return "command";
  }
  if (type === "fileChange") return "file change";
  if (type === "mcpToolCall") {
    const tool = params.tool ?? params.name;
    return typeof tool === "string" ? tool : "tool";
  }
  return type;
}

function codexItemIsError(params: Record<string, unknown>): boolean {
  const status = typeof params.status === "string" ? params.status.toLowerCase() : "";
  if (status.includes("fail") || status.includes("error")) return true;
  const exit = params.exitCode;
  return typeof exit === "number" && exit !== 0;
}

function codexFailureMessage(params: Record<string, unknown>): string {
  const err = params.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return "Codex turn failed";
}

/** Extract `{tokensIn,tokensOut}` from a Codex `turn/completed` usage block. */
export function mapCodexUsage(
  usage: Record<string, unknown> | undefined,
): RunStatus["usage"] | undefined {
  if (!usage) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const inTok = num(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens);
  const outTok = num(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens);
  if (inTok === undefined && outTok === undefined) return undefined;
  return { tokensIn: inTok, tokensOut: outTok };
}

/** Operator-chosen sandbox tier for a Codex run. Maps to `SandboxPolicy`. */
export type CodexSandboxMode = "danger-full-access" | "workspace-write" | "read-only";
/** Codex approval gating. Subset of codex's `AskForApproval` we expose. */
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export const CODEX_SANDBOX_MODES: CodexSandboxMode[] = [
  "danger-full-access",
  "workspace-write",
  "read-only",
];
export const CODEX_APPROVAL_POLICIES: CodexApprovalPolicy[] = [
  "never",
  "on-request",
  "on-failure",
  "untrusted",
];

export interface CodexRuntimeConfig {
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  model?: string;
  yoloMode?: boolean;
  workspaceRoot?: string;
}

/**
 * Defensively read `Runtime.config` (untyped Prisma `Json`) into the codex
 * policy knobs. Unknown / malformed values are dropped so the connector
 * falls back to its safe defaults (full access, no prompts) — never throws.
 */
export function parseCodexRuntimeConfig(config: unknown): CodexRuntimeConfig {
  if (!config || typeof config !== "object") return {};
  const c = config as Record<string, unknown>;
  const out: CodexRuntimeConfig = {};
  if (typeof c.sandboxMode === "string" && CODEX_SANDBOX_MODES.includes(c.sandboxMode as CodexSandboxMode))
    out.sandboxMode = c.sandboxMode as CodexSandboxMode;
  if (
    typeof c.approvalPolicy === "string" &&
    CODEX_APPROVAL_POLICIES.includes(c.approvalPolicy as CodexApprovalPolicy)
  )
    out.approvalPolicy = c.approvalPolicy as CodexApprovalPolicy;
  if (typeof c.model === "string" && c.model.trim()) out.model = c.model.trim();
  if (typeof c.yoloMode === "boolean") out.yoloMode = c.yoloMode;
  if (typeof c.workspaceRoot === "string" && c.workspaceRoot.trim())
    out.workspaceRoot = c.workspaceRoot.trim();
  return out;
}

/**
 * Translate the operator-facing sandbox tier into codex's per-turn
 * `SandboxPolicy` (verified against codex-cli 0.133 `SandboxPolicy`). For
 * `workspace-write` the writable root is the run's working dir (`cwd`), so a
 * sandboxed Codex can only modify the scoped workspace the bridge mounts.
 * Network stays off in the sandboxed tiers — escalation routes through the
 * approval policy, surfacing as approval cards in Forge.
 */
function toSandboxPolicy(
  mode: CodexSandboxMode,
  cwd: string | undefined,
): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: cwd ? [cwd] : [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case "danger-full-access":
    default:
      return { type: "dangerFullAccess" };
  }
}

export function makeCodexAppServerConnector(opts: {
  baseUrl: string | null;
  token?: string | null;
  /**
   * Per-runtime policy from `Runtime.config`. Drives per-turn overrides sent
   * in `turn/start`. Omitted/partial = today's behavior (full access, no
   * prompts) so existing Codex runtimes are unchanged.
   */
  sandboxMode?: CodexSandboxMode | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  model?: string | null;
  yoloMode?: boolean | null;
  /** Working directory + writable root for the run (e.g. the bridge's /work). */
  workspaceRoot?: string | null;
}): DispatchConnector | null {
  const url = opts.baseUrl?.trim();
  if (!url) return null;
  const sandboxMode = opts.sandboxMode ?? "danger-full-access";
  const approvalPolicy = opts.approvalPolicy ?? "never";
  const runtimeModel = opts.model?.trim() || undefined;
  const runtimeYoloMode = opts.yoloMode === true;
  const workspaceRoot = opts.workspaceRoot?.trim() || undefined;

  let nextId = 1;

  // Outbound request or notification: {id?,method,params?}.
  const send = (ws: WebSocket, method: string, params?: unknown, id?: JsonRpcId) => {
    const msg: Record<string, unknown> = { method };
    if (id !== undefined) msg.id = id;
    if (params !== undefined) msg.params = params;
    ws.send(JSON.stringify(msg));
  };

  // Reply to a server→client request: {id,result}. Used for approvals and
  // dynamic tool-call requests Codex initiates mid-turn.
  const respond = (ws: WebSocket, id: JsonRpcId, result: unknown) => {
    ws.send(JSON.stringify({ id, result }));
  };

  const request = (run: PendingRun, method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      run.awaiting.set(id, { resolve, reject });
      send(run.ws, method, params, id);
    });
  };

  const emit = (run: PendingRun, e: RunEvent) => {
    if (e.type === "content_delta") run.finalText += e.delta;
    if (e.type === "completed" && !run.finalText && typeof e.finalText === "string") {
      run.finalText = e.finalText;
    }
    if (run.onEvent) run.onEvent(e);
    else run.buffer.push(e);
  };

  /** Wire the socket's message pump for a run. */
  const attachPump = (run: PendingRun) => {
    run.ws.on("message", (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = msg.id as JsonRpcId | undefined;
      const method = typeof msg.method === "string" ? msg.method : undefined;

      // Response to one of our requests.
      if (id !== undefined && method === undefined) {
        const pending = run.awaiting.get(id);
        if (pending) {
          run.awaiting.delete(id);
          if (msg.error) {
            const em =
              (msg.error as { message?: string })?.message ?? "Codex request failed";
            pending.reject(new Error(em));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      if (!method) return;
      const params = (msg.params ?? {}) as Record<string, unknown>;

      // Server→client request: approvals / dynamic tool calls. These carry an
      // `id` we must reply to. Surface as an approval card; hold the id so
      // `approve`/`stop` can resolve it.
      if (id !== undefined) {
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          run.pendingApprovalId = id;
          const command =
            typeof params.command === "string"
              ? params.command
              : typeof params.reason === "string"
                ? params.reason
                : "approval";
          emit(run, {
            type: "approval_required",
            choices: ["once", "session", "deny"],
            callId: String(id),
            tool: command,
            raw: { ...params, _codexRequestId: id },
          });
        } else if (method === "item/tool/call") {
          // Dynamic tool call we can't execute — decline so the run proceeds.
          respond(run.ws, id, { contentItems: [], success: false });
        }
        return;
      }

      // Capture the authoritative final agent message — `item/completed` for
      // an agentMessage carries the whole text, so it's a reliable fallback
      // if delta events were missed (keeps the reply from finalizing empty).
      if (method === "item/completed") {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
          run.finalText = item.text;
        }
      }

      // Plain notification.
      const evt = mapCodexNotification(method, params);
      if (method === "turn/completed") {
        const turn = params.turn as { status?: string; error?: unknown } | undefined;
        const status = typeof turn?.status === "string" ? turn.status : "completed";
        if (status === "failed") {
          run.terminalError = codexFailureMessage(turn ?? params);
        }
        if (status === "interrupted" || status === "cancelled" || status === "canceled") {
          run.terminalStopped = true;
        }
        run.usage = mapCodexUsage(params.usage as Record<string, unknown> | undefined);
        if (run.usage) emit(run, { type: "usage", ...run.usage });
        run.terminal = true;
      }
      if (evt) {
        // Attach the assembled/authoritative text to the terminal event so a
        // delta-less turn still yields a non-empty reply (route falls back to
        // `completed.finalText` when no content deltas streamed).
        if (evt.type === "completed") {
          emit(run, { type: "completed", finalText: run.finalText || undefined });
        } else {
          emit(run, evt);
        }
      }
    });

    run.ws.on("error", (err: Error) => {
      run.terminalError = err.message;
      if (!run.terminal) emit(run, { type: "error", message: err.message });
      run.terminal = true;
    });
    run.ws.on("close", () => {
      if (!run.terminal) {
        const message = "Codex app-server WebSocket closed before turn/completed.";
        run.terminalError = message;
        emit(run, { type: "error", message });
        run.terminal = true;
      }
    });
  };

  const openSocket = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const ws = new WebSocket(url, { headers });
      const onOpen = () => {
        ws.off("error", onErr);
        resolve(ws);
      };
      const onErr = (e: Error) => {
        ws.off("open", onOpen);
        reject(e);
      };
      ws.once("open", onOpen);
      ws.once("error", onErr);
    });

  return {
    kind: "codex-app-server",

    async startRun(input: RunInput): Promise<StartedRun> {
      // This process now owns a Codex socket — subscribe so cross-process
      // approve/stop relays (from the web container) reach it.
      ensureControlSubscriber();
      const ws = await openSocket();
      const run: PendingRun = {
        ws,
        threadId: "",
        turnId: "",
        pendingApprovalId: null,
        awaiting: new Map(),
        buffer: [],
        onEvent: null,
        terminal: false,
        finalText: "",
      };
      attachPump(run);

      // Handshake. capabilities requires both experimentalApi + requestAttestation
      // (verified against codex-cli 0.133 InitializeCapabilities).
      await request(run, "initialize", {
        clientInfo: { name: "forge", title: "Forge", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      send(ws, "initialized");

      // New thread, then a turn carrying the user message. Codex keeps prior
      // turns in the thread itself; we pass instructions + the latest message.
      const threadParams: Record<string, unknown> = {};
      const grantScope = input.toolPolicy?.toolGrant?.scopePath?.trim() || undefined;
      const runWorkspaceRoot = grantScope ?? workspaceRoot;
      if (runWorkspaceRoot) threadParams.cwd = runWorkspaceRoot;
      const effectiveModel = input.model?.trim() || runtimeModel;
      if (effectiveModel) threadParams.model = effectiveModel;
      const threadRes = (await request(run, "thread/start", threadParams)) as {
        thread?: { id?: string };
      };
      const threadId = threadRes.thread?.id;
      if (!threadId) {
        ws.close();
        throw new Error("Codex app-server: thread/start returned no thread id");
      }
      run.threadId = threadId;

      // UserInput text blocks require `text_elements` (verified against
      // codex-cli 0.133 UserInput) — omitting it fails deserialization.
      // Each run opens a fresh thread, so prior turns won't be in Codex's
      // context — fold the conversation history into the prompt for continuity.
      const textBlock = (text: string) => ({ type: "text", text, text_elements: [] });
      const turnInput: Array<Record<string, unknown>> = [];
      if (input.instructions) turnInput.push(textBlock(input.instructions));
      if (input.history && input.history.length > 0) {
        const transcript = input.history
          .map((m) => `${m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User"}: ${m.content}`)
          .join("\n");
        turnInput.push(textBlock(`# Conversation so far\n${transcript}`));
      }
      turnInput.push(textBlock(input.message));
      // Per-turn policy overrides (codex-cli 0.133 TurnStartParams accepts
      // cwd / approvalPolicy / sandboxPolicy and applies them to this turn and
      // subsequent turns on the thread). Defaults reproduce today's behavior.
      const yoloMode = input.yoloMode ?? runtimeYoloMode;
      const grantSandboxMode: CodexSandboxMode | null = input.toolPolicy?.toolGrant
        ? input.toolPolicy.toolGrant.accessLevel === "FULL"
          ? "workspace-write"
          : "read-only"
        : null;
      const effectiveSandboxMode =
        grantSandboxMode ??
        (yoloMode
          ? "danger-full-access"
          : input.engagementMode && input.engagementMode !== "EXECUTE"
            ? "read-only"
            : sandboxMode);
      const effectiveApprovalPolicy = yoloMode ? "never" : approvalPolicy;
      const turnParams: Record<string, unknown> = { threadId, input: turnInput };
      if (runWorkspaceRoot) turnParams.cwd = runWorkspaceRoot;
      if (effectiveModel) turnParams.model = effectiveModel;
      turnParams.approvalPolicy = effectiveApprovalPolicy;
      turnParams.sandboxPolicy = toSandboxPolicy(effectiveSandboxMode, runWorkspaceRoot);
      const turnRes = (await request(run, "turn/start", turnParams)) as {
        turn?: { id?: string };
      };
      const turnId = turnRes.turn?.id ?? "";
      run.turnId = turnId;

      const externalRunId = encodeRunId(threadId, turnId);
      runs.set(externalRunId, run);
      return { externalRunId };
    },

    async subscribe(
      externalRunId: string,
      onEvent: (e: RunEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      const run = runs.get(externalRunId);
      if (!run) {
        onEvent({ type: "error", message: "Codex app-server: unknown run" });
        return;
      }
      // Flush anything buffered before we attached, then live-stream.
      run.onEvent = onEvent;
      for (const e of run.buffer.splice(0)) onEvent(e);

      await new Promise<void>((resolve) => {
        if (run.terminal) return resolve();
        const onAbort = () => {
          try {
            if (run.turnId) {
              send(run.ws, "turn/interrupt", {
                threadId: run.threadId,
                turnId: run.turnId,
              });
            }
          } catch {
            /* socket already closing */
          }
          finish();
        };
        const tick = setInterval(() => {
          if (run.terminal) finish();
        }, 50);
        const finish = () => {
          clearInterval(tick);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });

      try {
        run.ws.close();
      } catch {
        /* already closed */
      }
      scheduleRunCleanup(externalRunId);
    },

    async getStatus(externalRunId: string): Promise<RunStatus> {
      const run = runs.get(externalRunId);
      if (!run) {
        return {
          state: "unknown",
          output:
            "Codex app-server run is no longer tracked by this Forge process; the WebSocket session was lost before a terminal status could be read.",
        };
      }
      if (run.terminal) {
        scheduleRunCleanup(externalRunId);
        if (run.terminalError) {
          return { state: "failed", output: run.terminalError, usage: run.usage };
        }
        if (run.terminalStopped) {
          return { state: "cancelled", output: run.finalText || undefined, usage: run.usage };
        }
        return { state: "completed", output: run.finalText || undefined, usage: run.usage };
      }
      return {
        state: run.pendingApprovalId !== null ? "waiting_for_approval" : "running",
        output: run.finalText || undefined,
        usage: run.usage,
      };
    },

    async approve(externalRunId: string, choice: string): Promise<void> {
      const run = runs.get(externalRunId);
      if (run) {
        applyApproveLocal(run, choice);
        return;
      }
      // Socket lives in another process (worker owns dispatched runs). Relay
      // the decision over Redis so the owner applies it to the live socket.
      try {
        await redisPub.publish(
          CODEX_CONTROL_CHANNEL,
          JSON.stringify({ externalRunId, action: "approve", choice } satisfies CodexControlMsg),
        );
      } catch (err) {
        logger.warn({ err, externalRunId }, "codex-app-server: approve relay failed");
      }
    },

    async stop(externalRunId: string): Promise<void> {
      const run = runs.get(externalRunId);
      if (run) {
        applyStopLocal(run);
        return;
      }
      try {
        await redisPub.publish(
          CODEX_CONTROL_CHANNEL,
          JSON.stringify({ externalRunId, action: "stop" } satisfies CodexControlMsg),
        );
      } catch (err) {
        logger.warn({ err, externalRunId }, "codex-app-server: stop relay failed");
      }
    },
  };
}
