import { spawn } from "node:child_process";
import { callTool } from "../mcp.js";
import type { AuthFile } from "../auth.js";

/**
 * Claude Code adapter — bridges a Forge chat USER message to a `claude`
 * CLI subprocess and streams its reply back via the chat draft tools.
 *
 * Flag shape (verified against `claude --help`, claude-code v2.1.121 on
 * 2026-04-28):
 *
 *   claude --print                          // non-interactive
 *          --input-format stream-json       // expect one JSON object per
 *                                           //   stdin line (type=user,...)
 *          --output-format stream-json      // emit JSON-per-line on stdout
 *          --include-partial-messages       // emit content_block_delta
 *                                           //   events as the tokens stream
 *          --verbose                        // required by --output-format
 *                                           //   stream-json with --print
 *          --permission-mode bypassPermissions
 *                                           // chat replies must not block
 *                                           //   on permission prompts
 *          --model <model-or-alias>         // optional override; we let
 *                                           //   the user's claude config
 *                                           //   pick by default
 *
 * Output events we care about:
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"..."}}}    → forward as draft chunk
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *      → final assembled text per assistant message; we use this as the
 *      authoritative finalize body.
 *   {"type":"result", "result":"...", "total_cost_usd":..., "usage":{...}}
 *      → end-of-stream marker + token/cost telemetry. We could relay these
 *      via runs.recordUsage when sourceRunId is wired (deferred to v2).
 *
 * Failures: missing binary, non-zero exit, or unparseable stream all fall
 * through to a friendly `[OFFLINE]` finalize so the chat thread never
 * shows an empty draft bubble.
 */

const CLAUDE_BIN = process.env.FORGE_CLAUDE_BIN ?? "claude";

export interface ClaudeContext {
  auth: AuthFile;
  threadId: string;
  agent: { id: string; profileKey: string; name: string };
  userMessage: string;
  /** Workspace slug for system-prompt context; cosmetic. */
  workspaceSlug?: string;
  /** Inject a `--model` override; otherwise use claude's default. */
  model?: string;
}

interface DraftHandle {
  draftId: string;
  assembled: string;
  pendingDelta: string;
  flushTimer: NodeJS.Timeout | null;
  finalized: boolean;
}

function buildSystemPrompt(ctx: ClaudeContext): string {
  return [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You are replying to a chat message in your dedicated chat thread.`,
    `Reply concisely with markdown. Do not use the Bash, Read, Edit, or Write`,
    `tools — this is a chat reply path, not an issue work session. If asked`,
    `to do work that requires tools, suggest the operator open an issue and`,
    `assign it to you instead.`,
  ].join(" ");
}

export async function runClaudeChat(ctx: ClaudeContext): Promise<void> {
  // Open the draft FIRST — that way even if claude crashes immediately
  // we already own a draftId and can finalize a graceful fallback.
  let draft: DraftHandle | null = null;
  try {
    const res = await callTool<{ draftId: string; threadId: string }>(
      ctx.auth,
      "chat.startDraft",
      { threadId: ctx.threadId },
    );
    if (res.isError || !res.data?.draftId) {
      console.error(`[claude-code] chat.startDraft failed: ${res.text}`);
      return;
    }
    draft = {
      draftId: res.data.draftId,
      assembled: "",
      pendingDelta: "",
      flushTimer: null,
      finalized: false,
    };
  } catch (err) {
    console.error(`[claude-code] failed to start draft:`, err);
    return;
  }

  const flush = async (force = false) => {
    if (!draft) return;
    if (!draft.pendingDelta) return;
    if (!force && draft.pendingDelta.length < 60) return; // batch a bit
    const delta = draft.pendingDelta;
    draft.pendingDelta = "";
    try {
      await callTool(ctx.auth, "chat.appendDraftChunk", {
        threadId: ctx.threadId,
        draftId: draft.draftId,
        delta,
      });
    } catch (err) {
      console.error(`[claude-code] appendDraftChunk failed:`, err);
    }
  };

  const finalize = async (body: string) => {
    if (!draft || draft.finalized) return;
    draft.finalized = true;
    if (draft.flushTimer) clearTimeout(draft.flushTimer);
    // Make sure any tail bytes are visible before the persisted message
    // arrives, even if the body we're persisting already includes them.
    await flush(true);
    try {
      await callTool(ctx.auth, "chat.finalizeDraft", {
        threadId: ctx.threadId,
        draftId: draft.draftId,
        body: body || "[no reply]",
      });
    } catch (err) {
      console.error(`[claude-code] finalizeDraft failed:`, err);
    }
  };

  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    buildSystemPrompt(ctx),
  ];
  if (ctx.model) args.push("--model", ctx.model);

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    await finalize(
      `[OFFLINE] Local daemon could not spawn \`${CLAUDE_BIN}\`: ${err instanceof Error ? err.message : String(err)}.\n\nInstall the Claude Code CLI on the runtime host or assign this thread to a different agent.`,
    );
    return;
  }

  child.on("error", async (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await finalize(
        `[OFFLINE] Local daemon couldn't find the \`${CLAUDE_BIN}\` binary on PATH. Install Claude Code or set FORGE_CLAUDE_BIN.`,
      );
      return;
    }
    await finalize(`[OFFLINE] Claude Code spawn error: ${err.message}`);
  });

  // Send the user message as a single stream-json line, then close stdin.
  const inputLine =
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: ctx.userMessage }],
      },
    }) + "\n";
  child.stdin.write(inputLine);
  child.stdin.end();

  // Buffer for line-delimited JSON parsing.
  let buf = "";
  let assembledFinal = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // claude can occasionally print non-JSON banners; ignore.
        continue;
      }
      const e = event as ClaudeStreamEvent;
      if (
        e.type === "stream_event" &&
        e.event?.type === "content_block_delta" &&
        e.event.delta?.type === "text_delta" &&
        typeof e.event.delta.text === "string"
      ) {
        const delta = e.event.delta.text;
        if (draft) {
          draft.pendingDelta += delta;
          // Schedule a debounced flush — chat.appendDraftChunk has a 60–
          // 200ms cadence guideline.
          if (draft.flushTimer) clearTimeout(draft.flushTimer);
          draft.flushTimer = setTimeout(() => void flush(true), 120);
        }
      } else if (e.type === "assistant" && e.message?.content) {
        // Capture final assembled text from each assistant message
        // (skip thinking blocks — they're internal).
        for (const block of e.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            assembledFinal = block.text;
          }
        }
      } else if (e.type === "result" && typeof e.result === "string") {
        // Result event has the canonical final string.
        assembledFinal = e.result;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(`[claude-code stderr] ${chunk}`);
  });

  await new Promise<void>((resolve) => {
    child.on("close", async (code) => {
      if (code === 0 && assembledFinal) {
        await finalize(assembledFinal);
      } else if (code === 0) {
        // Stream produced no assistant text (rare).
        await finalize("[claude returned no content]");
      } else {
        await finalize(
          `[OFFLINE] Claude Code exited with code ${code}. Check daemon logs for stderr.`,
        );
      }
      resolve();
    });
  });
}

interface ClaudeStreamEvent {
  type: string;
  event?: {
    type: string;
    delta?: { type: string; text?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  result?: string;
}
