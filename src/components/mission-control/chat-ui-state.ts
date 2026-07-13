import type { ChatTraceToolCall } from "./chat-work-trace";

export type ChatTurnPhase =
  | "idle"
  | "queued"
  | "delivered"
  | "accepted"
  | "read"
  | "thinking"
  | "working"
  | "running"
  | "awaiting_approval"
  | "responding"
  | "finalizing"
  | "completed"
  | "done"
  | "stalled"
  | "failed"
  | "stopped";

export type ChatTurnStatusView = {
  phase: ChatTurnPhase;
  label: string;
  detail: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
  waitingMs: number | null;
} | null;

export type ChatDiagnosticsLike = {
  dispatchState?: string | null;
  lastAgentStreamError?: string | null;
  lastAgentStreamAborted?: boolean | null;
  turnStatus?: {
    phase?: string | null;
    label?: string | null;
    detail?: string | null;
    tone?: string | null;
    waitingMs?: number | null;
  } | null;
} | null;

export type ChatStatusMeta = {
  label: string;
  tone: "green" | "ember" | "sky" | "red" | "muted";
};

/**
 * Convert server diagnostics into the compact state used by conversation
 * rows. When diagnostics exist they are authoritative: presence is only a
 * fallback for an idle thread, never a clock-based guess that a USER row is
 * still "thinking".
 */
export function chatStatusMetaFromDiagnostics(
  diagnostics: ChatDiagnosticsLike,
): ChatStatusMeta | null {
  if (!diagnostics) return null;
  const rawPhase = diagnostics.turnStatus?.phase?.toLowerCase() ?? "idle";
  const dispatchState = diagnostics.dispatchState?.toLowerCase() ?? "idle";
  const phase = rawPhase === "idle" && dispatchState !== "idle" ? dispatchState : rawPhase;

  switch (phase) {
    case "queued":
      return { label: "queued", tone: "muted" };
    case "wake-sent":
    case "delivered":
      return { label: "delivered", tone: "sky" };
    case "acknowledged":
    case "accepted":
    case "read":
      return { label: "accepted", tone: "sky" };
    case "thinking":
      return { label: "thinking", tone: "ember" };
    case "running":
    case "working":
      return { label: "working", tone: "ember" };
    case "awaiting_approval":
      return { label: "approval", tone: "ember" };
    case "responding":
      return { label: "responding", tone: "ember" };
    case "finalizing":
      return { label: "finalizing", tone: "ember" };
    case "completed":
    case "done":
      return { label: "done", tone: "green" };
    case "failed":
      return { label: "failed", tone: "red" };
    case "stalled":
      return { label: "stalled", tone: "red" };
    case "stopped":
      return { label: "stopped", tone: "muted" };
    default:
      return { label: diagnostics.turnStatus?.label?.toLowerCase() || "idle", tone: "muted" };
  }
}

export type RehydratedToolCall = ChatTraceToolCall & { requiresConfirm?: boolean };

export interface StreamedSnapshot {
  streamed: boolean;
  running: boolean;
  partialText: string;
  thinking: string;
  toolCalls: RehydratedToolCall[];
  elapsedMs: number | null;
  error: string | null;
  stopped: boolean;
  runExternalId: string | null;
  turnId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read both current and historical contextSnapshot spellings. */
export function readStreamedSnapshot(value: unknown): StreamedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const rawTools = Array.isArray(obj.tool_calls)
    ? obj.tool_calls
    : Array.isArray(obj.toolCalls)
      ? obj.toolCalls
      : Array.isArray(obj.tool_use)
        ? obj.tool_use
        : [];
  const toolCalls = rawTools
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && "id" in entry && "name" in entry),
    )
    .map((entry) => {
      const rawStatus = typeof entry.status === "string" ? entry.status : "executed";
      const status = ["pending", "approved", "declined", "executed", "error"].includes(rawStatus)
        ? (rawStatus as RehydratedToolCall["status"])
        : "executed";
      return {
        id: String(entry.id),
        name: String(entry.name),
        args:
          entry.args && typeof entry.args === "object"
            ? (entry.args as Record<string, unknown>)
            : {},
        status,
        requiresConfirm: entry.requiresConfirm === true || entry.requires_confirm === true,
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        result: entry.result,
      };
    });
  const partialText =
    typeof obj.partial_text === "string"
      ? obj.partial_text
      : typeof obj.partialText === "string"
        ? obj.partialText
        : typeof obj.body === "string"
          ? obj.body
          : "";
  const thinking = typeof obj.thinking === "string" ? obj.thinking : "";
  const error = typeof obj.error === "string" && obj.error.trim() ? obj.error : null;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const stopped =
    obj.stopped === true || obj.aborted === true || status === "stopped" || status === "cancelled";
  const running =
    obj.running === true ||
    [
      "accepted",
      "thinking",
      "working",
      "running",
      "awaiting_approval",
      "responding",
      "finalizing",
    ].includes(status);
  const streamed =
    obj.streamed === true ||
    running ||
    stopped ||
    error !== null ||
    partialText.length > 0 ||
    thinking.length > 0 ||
    toolCalls.length > 0;
  if (!streamed) return null;

  return {
    streamed,
    running,
    partialText,
    thinking,
    toolCalls,
    elapsedMs: typeof obj.elapsedMs === "number" ? obj.elapsedMs : null,
    error,
    stopped,
    runExternalId:
      typeof obj.runExternalId === "string"
        ? obj.runExternalId
        : typeof obj.run_external_id === "string"
          ? obj.run_external_id
          : null,
    turnId:
      typeof obj.turnId === "string"
        ? obj.turnId
        : typeof obj.clientTurnId === "string"
          ? obj.clientTurnId
          : null,
    startedAt: timestamp(obj.startedAt ?? obj.started_at),
    finishedAt: timestamp(obj.finishedAt ?? obj.finished_at),
  };
}

export type PersistedOutbound = {
  id: string;
  clientTurnId: string;
  body: string;
  context: Record<string, unknown>;
  createdAt: number;
  displayFiles: string[];
  status: "queued" | "failed";
  serverMessageId?: string;
  error?: string;
};

export function parsePersistedOutbox(raw: string | null): PersistedOutbound[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (
        typeof row.id !== "string" ||
        typeof row.clientTurnId !== "string" ||
        typeof row.body !== "string" ||
        typeof row.createdAt !== "number"
      ) {
        return [];
      }
      const displayFiles = Array.isArray(row.displayFiles)
        ? row.displayFiles.filter((name): name is string => typeof name === "string")
        : [];
      const hadFiles = displayFiles.length > 0;
      const status = row.status === "queued" && !hadFiles ? "queued" : "failed";
      return [
        {
          id: row.id,
          clientTurnId: row.clientTurnId,
          body: row.body,
          context:
            row.context && typeof row.context === "object"
              ? (row.context as Record<string, unknown>)
              : {},
          createdAt: row.createdAt,
          displayFiles,
          status,
          ...(typeof row.serverMessageId === "string"
            ? { serverMessageId: row.serverMessageId }
            : {}),
          ...(hadFiles
            ? { error: "Reattach files before retrying this recovered message." }
            : typeof row.error === "string"
              ? { error: row.error }
              : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function serializePersistedOutbox(rows: PersistedOutbound[]): string {
  return JSON.stringify(rows);
}
