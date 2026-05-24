import { spawn } from "node:child_process";
import type { AuthFile } from "../auth.js";
import type {
  ChatMessageHistoryRow,
  DispatchAgent,
  InlineAttachment,
  IssueBundle,
} from "./types.js";
import {
  attachmentsToTextBlock,
  finalizeDraft,
  openDraft,
  pushDelta,
  summarizeIssueBundle,
  summarizeThreadHistory,
} from "./shared.js";

/**
 * ACP (Agent Client Protocol) adapter — the **portable, multi-vendor**
 * transport for driving a local agent CLI (Claude Code, Codex, OpenCode, …)
 * as a live agent session, instead of each vendor's bespoke `--print` /
 * `exec --json` flags. ACP is JSON-RPC 2.0 over the agent's stdio.
 *
 * This is daemon-mediated by design: ACP sessions are stdio processes, which
 * the web server can't host per chat turn — the `forge daemon` spawns the
 * agent and bridges its `session/update` stream onto Forge's chat draft tools
 * (`chat.startDraft / appendDraftChunk / finalizeDraft`), exactly like the
 * Claude/Codex adapters.
 *
 * **Flexibility:** any ACP-capable agent works. Point the daemon at one with
 *   FORGE_ACP_CMD="<command> [args…]"      e.g. "claude-code-acp" or
 *                                          "codex acp" or "opencode acp"
 * When set, the daemon prefers ACP for chat dispatch (see dispatch/index.ts).
 * Unset → the per-vendor adapters are used. So ACP is opt-in and additive.
 *
 * Protocol (https://agentclientprotocol.com), line-delimited JSON-RPC 2.0:
 *   → initialize {protocolVersion, clientCapabilities}
 *   → session/new {cwd, mcpServers:[]}                → {sessionId}
 *   → session/prompt {sessionId, prompt:[ContentBlock]} → {stopReason}
 *   ← session/update {sessionId, update:{type, …}}   (notifications)
 *       type=agent_message_chunk {content:{type:"text",text}}  → draft delta
 *       type=agent_thought_chunk                                → ignored (chat)
 *   ← session/request_permission {options:[…]}        (request; we auto-select)
 *
 * Failures (missing binary, bad handshake, non-text reply) finalize a
 * friendly "[OFFLINE]" bubble so the thread never hangs on an empty draft.
 */

const ACP_PROTOCOL_VERSION = 1;

/** The configured ACP command, or null when ACP isn't enabled. */
export function acpCommand(): string[] | null {
  const raw = process.env.FORGE_ACP_CMD?.trim();
  if (!raw) return null;
  // Naive argv split — sufficient for "bin arg1 arg2"; quote-aware splitting
  // isn't needed for the documented commands.
  return raw.split(/\s+/);
}

export function acpEnabled(): boolean {
  return acpCommand() !== null;
}

// ---------------------------------------------------------------- mapping

/**
 * Pure map from an ACP `session/update` payload to the chat-relevant text we
 * stream as a draft delta. Returns null for updates we don't surface in chat
 * (thoughts, tool calls, plans). Extracted for clarity + future testing.
 */
export function mapAcpUpdate(update: Record<string, unknown>): { delta: string } | null {
  const type = typeof update.type === "string" ? update.type : "";
  if (type !== "agent_message_chunk") return null;
  const content = update.content as { type?: string; text?: string } | undefined;
  if (content && content.type === "text" && typeof content.text === "string" && content.text) {
    return { delta: content.text };
  }
  return null;
}

// ---------------------------------------------------------------- chat

export interface AcpChatContext {
  auth: AuthFile;
  threadId: string;
  agent: DispatchAgent;
  userMessage: string;
  threadHistory: ChatMessageHistoryRow[];
  issueContext?: IssueBundle | null;
  attachments: InlineAttachment[];
  workspaceSlug?: string;
}

function buildChatPrompt(ctx: AcpChatContext): string {
  const head = [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You are replying to a chat message in your dedicated chat thread.`,
    `Reply concisely with markdown. This is a chat reply path — avoid running`,
    `shell commands or editing files; if the request needs real work, suggest`,
    `the operator open an issue and assign it to you.`,
  ].join(" ");
  const parts: string[] = [head];
  if (ctx.threadHistory.length) {
    parts.push("", summarizeThreadHistory(ctx.threadHistory));
  }
  if (ctx.issueContext) {
    parts.push("", "# Linked issue context", summarizeIssueBundle(ctx.issueContext));
  }
  if (ctx.attachments.length) {
    const block = attachmentsToTextBlock(ctx.attachments);
    if (block) parts.push("", block);
  }
  parts.push("", "# Operator message", ctx.userMessage);
  return parts.join("\n");
}

export async function runAcpChat(ctx: AcpChatContext): Promise<void> {
  const cmd = acpCommand();
  const draft = await openDraft(ctx.auth, ctx.threadId);
  if (!draft) return;
  if (!cmd) {
    await finalizeDraft(
      ctx.auth,
      ctx.threadId,
      draft,
      "[OFFLINE] ACP transport requested but FORGE_ACP_CMD is not set.",
    );
    return;
  }

  let assembled = "";
  await runAcpProcess({
    cmd,
    prompt: buildChatPrompt(ctx),
    onDelta: (delta) => {
      assembled += delta;
      pushDelta(ctx.auth, ctx.threadId, draft, delta);
    },
    onComplete: async ({ exitOk, stopReason }) => {
      if (assembled) {
        await finalizeDraft(ctx.auth, ctx.threadId, draft, assembled);
      } else if (exitOk) {
        await finalizeDraft(
          ctx.auth,
          ctx.threadId,
          draft,
          `[ACP agent returned no message${stopReason ? ` (stop: ${stopReason})` : ""}]`,
        );
      } else {
        await finalizeDraft(
          ctx.auth,
          ctx.threadId,
          draft,
          "[OFFLINE] ACP session ended abnormally. Check daemon logs for stderr.",
        );
      }
    },
    onSpawnError: async (err) => {
      await finalizeDraft(
        ctx.auth,
        ctx.threadId,
        draft,
        `[OFFLINE] Local daemon could not start ACP agent \`${cmd.join(" ")}\`: ${err}`,
      );
    },
  });
}

// ---------------------------------------------------------------- process

interface AcpProcessOptions {
  cmd: string[];
  prompt: string;
  onDelta: (delta: string) => void;
  onComplete: (info: { exitOk: boolean; stopReason: string | null }) => void | Promise<void>;
  onSpawnError: (err: string) => void | Promise<void>;
}

/**
 * Drive one ACP chat turn: spawn the agent, perform the handshake, send the
 * prompt, stream `session/update` deltas, and resolve when `session/prompt`
 * returns its stopReason (or the process exits).
 */
async function runAcpProcess(opts: AcpProcessOptions): Promise<void> {
  const [bin, ...args] = opts.cmd;
  let child;
  try {
    child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    await opts.onSpawnError(err instanceof Error ? err.message : String(err));
    await opts.onComplete({ exitOk: false, stopReason: null });
    return;
  }

  let nextId = 1;
  const pending = new Map<number, (result: unknown, error: unknown) => void>();
  let spawnFailed = false;
  let stopReason: string | null = null;

  const write = (msg: Record<string, unknown>) => {
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    } catch {
      /* pipe closed */
    }
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, (result, error) => (error ? reject(error) : resolve(result)));
      write({ id, method, params });
    });
  };
  const respond = (id: number | string, result: unknown) => write({ id, result });

  child.on("error", async (err: NodeJS.ErrnoException) => {
    spawnFailed = true;
    await opts.onSpawnError(
      err.code === "ENOENT"
        ? `couldn't find \`${bin}\` on PATH. Install an ACP agent or fix FORGE_ACP_CMD.`
        : err.message,
    );
  });

  // Incoming line pump.
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg.id as number | string | undefined;
      const method = typeof msg.method === "string" ? msg.method : undefined;

      // Response to one of our requests.
      if (id !== undefined && method === undefined) {
        const cb = pending.get(id as number);
        if (cb) {
          pending.delete(id as number);
          cb(msg.result, msg.error);
        }
        continue;
      }
      if (!method) continue;
      const params = (msg.params ?? {}) as Record<string, unknown>;

      // Agent→client request: we must reply.
      if (id !== undefined) {
        if (method === "session/request_permission") {
          // Chat replies shouldn't block on approvals — auto-select an
          // "allow" option when offered, else the first option.
          const options = Array.isArray(params.options)
            ? (params.options as Array<{ optionId?: string; kind?: string }>)
            : [];
          const allow =
            options.find((o) => (o.kind ?? "").includes("allow")) ?? options[0];
          respond(id, allow?.optionId
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } });
        } else {
          // fs/* and any other client-capability request we don't implement.
          respond(id, {});
        }
        continue;
      }

      // Notification.
      if (method === "session/update") {
        const update = (params.update ?? {}) as Record<string, unknown>;
        const mapped = mapAcpUpdate(update);
        if (mapped) opts.onDelta(mapped.delta);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => process.stderr.write(`[acp stderr] ${chunk}`));

  // Handshake → new session → prompt. Any failure resolves to onComplete so
  // the draft is always finalized.
  try {
    await request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "forge-daemon", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = (await request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    })) as { sessionId?: string };
    const sessionId = session.sessionId;
    if (!sessionId) throw new Error("session/new returned no sessionId");
    const promptRes = (await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    })) as { stopReason?: string };
    stopReason = promptRes.stopReason ?? null;
  } catch (err) {
    if (!spawnFailed) {
      console.error("[acp] session error:", err);
    }
  } finally {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = async (exitOk: boolean) => {
      if (settled) return;
      settled = true;
      if (!spawnFailed) await opts.onComplete({ exitOk, stopReason });
      resolve();
    };
    child.on("close", (code) => void done(code === 0 || stopReason !== null));
    // Safety: if the process lingers after the prompt resolved, don't hang.
    if (stopReason !== null) setTimeout(() => void done(true), 500);
  });
}
