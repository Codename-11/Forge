/**
 * Shared types for the dispatch path. The daemon's chat-message and
 * AGENT_ASSIGNED loops both bundle context via `agent.context.bundle`
 * and pass the result + a list of inlined attachments down to a
 * provider adapter. Keep these shapes loose — they mirror the server
 * shapes but the daemon doesn't depend on Prisma.
 */
import type { AuthFile } from "../auth.js";

/** Subset of an Agent row, narrowed to what adapters actually consume. */
export interface DispatchAgent {
  id: string;
  profileKey: string;
  name: string;
  provider: string;
}

/** Inline-decoded attachment payload (from `attachments.getInline`). */
export interface InlineAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** base64 raw bytes (NOT a data URL — caller adds prefix if needed). */
  base64: string;
}

/** A trimmed chat message used by adapters to ground the model. */
export interface ChatMessageHistoryRow {
  id: string;
  role: "USER" | "AGENT" | "SYSTEM" | string;
  body: string;
  createdAt: string | Date;
  contextSnapshot?: unknown;
}

/** Composite issue snapshot (subset of `agent.context.bundle`'s issue branch). */
export interface IssueBundle {
  /** Whatever `issue` looks like — kept loose; we only string-format it. */
  issue: Record<string, unknown> & {
    id: string;
    number?: number;
    title?: string;
    description?: string | null;
  };
  description?: string | null;
  comments: Array<Record<string, unknown> & { id: string; body: string; createdAt: string | Date }>;
  attachments: Array<Record<string, unknown> & { id: string; mimeType: string }>;
  relations: Array<Record<string, unknown>>;
  currentRun: { id: string; status?: string } | null;
  workspace: Record<string, unknown> & { id: string; slug: string; key: string };
}

/** Context the chat dispatch path hands to a provider adapter. */
export interface ChatDispatchContext {
  auth: AuthFile;
  threadId: string;
  agent: DispatchAgent;
  /** The actual user-typed body of the inbound CHAT_MESSAGE_POSTED. */
  userMessage: string;
  /** Optional context snapshot the user attached at send time. */
  context?: ChatSendContext;
  /** Workspace slug for system-prompt context; cosmetic. */
  workspaceSlug?: string;
  /** Recent chat thread (newest-first, capped) for grounding. */
  threadHistory: ChatMessageHistoryRow[];
  /** If the user tagged an issueId in their context snapshot, the bundle for it. */
  issueContext?: IssueBundle | null;
  /** Decoded attachments (image/pdf/text) ready to inline as content blocks. */
  attachments: InlineAttachment[];
}

/** The contextSnapshot the chat composer attaches to messages. */
export interface ChatSendContext {
  route?: string;
  slug?: string;
  issueId?: string;
  selectedIds?: string[];
  pinnedRunIds?: string[];
  liveRunIds?: string[];
}

/** Context the issue-loop dispatch path hands to a provider adapter. */
export interface IssueDispatchContext {
  auth: AuthFile;
  agent: DispatchAgent;
  issueId: string;
  bundle: IssueBundle;
  attachments: InlineAttachment[];
  /** runId once the server has opened a run on this dispatch (post-comment). */
  runId?: string | null;
  workspaceSlug?: string;
}
