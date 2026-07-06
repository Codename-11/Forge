import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import EventSource from "eventsource";
import chalk from "chalk";
import { configDir, requireAuth, type AuthFile } from "./auth.js";
import { callTool, type AgentMe } from "./mcp.js";
import { dispatchChat, type AgentProviderId } from "./dispatch/index.js";
import {
  inlineAttachments,
  loadIssueBundle,
  loadMessageAttachments,
  loadThreadBundle,
} from "./dispatch/context.js";
import {
  handleAgentAssigned,
  type AgentAssignedEvent,
  type AgentAssignedPayload,
} from "./dispatch/issue-loop.js";
import type {
  ChatMessageHistoryRow,
  IssueBundle,
} from "./dispatch/types.js";

/**
 * Local daemon. Detects available agent CLIs, registers a Runtime in
 * Forge, opens an SSE subscription on `/api/plugins/events` (the
 * API-key-authed realtime stream — `/api/realtime` is session-only),
 * heartbeats every 60s, and routes inbound CHAT_MESSAGE_POSTED + AGENT_ASSIGNED
 * events for the linked agent into the matching adapter.
 *
 * State files (mode 600) live under ~/.config/forge/:
 *   - auth.json    — server URL + bearer token + workspace slug.
 *   - daemon.pid   — PID of a backgrounded daemon, used by stop/status.
 *   - daemon.json  — last-known runtimeId (so restarts don't spawn a
 *                    duplicate Runtime row in Forge).
 */

const HEARTBEAT_INTERVAL_MS = 60_000;
/** Cap for the in-memory dedupe set of recently-handled event ids. */
const SEEN_EVENT_LIMIT = 256;

const DETECTABLE_CLIS: Array<{ bin: string; provider: AgentProviderId }> = [
  { bin: "claude", provider: "CLAUDE" },
  { bin: "codex", provider: "CODEX" },
  { bin: "hermes", provider: "HERMES" },
  // gemini/cursor-agent don't have a dedicated AgentProvider value in
  // the schema yet; map them to CUSTOM so the runtime row at least
  // records they're available on PATH.
  { bin: "gemini", provider: "CUSTOM" },
  { bin: "cursor-agent", provider: "CUSTOM" },
];

export function pidPath(): string {
  return path.join(configDir(), "daemon.pid");
}

export function statePath(): string {
  return path.join(configDir(), "daemon.json");
}

interface DaemonState {
  runtimeId: string;
  url: string;
  workspaceSlug: string;
  hostname: string;
}

async function readState(): Promise<DaemonState | null> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeState(state: DaemonState): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const handle = await fs.open(statePath(), "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
  await fs.chmod(statePath(), 0o600);
}

function detectProviders(): AgentProviderId[] {
  const found = new Set<AgentProviderId>();
  for (const { bin, provider } of DETECTABLE_CLIS) {
    const r = spawnSync("which", [bin], { stdio: "ignore" });
    if (r.status === 0) found.add(provider);
  }
  return [...found];
}

async function registerOrReuseRuntime(
  auth: AuthFile,
  hostname: string,
  providers: AgentProviderId[],
): Promise<string> {
  const previous = await readState();

  // Reuse path: prior daemon.json points at a Runtime — try to heartbeat
  // it. If it succeeds, that runtime row is still alive in Forge for
  // this workspace; we can keep using it. If it 404s (deleted /
  // archived) or the workspace changed, fall through to a fresh
  // register.
  if (
    previous &&
    previous.url === auth.url &&
    previous.workspaceSlug === auth.workspaceSlug &&
    previous.hostname === hostname
  ) {
    const hb = await callTool<{ id: string }>(auth, "runtimes.heartbeat", {
      runtimeId: previous.runtimeId,
    });
    if (!hb.isError && hb.data?.id) {
      return previous.runtimeId;
    }
    // else: fall through and re-register.
  }

  const reg = await callTool<{ id: string; name: string; kind: string }>(
    auth,
    "runtimes.register",
    {
      name: hostname,
      kind: "LOCAL_DAEMON",
      providersAvailable: providers,
    },
  );
  if (reg.isError || !reg.data?.id) {
    throw new Error(
      `runtimes.register failed: ${reg.text || "unknown error"}. Does your token have ADMIN scope?`,
    );
  }
  await writeState({
    runtimeId: reg.data.id,
    url: auth.url,
    workspaceSlug: auth.workspaceSlug,
    hostname,
  });
  return reg.data.id;
}

/**
 * Resolve the agent linked to this key. Distinguishes two null-ish cases so
 * the heartbeat loop can react correctly:
 *   - `undefined` → the call FAILED (transient rate-limit / network blip). The
 *     caller should KEEP its last-known linkage rather than dropping dispatch.
 *   - `null`      → the call succeeded but no agent is linked (a real unlink).
 *   - `AgentMe`   → the current linkage.
 */
async function refreshLinkedAgent(auth: AuthFile): Promise<AgentMe | null | undefined> {
  const me = await callTool<AgentMe>(auth, "agents.me", {});
  if (me.isError) return undefined;
  if (!me.data) return null;
  return me.data;
}

interface RealtimeEvent {
  id?: string;
  workspaceId: string;
  kind: string;
  subjectType?: string;
  subjectId?: string;
  payload?: Record<string, unknown> | null;
  actorId?: string | null;
  createdAt?: string;
  type?: string; // for the synthetic "ready" event
}

/** Widened typed view of the chat-message SSE payload. */
interface ChatMessagePostedPayload {
  threadId?: string;
  messageId?: string;
  agentId?: string;
  role?: string;
  body?: string;
  context?: {
    route?: string;
    slug?: string;
    issueId?: string;
    selectedIds?: string[];
    pinnedRunIds?: string[];
    liveRunIds?: string[];
  };
  /** Stream-channel events carry phase; the persisted-message events do not. */
  phase?: "started" | "delta" | "finalized";
}

function describeEvent(evt: RealtimeEvent): string {
  return `${evt.kind} ${evt.subjectType ?? ""}${evt.subjectId ? `#${evt.subjectId}` : ""}`;
}

/**
 * Bounded LRU-ish set for recently-handled event ids. We track these
 * to make AGENT_ASSIGNED handling idempotent against delivery retries.
 */
class SeenEvents {
  private set = new Set<string>();
  private order: string[] = [];

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > SEEN_EVENT_LIMIT) {
      const drop = this.order.shift();
      if (drop) this.set.delete(drop);
    }
  }
}

/** Minimal view of an `agent.inbox.list` run item (see agent-dispatch-inbox). */
interface InboxReconcileItem {
  kind: string;
  runId: string;
  workspaceId: string;
  agentId: string;
  issueId: string;
  triggerEventId?: string | null;
  issueSnapshot?: {
    id: string;
    number: number;
    title: string;
    priority: string;
    statusId: string;
    projectId: string | null;
  };
}

/**
 * Reconcile dropped dispatch on (re)connect. The daemon rides a live-only SSE
 * with no replay, so any AGENT_ASSIGNED fired while it was stopped or mid-
 * reconnect is otherwise lost forever. On every connect we pull the agent's
 * UNACKED inbox (the assignments it still owes) and drive each through the same
 * handler as a live event, deduped against `seenEvents` by the triggering event
 * id so a later SSE delivery of the same event is a no-op (and vice-versa).
 */
async function reconcileInbox(
  auth: AuthFile,
  agent: AgentMe,
  seenEvents: SeenEvents,
  foreground: boolean,
): Promise<void> {
  const res = await callTool<{ items: InboxReconcileItem[] }>(auth, "agent.inbox.list", {
    status: "unacked",
    limit: 50,
  });
  if (res.isError || !res.data) return;
  let dispatched = 0;
  for (const item of res.data.items ?? []) {
    if (item.kind !== "run" || !item.issueId) continue;
    if (item.agentId !== agent.id) continue;
    const key = item.triggerEventId ?? `run:${item.runId}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const evt: AgentAssignedEvent = {
      id: item.triggerEventId ?? undefined,
      workspaceId: item.workspaceId,
      kind: "AGENT_ASSIGNED",
      subjectType: "issue",
      subjectId: item.issueId,
      payload: {
        agentId: item.agentId,
        issueSnapshot: item.issueSnapshot
          ? { ...item.issueSnapshot, labelNames: [] }
          : undefined,
      },
    };
    void handleAgentAssigned({ auth, agent, evt, foreground });
    dispatched++;
  }
  if (dispatched && foreground) {
    console.log(chalk.gray(`  reconciled ${dispatched} pending assignment(s) from inbox`));
  }
}

/**
 * Acquire the daemon pid file as an atomic exclusive lock (O_CREAT|O_EXCL via
 * the "wx" flag). This closes the TOCTOU in `startDaemon`, whose liveness
 * check and the pid write were separated by the whole spawn, so two racing
 * `forge daemon start` invocations could both pass the check and both open an
 * SSE stream — double-dispatching every event. With an exclusive create, only
 * one child wins the lock; a loser that finds a *live* holder refuses, and a
 * *stale* holder is reclaimed.
 */
async function acquirePidLock(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(pidPath(), "wx", 0o600); // wx = O_CREAT|O_EXCL|O_WRONLY
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone holds (or held) the lock.
      const existing = await readPid();
      if (existing && isPidAlive(existing)) {
        console.error(
          chalk.red(
            `daemon already running (pid=${existing}). Run \`forge daemon stop\` first.`,
          ),
        );
        process.exit(1);
      }
      // Dead or unreadable holder → reclaim and retry the exclusive create.
      await fs.unlink(pidPath()).catch(() => {});
      continue;
    }
    try {
      await handle.writeFile(String(process.pid) + "\n");
    } finally {
      await handle.close();
    }
    return;
  }
  console.error(chalk.red("daemon: could not acquire pid lock (racing start?)."));
  process.exit(1);
}

async function runDaemon(opts: { foreground: boolean }) {
  const auth = await requireAuth();
  const hostname = os.hostname();
  const providers = detectProviders();

  console.log(chalk.cyan(`forge daemon — host=${hostname}`));
  console.log(
    chalk.gray(
      `  url=${auth.url}  workspace=${auth.workspaceSlug}  providers=[${providers.join(", ") || "none"}]`,
    ),
  );

  const runtimeId = await registerOrReuseRuntime(auth, hostname, providers);
  console.log(chalk.green(`  ✓ runtime ${runtimeId} registered`));

  let linkedAgent: AgentMe | null = (await refreshLinkedAgent(auth)) ?? null;
  if (linkedAgent) {
    console.log(
      chalk.gray(
        `  linked agent: ${linkedAgent.profileKey} (provider=${linkedAgent.provider})`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `  (api key has no linkedAgentId — chat dispatch will be skipped)`,
      ),
    );
  }

  const seenEvents = new SeenEvents();

  // PID file as an atomic exclusive lock, acquired BEFORE the SSE stream
  // opens so a second racing daemon can't also start dispatching. `stop` /
  // `status` read this file either way (foreground or backgrounded).
  await acquirePidLock();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log(chalk.gray("\nshutting down..."));
    try {
      await fs.unlink(pidPath());
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Heartbeat loop.
  const heartbeatTimer = setInterval(async () => {
    try {
      await callTool(auth, "runtimes.heartbeat", { runtimeId });
      // Refresh agent linkage opportunistically — admins can swap the key's
      // linkedAgentId without restarting the daemon. But only overwrite on a
      // definitive answer: a transient agents.me failure returns `undefined`,
      // and clobbering `linkedAgent` to null there would silently drop ALL
      // chat + assignment dispatch until the next successful heartbeat.
      const refreshed = await refreshLinkedAgent(auth);
      if (refreshed !== undefined) {
        linkedAgent = refreshed;
      } else if (linkedAgent) {
        console.error(
          chalk.yellow("heartbeat: agent refresh failed (transient); keeping last-known linkage"),
        );
      }
    } catch (err) {
      console.error(chalk.yellow(`heartbeat failed:`), err);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // SSE subscription. `/api/plugins/events` is the API-key-authed
  // workspace stream — `/api/realtime` requires a session cookie which
  // the daemon does not have.
  const sseUrl = new URL("/api/plugins/events", auth.url).toString();
  const es = new EventSource(sseUrl, {
    headers: { Authorization: `Bearer ${auth.token}` },
  } as ConstructorParameters<typeof EventSource>[1]);

  // Fatal-auth backstop: a revoked / expired token makes EventSource retry a
  // 401 forever while `daemon status` still reads "running" — silently doing
  // nothing. Count consecutive auth failures and exit non-zero past a threshold
  // so a supervisor surfaces it ("run forge login").
  let consecutiveAuthErrors = 0;
  const FATAL_AUTH_THRESHOLD = 5;

  es.onopen = () => {
    consecutiveAuthErrors = 0;
    console.log(chalk.gray("  SSE connected"));
    // Reconcile anything missed while disconnected (dropped dispatch replay).
    if (linkedAgent) {
      void reconcileInbox(auth, linkedAgent, seenEvents, opts.foreground).catch((err) =>
        console.error(chalk.yellow("reconcile failed:"), err),
      );
    }
  };
  es.onerror = (err) => {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 401 || status === 403) {
      consecutiveAuthErrors++;
      console.error(
        chalk.yellow(`SSE auth error (${status}) [${consecutiveAuthErrors}/${FATAL_AUTH_THRESHOLD}]`),
      );
      if (consecutiveAuthErrors >= FATAL_AUTH_THRESHOLD) {
        console.error(
          chalk.red("daemon: token invalid or expired — run `forge login`. Exiting."),
        );
        void fs.unlink(pidPath()).catch(() => {});
        process.exit(1);
      }
      return;
    }
    // Transient / network error — EventSource will retry; don't treat as fatal.
    console.error(chalk.yellow("SSE error:"), err);
  };
  es.onmessage = (ev: MessageEvent) => {
    let data: RealtimeEvent;
    try {
      data = JSON.parse(String(ev.data)) as RealtimeEvent;
    } catch {
      return;
    }
    // Ready handshake.
    if (data.type === "ready") return;

    if (opts.foreground) {
      console.log(chalk.gray(new Date().toISOString()), describeEvent(data));
    }

    // Filter: events targeted at this runtime (payload.runtimeId match)
    // OR chat events for the agent we're linked to.
    const payloadRuntime = (data.payload as { runtimeId?: string } | undefined)
      ?.runtimeId;
    const targetsThisRuntime = payloadRuntime === runtimeId;

    if (
      data.kind === "CHAT_MESSAGE_POSTED" &&
      data.subjectType === "chat-thread"
    ) {
      const payload = (data.payload ?? {}) as ChatMessagePostedPayload;
      if (
        payload.role === "USER" &&
        payload.agentId &&
        linkedAgent &&
        payload.agentId === linkedAgent.id
      ) {
        // Async dispatch — don't block the SSE handler.
        void handleChatDispatch(auth, linkedAgent, payload, opts.foreground);
      }
      return;
    }

    if (data.kind === "AGENT_ASSIGNED") {
      const payload = (data.payload ?? {}) as AgentAssignedPayload;
      if (linkedAgent && payload.agentId === linkedAgent.id) {
        // Idempotence — same event id should fire once.
        const eventId = data.id;
        if (eventId) {
          if (seenEvents.has(eventId)) {
            if (opts.foreground) {
              console.log(
                chalk.gray(
                  `  AGENT_ASSIGNED ${eventId} already handled; skipping retry`,
                ),
              );
            }
            return;
          }
          seenEvents.add(eventId);
        }
        const evt: AgentAssignedEvent = {
          id: data.id,
          workspaceId: data.workspaceId,
          kind: data.kind,
          subjectType: data.subjectType,
          subjectId: data.subjectId,
          payload,
        };
        // Async dispatch — keeps heartbeat / next-event handling alive.
        void handleAgentAssigned({
          auth,
          agent: linkedAgent,
          evt,
          foreground: opts.foreground,
        });
      } else if (targetsThisRuntime) {
        // For runtimes hosting multiple agents we can extend this; v1
        // only has the linked-agent path.
        if (opts.foreground) {
          console.log(
            chalk.yellow(
              `  AGENT_ASSIGNED targets this runtime but no linked agent matches`,
            ),
          );
        }
      }
      return;
    }
  };

  // Hold the process open. Heartbeat timer keeps it alive thanks to the
  // SSE connection, but we explicitly never resolve.
  return new Promise<void>(() => {
    /* intentionally never resolves */
  });
}

async function handleChatDispatch(
  auth: AuthFile,
  agent: AgentMe,
  payload: ChatMessagePostedPayload,
  foreground: boolean,
) {
  if (!payload.threadId) return;
  const userMessage = payload.body ?? "";
  if (!userMessage) {
    if (foreground) {
      console.warn(
        chalk.yellow(
          `  chat dispatch skipped: payload had no body (threadId=${payload.threadId})`,
        ),
      );
    }
    return;
  }
  if (foreground) {
    console.log(
      chalk.cyan(`  → dispatching chat to ${agent.profileKey} (${agent.provider})`),
    );
  }

  // Bundle thread context (history + workspace + linked-issue stub).
  const bundle = await loadThreadBundle(auth, payload.threadId);
  let threadHistory: ChatMessageHistoryRow[] = [];
  let issueContext: IssueBundle | null = null;
  if (bundle) {
    // Bundle gives us newest-first; cap to ~30 for prompt budget.
    threadHistory = (bundle.messages ?? []).slice(0, 30).filter((m) => {
      // Drop the just-arrived message — we pass it as `userMessage` separately.
      return m.id !== payload.messageId;
    });
  }

  // If the user pinned an issue in their context snapshot, fetch the
  // full issue bundle so Claude has it as system context.
  if (payload.context?.issueId) {
    issueContext = await loadIssueBundle(auth, payload.context.issueId);
  }

  // Inline image/PDF/text attachments — both on the linked issue (if any)
  // and on recent chat messages in the thread.
  const inlineRows: Array<{
    id: string;
    mimeType: string;
    filename?: string | null;
    sizeBytes?: number | null;
  }> = [];
  if (issueContext?.attachments?.length) {
    for (const a of issueContext.attachments) {
      const row = a as unknown as {
        id: string;
        mimeType: string;
        filename?: string | null;
        sizeBytes?: number | null;
      };
      inlineRows.push(row);
    }
  }
  // Chat-message attachments — fetch via attachments.list per recent
  // message id (capped to last 10 to stay in budget).
  if (threadHistory.length) {
    const recentIds = threadHistory.slice(0, 10).map((m) => m.id);
    const chatAtt = await loadMessageAttachments(auth, recentIds);
    inlineRows.push(...chatAtt);
  }
  // Also try the inbound message itself — the user may have attached
  // images to the message we're responding to.
  if (payload.messageId) {
    const inbound = await loadMessageAttachments(auth, [payload.messageId]);
    inlineRows.push(...inbound);
  }
  const attachments = await inlineAttachments(auth, inlineRows);

  await dispatchChat({
    auth,
    threadId: payload.threadId,
    agent: {
      id: agent.id,
      profileKey: agent.profileKey,
      name: agent.name,
      provider: agent.provider as AgentProviderId,
    },
    userMessage,
    workspaceSlug: auth.workspaceSlug,
    threadHistory,
    issueContext,
    attachments,
  });
}

// ---------------------------------------------------------------- Commands

export async function startDaemon(opts: { fg: boolean }): Promise<void> {
  // If a previous PID file exists and points at a live process, refuse.
  const existing = await readPid();
  if (existing && isPidAlive(existing)) {
    console.error(
      chalk.yellow(
        `daemon already running (pid=${existing}). Run \`forge daemon stop\` first.`,
      ),
    );
    process.exit(1);
  }
  if (existing) {
    // Stale pid file.
    await fs.unlink(pidPath()).catch(() => {});
  }

  if (opts.fg) {
    await runDaemon({ foreground: true });
    return;
  }

  // Background mode: re-spawn ourselves detached with FORGE_DAEMON_FG=1
  // so the child runs the same code path as foreground (without
  // re-detaching). Uses the same Node binary that ran us.
  const isChild = process.env.FORGE_DAEMON_INTERNAL === "1";
  if (isChild) {
    await runDaemon({ foreground: false });
    return;
  }

  const logDir = configDir();
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, "daemon.log");
  const out = await fs.open(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [process.argv[1] ?? "", "daemon", "start", "--fg"],
    {
      detached: true,
      stdio: ["ignore", out.fd, out.fd],
      env: { ...process.env, FORGE_DAEMON_INTERNAL: "1" },
    },
  );
  child.unref();
  await out.close();
  console.log(
    chalk.green(`forge daemon started (pid=${child.pid}). logs: ${logPath}`),
  );
}

export async function statusDaemon(): Promise<void> {
  const pid = await readPid();
  const auth = await requireAuth().catch(() => null);
  const state = await readState();

  if (pid && isPidAlive(pid)) {
    console.log(chalk.green(`daemon: running (pid=${pid})`));
  } else if (pid) {
    console.log(chalk.yellow(`daemon: stale pid file (pid=${pid} not alive)`));
  } else {
    console.log(chalk.gray(`daemon: not running`));
  }

  if (auth) {
    console.log(`  url:       ${auth.url}`);
    console.log(`  workspace: ${auth.workspaceSlug}`);
  } else {
    console.log(chalk.yellow(`  (no auth.json — run \`forge login\` first)`));
  }
  if (state) {
    console.log(`  runtime:   ${state.runtimeId} (host=${state.hostname})`);
  }
}

export async function stopDaemon(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log(chalk.gray("daemon: not running (no pid file)"));
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(chalk.yellow(`daemon: stale pid (${pid}); cleaning up`));
    await fs.unlink(pidPath()).catch(() => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`sent SIGTERM to pid ${pid}`));
  } catch (err) {
    console.error(chalk.red(`failed to signal pid ${pid}:`), err);
  }
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidPath(), "utf8");
    const pid = parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
