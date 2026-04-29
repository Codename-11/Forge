import { spawn } from "node:child_process";
import { callTool } from "../mcp.js";
import type { AuthFile } from "../auth.js";
import type {
  ChatMessageHistoryRow,
  DispatchAgent,
  InlineAttachment,
  IssueBundle,
} from "./types.js";

/**
 * Claude Code adapter — bridges Forge dispatch (chat OR issue work) to a
 * `claude` CLI subprocess and streams its reply via either:
 *   - chat draft tools (`chat.startDraft / appendDraftChunk / finalizeDraft`)
 *   - or, for the issue-loop path, `comments.create` at message boundaries.
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
 *          --append-system-prompt <ctx>
 *
 * Image content blocks (Claude API spec):
 *   { type: "image", source: { type: "base64", media_type, data } }
 * Text blocks (decoded text/plain or text/markdown):
 *   { type: "text", text: "<filename>\n\n<utf8 body>" }
 * PDFs are announced as a text block (filename + size); we don't inline
 * the bytes for v1.
 *
 * Output events we care about:
 *   {"type":"stream_event","event":{"type":"content_block_delta",
 *      "delta":{"type":"text_delta","text":"..."}}}    → forward as draft chunk
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *      → final assembled text per assistant message; we use this as the
 *      authoritative finalize body.
 *   {"type":"result", "result":"...", "total_cost_usd":...,
 *      "usage":{ "input_tokens":..., "output_tokens":...,
 *               "cache_read_input_tokens":... }}
 *      → end-of-stream marker + token/cost telemetry. Mapped to
 *      `runs.recordUsage` when a runId is in scope.
 *
 * Failures: missing binary, non-zero exit, or unparseable stream all fall
 * through to a friendly `[OFFLINE]` finalize so the chat thread never
 * shows an empty draft bubble.
 */

const CLAUDE_BIN = process.env.FORGE_CLAUDE_BIN ?? "claude";

// ---------------------------------------------------------------- shared

export interface ClaudeUsage {
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd?: number;
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
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Content block shape understood by Claude Code's stream-json input.
 * Mirrors the Claude messages API content-block spec.
 */
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

function attachmentsToBlocks(atts: InlineAttachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const a of atts) {
    if (a.mimeType.startsWith("image/")) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: a.mimeType,
          data: a.base64,
        },
      });
    } else if (
      a.mimeType === "text/plain" ||
      a.mimeType === "text/markdown"
    ) {
      let body: string;
      try {
        body = Buffer.from(a.base64, "base64").toString("utf8");
      } catch {
        body = "[failed to decode utf8]";
      }
      blocks.push({
        type: "text",
        text: `--- Attached file: ${a.filename} (${a.mimeType}, ${a.sizeBytes} bytes) ---\n${body}\n--- end ${a.filename} ---`,
      });
    } else if (a.mimeType === "application/pdf") {
      // v1: announce only. Future: pass as `document` content block.
      blocks.push({
        type: "text",
        text: `[Attached PDF: ${a.filename} (${a.sizeBytes} bytes) — not inlined in v1; ask the operator to extract relevant pages if needed.]`,
      });
    }
  }
  return blocks;
}

function summarizeIssueBundle(b: IssueBundle): string {
  const issue = b.issue as Record<string, unknown> & {
    number?: number;
    title?: string;
    priority?: string;
    statusId?: string;
    status?: { name?: string } | null;
    project?: { name?: string } | null;
  };
  const lines: string[] = [];
  const ident = `${b.workspace.key ?? ""}-${issue.number ?? "?"}`;
  lines.push(`# Issue ${ident}: ${issue.title ?? "(untitled)"}`);
  if (issue.priority) lines.push(`Priority: ${issue.priority}`);
  if (issue.status?.name) lines.push(`Status: ${issue.status.name}`);
  if (issue.project?.name) lines.push(`Project: ${issue.project.name}`);
  if (b.relations?.length) {
    lines.push(`Relations: ${b.relations.length}`);
  }
  if (b.description) {
    lines.push("\n## Description");
    lines.push(String(b.description));
  }
  if (b.comments?.length) {
    lines.push(`\n## Recent comments (${b.comments.length}, newest-first)`);
    for (const c of b.comments.slice(0, 10)) {
      const author = (c as { author?: { name?: string } }).author?.name ?? "?";
      lines.push(`- [${author}] ${String(c.body).slice(0, 400)}`);
    }
  }
  if (b.attachments?.length) {
    lines.push(
      `\nAttachments on issue: ${b.attachments.length} (image/pdf/text inlined separately)`,
    );
  }
  return lines.join("\n");
}

function summarizeThreadHistory(history: ChatMessageHistoryRow[]): string {
  if (!history.length) return "";
  const lines = ["# Thread history (newest-first, recent N)"];
  // Skip the message currently being responded to — `userMessage` carries it.
  // We render in chronological order for grounding.
  const ordered = [...history].reverse();
  for (const m of ordered) {
    const role = String(m.role).toLowerCase();
    lines.push(`[${role}] ${String(m.body).slice(0, 800)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- chat path

export interface ClaudeChatContext {
  auth: AuthFile;
  threadId: string;
  agent: DispatchAgent;
  userMessage: string;
  threadHistory: ChatMessageHistoryRow[];
  issueContext?: IssueBundle | null;
  attachments: InlineAttachment[];
  workspaceSlug?: string;
  model?: string;
}

function buildChatSystemPrompt(ctx: ClaudeChatContext): string {
  const head = [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You are replying to a chat message in your dedicated chat thread.`,
    `Reply concisely with markdown. Do not use the Bash, Read, Edit, or Write`,
    `tools — this is a chat reply path, not an issue work session. If asked`,
    `to do work that requires tools, suggest the operator open an issue and`,
    `assign it to you instead.`,
  ].join(" ");
  const parts: string[] = [head];
  if (ctx.threadHistory.length) {
    parts.push("");
    parts.push(summarizeThreadHistory(ctx.threadHistory));
  }
  if (ctx.issueContext) {
    parts.push("");
    parts.push("# Linked issue context");
    parts.push(summarizeIssueBundle(ctx.issueContext));
  }
  return parts.join("\n");
}

export async function runClaudeChat(ctx: ClaudeChatContext): Promise<void> {
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

  const userBlocks: ContentBlock[] = [
    ...attachmentsToBlocks(ctx.attachments),
    { type: "text", text: ctx.userMessage },
  ];

  await runClaudeProcess({
    systemPrompt: buildChatSystemPrompt(ctx),
    userContent: userBlocks,
    model: ctx.model,
    onTextDelta: (delta) => {
      if (!draft) return;
      draft.pendingDelta += delta;
      if (draft.flushTimer) clearTimeout(draft.flushTimer);
      draft.flushTimer = setTimeout(() => void flush(true), 120);
    },
    onComplete: async ({ assembledFinal, exitCode }) => {
      if (exitCode === 0 && assembledFinal) {
        await finalize(assembledFinal);
      } else if (exitCode === 0) {
        await finalize("[claude returned no content]");
      } else {
        await finalize(
          `[OFFLINE] Claude Code exited with code ${exitCode}. Check daemon logs for stderr.`,
        );
      }
    },
    onSpawnError: async (err) => {
      await finalize(
        `[OFFLINE] Local daemon could not spawn \`${CLAUDE_BIN}\`: ${err}`,
      );
    },
  });
}

interface DraftHandle {
  draftId: string;
  assembled: string;
  pendingDelta: string;
  flushTimer: NodeJS.Timeout | null;
  finalized: boolean;
}

// ---------------------------------------------------------------- issue path

export interface ClaudeIssueContext {
  auth: AuthFile;
  agent: DispatchAgent;
  issueId: string;
  bundle: IssueBundle;
  attachments: InlineAttachment[];
  workspaceSlug?: string;
  model?: string;
  /** runId discovered from the bundle. Used for `runs.recordUsage`. */
  runId?: string | null;
}

function buildIssueSystemPrompt(ctx: ClaudeIssueContext): string {
  const head = [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You have been assigned to investigate and execute work on an issue.`,
    `Plan first, then act. Post a starter comment summarizing your plan,`,
    `then proceed. You have full local tool access — use it judiciously.`,
    `Keep replies focused on the work; the operator reads your output as`,
    `comments on the issue.`,
  ].join(" ");
  return [head, "", summarizeIssueBundle(ctx.bundle)].join("\n");
}

export interface RunClaudeIssueResult {
  finalText: string;
  exitCode: number | null;
  usage: ClaudeUsage;
}

/**
 * Issue-loop adapter. Spawns claude with the bundle as system context,
 * streams output, and invokes `onProgress` at message boundaries (caller
 * decides whether to post comments). Returns final assembled text +
 * usage so the caller can post a summary comment + record usage.
 */
export async function runClaudeIssue(
  ctx: ClaudeIssueContext,
  onProgress: (text: string) => void,
): Promise<RunClaudeIssueResult> {
  const userBlocks: ContentBlock[] = [
    ...attachmentsToBlocks(ctx.attachments),
    {
      type: "text",
      text:
        "You've been assigned this issue. Investigate, plan, and execute. " +
        "Post a starter comment summarizing your plan, then proceed. " +
        "If you cannot complete the work, leave a clear note about what " +
        "remains and which command/path you got stuck at.",
    },
  ];

  let usage: ClaudeUsage = {};
  let finalText = "";
  let exitCode: number | null = null;

  await runClaudeProcess({
    systemPrompt: buildIssueSystemPrompt(ctx),
    userContent: userBlocks,
    model: ctx.model,
    onAssistantMessage: (text) => {
      // Each assistant message boundary — let the caller decide whether
      // to post a progress comment.
      if (text) onProgress(text);
    },
    onResult: (text, u) => {
      if (text) finalText = text;
      if (u) usage = u;
    },
    onComplete: ({ exitCode: code, assembledFinal }) => {
      exitCode = code;
      if (assembledFinal && !finalText) finalText = assembledFinal;
    },
    onSpawnError: () => {
      // Surface as a final-text marker; the caller will post it as a comment.
      finalText = `[OFFLINE] Local daemon could not spawn \`${CLAUDE_BIN}\`. Install Claude Code or set FORGE_CLAUDE_BIN.`;
    },
  });

  return { finalText, exitCode, usage };
}

// ---------------------------------------------------------------- process

interface ClaudeProcessOptions {
  systemPrompt: string;
  userContent: ContentBlock[];
  model?: string;
  onTextDelta?: (delta: string) => void;
  onAssistantMessage?: (text: string) => void;
  onResult?: (text: string, usage: ClaudeUsage) => void;
  onComplete: (info: {
    exitCode: number | null;
    assembledFinal: string;
  }) => void | Promise<void>;
  onSpawnError: (err: string) => void | Promise<void>;
}

/**
 * Core claude-cli wrapper. Spawns, pipes a single stream-json user
 * line, parses each output event, surfaces deltas / messages / results
 * via callbacks, and invokes `onComplete` when the child exits.
 */
async function runClaudeProcess(opts: ClaudeProcessOptions): Promise<void> {
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
    opts.systemPrompt,
  ];
  if (opts.model) args.push("--model", opts.model);

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    await opts.onSpawnError(err instanceof Error ? err.message : String(err));
    await opts.onComplete({ exitCode: -1, assembledFinal: "" });
    return;
  }

  let assembledFinal = "";

  child.on("error", async (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await opts.onSpawnError(
        `couldn't find \`${CLAUDE_BIN}\` on PATH. Install Claude Code or set FORGE_CLAUDE_BIN.`,
      );
      return;
    }
    await opts.onSpawnError(`spawn error: ${err.message}`);
  });

  // Send the user message as a single stream-json line, then close stdin.
  const inputLine =
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: opts.userContent,
      },
    }) + "\n";
  child.stdin.write(inputLine);
  child.stdin.end();

  let buf = "";
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
        continue;
      }
      const e = event as ClaudeStreamEvent;
      if (
        e.type === "stream_event" &&
        e.event?.type === "content_block_delta" &&
        e.event.delta?.type === "text_delta" &&
        typeof e.event.delta.text === "string"
      ) {
        opts.onTextDelta?.(e.event.delta.text);
      } else if (e.type === "assistant" && e.message?.content) {
        for (const block of e.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            assembledFinal = block.text;
            opts.onAssistantMessage?.(block.text);
          }
        }
      } else if (e.type === "result") {
        const text = typeof e.result === "string" ? e.result : "";
        if (text) assembledFinal = text;
        const usage: ClaudeUsage = {};
        if (e.usage) {
          if (typeof e.usage.input_tokens === "number")
            usage.tokensIn = e.usage.input_tokens;
          if (typeof e.usage.output_tokens === "number")
            usage.tokensOut = e.usage.output_tokens;
          if (typeof e.usage.cache_read_input_tokens === "number")
            usage.tokensCached = e.usage.cache_read_input_tokens;
        }
        if (typeof e.total_cost_usd === "number") usage.costUsd = e.total_cost_usd;
        opts.onResult?.(text, usage);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(`[claude-code stderr] ${chunk}`);
  });

  await new Promise<void>((resolve) => {
    child.on("close", async (code) => {
      await opts.onComplete({ exitCode: code, assembledFinal });
      resolve();
    });
  });
}
