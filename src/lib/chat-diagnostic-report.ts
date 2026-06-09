type Dateish = Date | string | null | undefined;

type RuntimeHealthLike = {
  label?: string | null;
  tone?: string | null;
  reason?: string | null;
  lastSignal?: string | null;
};

type RuntimeLike = {
  id?: string | null;
  name?: string | null;
  kind?: string | null;
  adapterKey?: string | null;
  disabledAt?: Dateish;
  archivedAt?: Dateish;
  heartbeatAt?: Dateish;
  lastProbeAt?: Dateish;
  lastProbeAttempted?: boolean | null;
  lastProbeReachable?: boolean | null;
  lastProbeDetail?: string | null;
  health?: RuntimeHealthLike | null;
};

type AgentLike = {
  id?: string | null;
  name?: string | null;
  profileKey?: string | null;
  provider?: string | null;
  runEngine?: string | null;
  runtimeMode?: string | null;
  status?: string | null;
  lastHeartbeatAt?: Dateish;
};

type ReadinessLike = {
  ready?: boolean | null;
  mode?: string | null;
  provider?: string | null;
  transportLabel?: string | null;
  reason?: string | null;
  hint?: string | null;
};

type TurnStatusLike = {
  phase?: string | null;
  label?: string | null;
  detail?: string | null;
  tone?: string | null;
  startedAt?: Dateish;
  readAt?: Dateish;
  outputStartedAt?: Dateish;
  waitingMs?: number | null;
  runId?: string | null;
};

type LatestUserMessageLike = {
  id?: string | null;
  createdAt?: Dateish;
  acknowledgedAt?: Dateish;
  outputStartedAt?: Dateish;
  lastWakeAt?: Dateish;
  wakeAttempts?: number | null;
  lastWakeDeliveryId?: string | null;
};

type LastRunLike = {
  id?: string | null;
  status?: string | null;
  startedAt?: Dateish;
  completedAt?: Dateish;
  currentStep?: string | null;
  lastEventAt?: Dateish;
  idleMs?: number | null;
};

type LastDeliveryLike = {
  id?: string | null;
  status?: string | null;
  attempts?: number | null;
  lastError?: string | null;
  updatedAt?: Dateish;
};

type DiagnosticsLike = {
  dispatchState?: string | null;
  waitingForReply?: boolean | null;
  waitingMs?: number | null;
  latestUserMessageId?: string | null;
  latestUserMessageAt?: Dateish;
  latestAgentMessageAt?: Dateish;
  lastAgentStreamError?: string | null;
  lastAgentStreamAborted?: boolean | null;
  turnStatus?: TurnStatusLike | null;
  latestUserMessage?: LatestUserMessageLike | null;
  lastRun?: LastRunLike | null;
  lastDelivery?: LastDeliveryLike | null;
};

type LinkedIssueLike = {
  id?: string | null;
  number?: number | null;
  title?: string | null;
  status?: string | null;
};

export type ChatDiagnosticReportInput = {
  workspaceSlug: string;
  threadId: string;
  generatedAt?: Dateish;
  agent?: AgentLike | null;
  runtime?: RuntimeLike | null;
  readiness?: ReadinessLike | null;
  diagnostics?: DiagnosticsLike | null;
  linkedIssue?: LinkedIssueLike | null;
};

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return redact(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return redact(String(value));
}

function fmtDate(value: Dateish): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "-";
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(token|secret|key|authorization|signature)(["'\s:=]+)[^\s"'&},)]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
}

function section(lines: string[], title: string, rows: Array<[string, unknown]>): void {
  lines.push("", title);
  for (const [label, value] of rows) lines.push(`- ${label}: ${fmt(value)}`);
}

export function buildChatDiagnosticReport(input: ChatDiagnosticReportInput): string {
  const agent = input.agent;
  const runtime = input.runtime;
  const readiness = input.readiness;
  const diagnostics = input.diagnostics;
  const turn = diagnostics?.turnStatus;
  const user = diagnostics?.latestUserMessage;
  const run = diagnostics?.lastRun;
  const delivery = diagnostics?.lastDelivery;
  const health = runtime?.health;

  const lines: string[] = [
    "Forge chat diagnostic report",
    `Generated: ${fmtDate(input.generatedAt ?? new Date())}`,
    `Workspace: ${input.workspaceSlug}`,
    `Thread: ${input.threadId}`,
  ];

  section(lines, "Agent", [
    ["id", agent?.id],
    ["name", agent?.name],
    ["handle", agent?.profileKey ? `@${agent.profileKey}` : null],
    ["provider", readiness?.provider ?? agent?.provider],
    ["run engine", agent?.runEngine ?? "integration default"],
    ["runtime mode", agent?.runtimeMode],
    ["status", agent?.status],
    ["last heartbeat", fmtDate(agent?.lastHeartbeatAt)],
  ]);

  section(lines, "Connection", [
    ["ready", readiness?.ready],
    ["mode", readiness?.mode],
    ["transport", readiness?.transportLabel],
    ["reason", readiness?.reason],
    ["hint", readiness?.hint],
  ]);

  section(lines, "Runtime", [
    ["id", runtime?.id],
    ["name", runtime?.name],
    ["kind", runtime?.kind],
    ["adapter", runtime?.adapterKey],
    ["disabled", Boolean(runtime?.disabledAt)],
    ["archived", Boolean(runtime?.archivedAt)],
    ["heartbeat", fmtDate(runtime?.heartbeatAt)],
    ["last probe", fmtDate(runtime?.lastProbeAt)],
    ["probe attempted", runtime?.lastProbeAttempted],
    ["probe reachable", runtime?.lastProbeReachable],
    ["probe detail", runtime?.lastProbeDetail],
    ["health", health ? `${health.label ?? "-"} / ${health.tone ?? "-"}` : null],
    ["health reason", health?.reason],
    ["last signal", health?.lastSignal],
  ]);

  section(lines, "Turn", [
    ["phase", turn?.phase],
    ["label", turn?.label],
    ["tone", turn?.tone],
    ["detail", turn?.detail],
    ["dispatch state", diagnostics?.dispatchState],
    ["waiting for reply", diagnostics?.waitingForReply],
    ["waiting", fmtDuration(diagnostics?.waitingMs ?? turn?.waitingMs)],
    ["started", fmtDate(turn?.startedAt)],
    ["read", fmtDate(turn?.readAt)],
    ["output started", fmtDate(turn?.outputStartedAt)],
  ]);

  section(lines, "Latest User Message", [
    ["id", user?.id ?? diagnostics?.latestUserMessageId],
    ["created", fmtDate(user?.createdAt ?? diagnostics?.latestUserMessageAt)],
    ["acknowledged", fmtDate(user?.acknowledgedAt)],
    ["output started", fmtDate(user?.outputStartedAt)],
    ["last wake", fmtDate(user?.lastWakeAt)],
    ["wake attempts", user?.wakeAttempts],
    ["last wake delivery", user?.lastWakeDeliveryId],
  ]);

  section(lines, "Latest Agent Message", [
    ["created", fmtDate(diagnostics?.latestAgentMessageAt)],
    ["stream error", diagnostics?.lastAgentStreamError],
    ["stream aborted", diagnostics?.lastAgentStreamAborted],
  ]);

  section(lines, "Run", [
    ["id", run?.id ?? turn?.runId],
    ["status", run?.status],
    ["current step", run?.currentStep],
    ["started", fmtDate(run?.startedAt)],
    ["completed", fmtDate(run?.completedAt)],
    ["last event", fmtDate(run?.lastEventAt)],
    ["idle", fmtDuration(run?.idleMs)],
  ]);

  section(lines, "Delivery", [
    ["id", delivery?.id],
    ["status", delivery?.status],
    ["attempts", delivery?.attempts],
    ["updated", fmtDate(delivery?.updatedAt)],
    ["last error", delivery?.lastError],
  ]);

  section(lines, "Linked Work", [
    ["id", input.linkedIssue?.id],
    ["number", input.linkedIssue?.number],
    ["status", input.linkedIssue?.status],
    ["title", input.linkedIssue?.title],
  ]);

  return lines.join("\n").trimEnd();
}
