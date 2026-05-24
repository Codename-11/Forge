import "server-only";
import WebSocket from "ws";
import { logger } from "@/server/logger";
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
  usage?: RunStatus["usage"];
  finalText: string;
}

/** Encode/decode the externalRunId that correlates startRun ↔ subscribe. */
function encodeRunId(threadId: string, turnId: string): string {
  return `${threadId}#${turnId}`;
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
      return { type: "tool_started", tool: codexItemLabel(type, params) };
    }
    case "item/completed": {
      const type = typeof params.type === "string" ? params.type : "";
      if (type === "agentMessage" || type === "userMessage" || !type) return null;
      const isError = codexItemIsError(params);
      return { type: "tool_completed", tool: codexItemLabel(type, params), isError };
    }
    case "turn/completed": {
      const status = typeof params.status === "string" ? params.status : "completed";
      if (status === "failed") {
        return { type: "error", message: codexFailureMessage(params) };
      }
      // interrupted + completed both terminate cleanly; final text is
      // assembled from deltas by the caller.
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

export function makeCodexAppServerConnector(opts: {
  baseUrl: string | null;
  token?: string | null;
}): DispatchConnector | null {
  const url = opts.baseUrl?.trim();
  if (!url) return null;

  const runs = new Map<string, PendingRun>();
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
            tool: command,
            raw: { ...params, _codexRequestId: id },
          });
        } else if (method === "item/tool/call") {
          // Dynamic tool call we can't execute — decline so the run proceeds.
          respond(run.ws, id, { contentItems: [], success: false });
        }
        return;
      }

      // Plain notification.
      const evt = mapCodexNotification(method, params);
      if (method === "turn/completed") {
        run.usage = mapCodexUsage(params.usage as Record<string, unknown> | undefined);
        run.terminal = true;
      }
      if (evt) emit(run, evt);
    });

    run.ws.on("error", (err: Error) => {
      if (!run.terminal) emit(run, { type: "error", message: err.message });
      run.terminal = true;
    });
    run.ws.on("close", () => {
      if (!run.terminal) {
        emit(run, { type: "completed" });
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

      // Handshake.
      await request(run, "initialize", {
        clientInfo: { name: "forge", title: "Forge", version: "1" },
        capabilities: { experimentalApi: true },
      });
      send(ws, "initialized");

      // New thread, then a turn carrying the user message. Codex keeps prior
      // turns in the thread itself; we pass instructions + the latest message.
      const threadRes = (await request(run, "thread/start", {})) as {
        thread?: { id?: string };
      };
      const threadId = threadRes.thread?.id;
      if (!threadId) {
        ws.close();
        throw new Error("Codex app-server: thread/start returned no thread id");
      }
      run.threadId = threadId;

      const turnInput: Array<Record<string, unknown>> = [];
      if (input.instructions) turnInput.push({ type: "text", text: input.instructions });
      turnInput.push({ type: "text", text: input.message });
      const turnRes = (await request(run, "turn/start", {
        threadId,
        input: turnInput,
      })) as { turn?: { id?: string } };
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

      if (run.usage) onEvent({ type: "usage", ...run.usage });

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
      runs.delete(externalRunId);
    },

    async getStatus(externalRunId: string): Promise<RunStatus> {
      const run = runs.get(externalRunId);
      if (!run) return { state: "completed" };
      return {
        state: run.terminal
          ? "completed"
          : run.pendingApprovalId !== null
            ? "waiting_for_approval"
            : "running",
        output: run.finalText || undefined,
        usage: run.usage,
      };
    },

    async approve(externalRunId: string, choice: string): Promise<void> {
      const run = runs.get(externalRunId);
      if (!run || run.pendingApprovalId === null) return;
      const decision =
        choice === "session" || choice === "always"
          ? "acceptForSession"
          : choice === "deny" || choice === "decline"
            ? "decline"
            : "accept";
      respond(run.ws, run.pendingApprovalId, { decision });
      run.pendingApprovalId = null;
    },

    async stop(externalRunId: string): Promise<void> {
      const run = runs.get(externalRunId);
      if (!run) return;
      try {
        if (run.pendingApprovalId !== null) {
          respond(run.ws, run.pendingApprovalId, { decision: "cancel" });
          run.pendingApprovalId = null;
        }
        if (run.turnId) {
          send(run.ws, "turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
        }
      } catch (err) {
        logger.warn({ err, externalRunId }, "codex-app-server: stop failed");
      }
    },
  };
}
