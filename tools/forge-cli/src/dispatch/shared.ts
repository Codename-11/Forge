/**
 * Shared utilities for provider adapters (claude-code, codex, …).
 *
 * Anything that's not provider-specific lives here: chat draft lifecycle
 * helpers, issue / thread summarisers used in system prompts, and the
 * inline-attachment → text-block fallback that both adapters share when a
 * provider can't accept images/PDFs natively.
 */
import { callTool } from "../mcp.js";
import type { AuthFile } from "../auth.js";
import type {
  ChatMessageHistoryRow,
  InlineAttachment,
  IssueBundle,
} from "./types.js";

// ---------------------------------------------------------------- prompts

export function summarizeIssueBundle(b: IssueBundle): string {
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
      `\nAttachments on issue: ${b.attachments.length} (image/pdf/text inlined separately when supported by the provider)`,
    );
  }
  return lines.join("\n");
}

export function summarizeThreadHistory(
  history: ChatMessageHistoryRow[],
): string {
  if (!history.length) return "";
  const lines = ["# Thread history (chronological, recent N)"];
  const ordered = [...history].reverse();
  for (const m of ordered) {
    const role = String(m.role).toLowerCase();
    lines.push(`[${role}] ${String(m.body).slice(0, 800)}`);
  }
  return lines.join("\n");
}

/**
 * Render an attachment list as plain text — used by providers that don't
 * accept structured image/document content blocks directly. Images get a
 * marker line + filename; text/markdown bodies get inlined; PDFs get
 * announced only.
 */
export function attachmentsToTextBlock(atts: InlineAttachment[]): string {
  if (!atts.length) return "";
  const lines: string[] = ["## Attached files (inlined where possible)"];
  for (const a of atts) {
    if (a.mimeType.startsWith("image/")) {
      lines.push(
        `- Image: ${a.filename} (${a.mimeType}, ${a.sizeBytes} bytes) — passed to the provider as an image input.`,
      );
    } else if (a.mimeType === "text/plain" || a.mimeType === "text/markdown") {
      let body: string;
      try {
        body = Buffer.from(a.base64, "base64").toString("utf8");
      } catch {
        body = "[failed to decode utf8]";
      }
      lines.push("");
      lines.push(`--- ${a.filename} (${a.mimeType}, ${a.sizeBytes} bytes) ---`);
      lines.push(body);
      lines.push(`--- end ${a.filename} ---`);
    } else if (a.mimeType === "application/pdf") {
      lines.push(
        `- PDF: ${a.filename} (${a.sizeBytes} bytes) — not inlined; ask the operator to extract relevant pages if needed.`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- drafts

/**
 * Outbound chat-draft stream state. One `DraftStream` per
 * (thread, provider invocation). The adapter pushes deltas as the
 * provider emits text and calls `finalizeDraft` at the end.
 *
 * The `pendingDelta` + `flushTimer` give us cheap batching: small
 * sub-60-char deltas debounce for ~120ms so we don't hammer the MCP
 * endpoint with one call per token.
 */
export interface DraftStream {
  draftId: string;
  pendingDelta: string;
  flushTimer: NodeJS.Timeout | null;
  finalized: boolean;
}

export async function openDraft(
  auth: AuthFile,
  threadId: string,
): Promise<DraftStream | null> {
  try {
    const res = await callTool<{ draftId: string; threadId: string }>(
      auth,
      "chat.startDraft",
      { threadId },
    );
    if (res.isError || !res.data?.draftId) {
      console.error(`[dispatch] chat.startDraft failed: ${res.text}`);
      return null;
    }
    return {
      draftId: res.data.draftId,
      pendingDelta: "",
      flushTimer: null,
      finalized: false,
    };
  } catch (err) {
    console.error(`[dispatch] chat.startDraft threw:`, err);
    return null;
  }
}

/**
 * Push a text delta. Batches small fragments and flushes large or
 * debounced batches via `chat.appendDraftChunk`.
 */
export function pushDelta(
  auth: AuthFile,
  threadId: string,
  draft: DraftStream,
  delta: string,
  debounceMs = 120,
): void {
  if (!delta) return;
  if (draft.finalized) return;
  draft.pendingDelta += delta;
  if (draft.flushTimer) clearTimeout(draft.flushTimer);
  draft.flushTimer = setTimeout(() => void flushDraft(auth, threadId, draft, true), debounceMs);
  // Forceful early flush when the buffer is already big enough.
  if (draft.pendingDelta.length >= 240) {
    void flushDraft(auth, threadId, draft, true);
  }
}

export async function flushDraft(
  auth: AuthFile,
  threadId: string,
  draft: DraftStream,
  force = false,
): Promise<void> {
  if (draft.finalized) return;
  if (!draft.pendingDelta) return;
  if (!force && draft.pendingDelta.length < 60) return;
  const delta = draft.pendingDelta;
  draft.pendingDelta = "";
  if (draft.flushTimer) {
    clearTimeout(draft.flushTimer);
    draft.flushTimer = null;
  }
  try {
    await callTool(auth, "chat.appendDraftChunk", {
      threadId,
      draftId: draft.draftId,
      delta,
    });
  } catch (err) {
    console.error(`[dispatch] chat.appendDraftChunk failed:`, err);
  }
}

export async function finalizeDraft(
  auth: AuthFile,
  threadId: string,
  draft: DraftStream,
  body: string,
): Promise<void> {
  if (draft.finalized) return;
  draft.finalized = true;
  if (draft.flushTimer) {
    clearTimeout(draft.flushTimer);
    draft.flushTimer = null;
  }
  // Push any tail before finalising — but the final body is authoritative
  // so we don't need to wait for the tail flush to settle on the server.
  if (draft.pendingDelta) {
    const delta = draft.pendingDelta;
    draft.pendingDelta = "";
    try {
      await callTool(auth, "chat.appendDraftChunk", {
        threadId,
        draftId: draft.draftId,
        delta,
      });
    } catch {
      // ignore — finalize will replace anyway
    }
  }
  try {
    await callTool(auth, "chat.finalizeDraft", {
      threadId,
      draftId: draft.draftId,
      body: body || "[no reply]",
    });
  } catch (err) {
    console.error(`[dispatch] chat.finalizeDraft failed:`, err);
  }
}

// ---------------------------------------------------------------- usage

/**
 * Token + cost telemetry shape shared across providers. Each provider's
 * stream parser maps its own counts onto these field names; the daemon
 * then forwards them to `runs.recordUsage`.
 */
export interface ProviderUsage {
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd?: number;
}
