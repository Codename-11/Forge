/**
 * Context loader. Wraps `agent.context.bundle` + `attachments.list` +
 * `attachments.getInline` into one call so the chat-dispatch and
 * issue-loop paths can share the same plumbing.
 *
 * Inline allowlist matches the server-side `attachments.getInline`
 * mime allowlist. Anything outside is skipped and reported via
 * `bundle.attachments` only.
 */
import { callTool } from "../mcp.js";
import type { AuthFile } from "../auth.js";
import type {
  ChatMessageHistoryRow,
  InlineAttachment,
  IssueBundle,
} from "./types.js";

const INLINE_ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

/** Per-attachment cap so a single huge file can't blow the prompt. */
const PER_ATTACHMENT_MAX_BYTES = 1_000_000; // 1 MB
/** Cap total inlined bytes across one dispatch. */
const TOTAL_INLINE_BUDGET_BYTES = 4_000_000; // 4 MB

interface RawAttachmentRow {
  id: string;
  mimeType: string;
  filename?: string | null;
  sizeBytes?: number | null;
}

/**
 * Decode + cap a list of attachment rows into inline payloads. Skips
 * anything outside the allowlist, anything bigger than the per-file cap,
 * or anything that would blow the total budget. Errors fetching one
 * attachment don't kill the rest — log + skip.
 */
export async function inlineAttachments(
  auth: AuthFile,
  rows: RawAttachmentRow[],
): Promise<InlineAttachment[]> {
  const out: InlineAttachment[] = [];
  let budget = TOTAL_INLINE_BUDGET_BYTES;
  for (const row of rows) {
    if (!INLINE_ALLOWED_MIME.has(row.mimeType)) continue;
    const cap = Math.min(PER_ATTACHMENT_MAX_BYTES, budget);
    if (cap < 1024) break; // not enough budget left to bother
    try {
      const res = await callTool<{
        id: string;
        mimeType: string;
        sizeBytes: number;
        filename: string;
        base64: string;
      }>(auth, "attachments.getInline", {
        attachmentId: row.id,
        maxBytes: cap,
      });
      if (res.isError || !res.data) {
        console.warn(`[context] attachments.getInline failed for ${row.id}: ${res.text}`);
        continue;
      }
      const inline: InlineAttachment = {
        id: res.data.id,
        filename: res.data.filename,
        mimeType: res.data.mimeType,
        sizeBytes: res.data.sizeBytes,
        base64: res.data.base64,
      };
      out.push(inline);
      // Approximate the byte cost of the base64 payload at 3/4 its char length.
      const decodedBytes = Math.ceil((inline.base64.length * 3) / 4);
      budget -= decodedBytes;
      if (budget <= 0) break;
    } catch (err) {
      console.warn(`[context] inlineAttachments error for ${row.id}:`, err);
    }
  }
  return out;
}

interface ThreadBundle {
  workspace: Record<string, unknown> & { id: string; slug: string; key: string };
  thread: {
    id: string;
    agentId: string;
    userId: string;
    lastMessageAt?: string | Date;
    createdAt: string | Date;
  };
  messages: ChatMessageHistoryRow[];
  agent: unknown;
  linkedIssues: Array<{ id: string; number: number; title: string }>;
}

export async function loadThreadBundle(
  auth: AuthFile,
  threadId: string,
): Promise<ThreadBundle | null> {
  const res = await callTool<ThreadBundle>(auth, "agent.context.bundle", {
    threadId,
  });
  if (res.isError || !res.data) {
    console.warn(`[context] agent.context.bundle(threadId=${threadId}) failed: ${res.text}`);
    return null;
  }
  return res.data;
}

export async function loadIssueBundle(
  auth: AuthFile,
  issueId: string,
): Promise<IssueBundle | null> {
  const res = await callTool<IssueBundle>(auth, "agent.context.bundle", {
    issueId,
  });
  if (res.isError || !res.data) {
    console.warn(`[context] agent.context.bundle(issueId=${issueId}) failed: ${res.text}`);
    return null;
  }
  return res.data;
}

/**
 * Fetch every chat-message-attached attachment across a list of recent
 * messages. Uses `attachments.list` keyed on each message id and folds
 * into one flat row list before inlining.
 */
export async function loadMessageAttachments(
  auth: AuthFile,
  messageIds: string[],
): Promise<RawAttachmentRow[]> {
  const all: RawAttachmentRow[] = [];
  for (const messageId of messageIds) {
    try {
      const res = await callTool<RawAttachmentRow[]>(auth, "attachments.list", {
        targetType: "chat-message",
        targetId: messageId,
      });
      if (!res.isError && Array.isArray(res.data)) {
        all.push(...res.data);
      }
    } catch (err) {
      console.warn(`[context] attachments.list(chat-message=${messageId}) error:`, err);
    }
  }
  return all;
}
