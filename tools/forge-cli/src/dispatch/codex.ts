import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type DraftStream,
  type ProviderUsage,
} from "./shared.js";

/**
 * Codex adapter — bridges Forge dispatch (chat OR issue work) to a
 * `codex exec --json` subprocess and streams the reply through the same
 * chat.startDraft → appendDraftChunk → finalizeDraft pattern Claude uses.
 *
 * Flag shape (verified against `codex exec --help`, codex-cli 0.131.0):
 *
 *   codex exec
 *     --json                          // emit JSONL events on stdout
 *     --skip-git-repo-check           // we may not be in a repo
 *     --ephemeral                     // don't persist sessions to disk
 *     --dangerously-bypass-approvals-and-sandbox
 *                                     // chat replies must not block on
 *                                     //   permission prompts
 *     -i <file>... (per image attachment, written to a tempdir)
 *     -m <model> (optional)
 *     -                               // read prompt from stdin
 *
 * JSONL event shapes we care about (verified empirically 2026-05-20):
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{
 *      "id":"item_N","type":"agent_message","text":"<full message>"}}
 *      → forward as draft chunk (Codex doesn't expose token-level deltas).
 *   {"type":"item.completed","item":{"type":"reasoning"|"tool_call"|...}}
 *      → ignore for chat output (we don't surface reasoning traces).
 *   {"type":"turn.completed","usage":{
 *      "input_tokens":N,"cached_input_tokens":N,
 *      "output_tokens":N,"reasoning_output_tokens":N}}
 *      → finalize draft + record usage.
 *
 * Failures (missing binary, non-zero exit, unparseable JSONL) fall through
 * to a friendly "[OFFLINE]" finalize so the chat thread never sits with an
 * empty draft bubble.
 */

const CODEX_BIN = process.env.FORGE_CODEX_BIN ?? "codex";

// ---------------------------------------------------------------- types

interface CodexStreamEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ---------------------------------------------------------------- chat

export interface CodexChatContext {
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

function buildChatPrompt(ctx: CodexChatContext): string {
  const head = [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You are replying to a chat message in your dedicated chat thread.`,
    `Reply concisely with markdown. Do not run shell commands or edit files —`,
    `this is a chat reply path, not an issue work session. If asked to do`,
    `work that requires tools, suggest the operator open an issue and assign`,
    `it to you instead.`,
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
  if (ctx.attachments.length) {
    const block = attachmentsToTextBlock(ctx.attachments);
    if (block) {
      parts.push("");
      parts.push(block);
    }
  }
  parts.push("");
  parts.push("# Operator message");
  parts.push(ctx.userMessage);
  return parts.join("\n");
}

export async function runCodexChat(ctx: CodexChatContext): Promise<void> {
  const draft = await openDraft(ctx.auth, ctx.threadId);
  if (!draft) return;

  await runCodexProcess({
    prompt: buildChatPrompt(ctx),
    imageAttachments: ctx.attachments.filter((a) =>
      a.mimeType.startsWith("image/"),
    ),
    model: ctx.model,
    onAgentMessage: (text) => {
      // Codex emits whole messages; treat each as a chunk so the operator
      // sees text arrive as soon as the model finishes a step.
      pushDelta(ctx.auth, ctx.threadId, draft, text);
    },
    onComplete: async ({ assembledFinal, exitCode }) => {
      if (exitCode === 0 && assembledFinal) {
        await finalizeDraft(ctx.auth, ctx.threadId, draft, assembledFinal);
      } else if (exitCode === 0) {
        await finalizeDraft(
          ctx.auth,
          ctx.threadId,
          draft,
          "[codex returned no content]",
        );
      } else {
        await finalizeDraft(
          ctx.auth,
          ctx.threadId,
          draft,
          `[OFFLINE] Codex exited with code ${exitCode}. Check daemon logs for stderr.`,
        );
      }
    },
    onSpawnError: async (err) => {
      await finalizeDraft(
        ctx.auth,
        ctx.threadId,
        draft,
        `[OFFLINE] Local daemon could not spawn \`${CODEX_BIN}\`: ${err}`,
      );
    },
  });
}

// ---------------------------------------------------------------- issue

export interface CodexIssueContext {
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

function buildIssuePrompt(ctx: CodexIssueContext): string {
  const head = [
    `You are ${ctx.agent.name}, an agent in Forge (workspace: ${ctx.workspaceSlug ?? "unknown"}).`,
    `You have been assigned to investigate and execute work on an issue.`,
    `Plan first, then act. Post a starter comment summarizing your plan,`,
    `then proceed. You have full local tool access — use it judiciously.`,
    `Keep messages focused on the work; the operator reads your output as`,
    `comments on the issue.`,
  ].join(" ");
  const parts: string[] = [head, "", summarizeIssueBundle(ctx.bundle)];
  if (ctx.attachments.length) {
    const block = attachmentsToTextBlock(ctx.attachments);
    if (block) {
      parts.push("");
      parts.push(block);
    }
  }
  parts.push("");
  parts.push(
    "You've been assigned this issue. Investigate, plan, and execute. " +
      "Post a starter message summarizing your plan, then proceed. " +
      "If you cannot complete the work, leave a clear note about what " +
      "remains and which command/path you got stuck at.",
  );
  return parts.join("\n");
}

export interface RunCodexIssueResult {
  finalText: string;
  exitCode: number | null;
  usage: ProviderUsage;
}

/**
 * Issue-loop adapter. Spawns codex exec with the bundle as system context,
 * streams output, and invokes `onProgress` at each agent_message boundary.
 * Returns final assembled text + usage so the caller can post a summary
 * comment + record usage.
 */
export async function runCodexIssue(
  ctx: CodexIssueContext,
  onProgress: (text: string) => void,
): Promise<RunCodexIssueResult> {
  let usage: ProviderUsage = {};
  let finalText = "";
  let exitCode: number | null = null;

  await runCodexProcess({
    prompt: buildIssuePrompt(ctx),
    imageAttachments: ctx.attachments.filter((a) =>
      a.mimeType.startsWith("image/"),
    ),
    model: ctx.model,
    onAgentMessage: (text) => {
      if (text) {
        finalText = text;
        onProgress(text);
      }
    },
    onUsage: (u) => {
      usage = u;
    },
    onComplete: ({ exitCode: code, assembledFinal }) => {
      exitCode = code;
      if (assembledFinal && !finalText) finalText = assembledFinal;
    },
    onSpawnError: () => {
      finalText = `[OFFLINE] Local daemon could not spawn \`${CODEX_BIN}\`. Install Codex (\`npm i -g @openai/codex\`) or set FORGE_CODEX_BIN.`;
    },
  });

  return { finalText, exitCode, usage };
}

// ---------------------------------------------------------------- process

interface CodexProcessOptions {
  prompt: string;
  imageAttachments: InlineAttachment[];
  model?: string;
  onAgentMessage?: (text: string) => void;
  onUsage?: (usage: ProviderUsage) => void;
  onComplete: (info: {
    exitCode: number | null;
    assembledFinal: string;
  }) => void | Promise<void>;
  onSpawnError: (err: string) => void | Promise<void>;
}

/**
 * Core codex-cli wrapper. Writes any image attachments to a tempdir,
 * spawns codex with --json, parses each JSONL event, surfaces agent
 * messages / usage via callbacks, and invokes onComplete on exit.
 *
 * The tempdir is best-effort cleaned up on exit; if the daemon dies
 * mid-stream the OS will reap it on next `/tmp` sweep.
 */
async function runCodexProcess(opts: CodexProcessOptions): Promise<void> {
  // Write images to a tempdir so codex's -i FILE flag can pick them up.
  let tempDir: string | null = null;
  const imageFiles: string[] = [];
  if (opts.imageAttachments.length) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-codex-"));
    for (const a of opts.imageAttachments) {
      const safeName = a.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(tempDir, safeName);
      try {
        await fs.writeFile(filePath, Buffer.from(a.base64, "base64"));
        imageFiles.push(filePath);
      } catch (err) {
        console.warn(`[codex] failed to write image attachment:`, err);
      }
    }
  }

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  for (const f of imageFiles) {
    args.push("-i", f);
  }
  if (opts.model) args.push("-m", opts.model);
  // `-` tells codex to read the prompt from stdin instead of argv. Lets
  // us pipe in arbitrarily large prompts without hitting an argv limit.
  args.push("-");

  let child;
  try {
    child = spawn(CODEX_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    await opts.onSpawnError(err instanceof Error ? err.message : String(err));
    await opts.onComplete({ exitCode: -1, assembledFinal: "" });
    await cleanupTempDir(tempDir);
    return;
  }

  let assembledFinal = "";

  child.on("error", async (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await opts.onSpawnError(
        `couldn't find \`${CODEX_BIN}\` on PATH. Install Codex CLI or set FORGE_CODEX_BIN.`,
      );
      return;
    }
    await opts.onSpawnError(`spawn error: ${err.message}`);
  });

  child.stdin.write(opts.prompt);
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
      const e = event as CodexStreamEvent;
      if (
        e.type === "item.completed" &&
        e.item?.type === "agent_message" &&
        typeof e.item.text === "string" &&
        e.item.text.length > 0
      ) {
        assembledFinal = e.item.text;
        opts.onAgentMessage?.(e.item.text);
      } else if (e.type === "turn.completed") {
        const usage: ProviderUsage = {};
        if (e.usage) {
          if (typeof e.usage.input_tokens === "number")
            usage.tokensIn = e.usage.input_tokens;
          if (typeof e.usage.output_tokens === "number") {
            // Roll reasoning tokens into output for cost accounting; Codex
            // bills them as output even though they're hidden.
            usage.tokensOut =
              e.usage.output_tokens +
              (typeof e.usage.reasoning_output_tokens === "number"
                ? e.usage.reasoning_output_tokens
                : 0);
          }
          if (typeof e.usage.cached_input_tokens === "number")
            usage.tokensCached = e.usage.cached_input_tokens;
        }
        opts.onUsage?.(usage);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(`[codex stderr] ${chunk}`);
  });

  await new Promise<void>((resolve) => {
    child.on("close", async (code) => {
      await opts.onComplete({ exitCode: code, assembledFinal });
      await cleanupTempDir(tempDir);
      resolve();
    });
  });
}

async function cleanupTempDir(dir: string | null): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; OS will sweep eventually.
  }
}
