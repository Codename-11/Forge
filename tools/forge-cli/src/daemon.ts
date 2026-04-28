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

/**
 * Local daemon. Detects available agent CLIs, registers a Runtime in
 * Forge, opens an SSE subscription on `/api/plugins/events` (the
 * API-key-authed realtime stream — `/api/realtime` is session-only),
 * heartbeats every 60s, and routes inbound CHAT_MESSAGE_POSTED events
 * for the linked agent into the Claude Code adapter.
 *
 * State files (mode 600) live under ~/.config/forge/:
 *   - auth.json    — server URL + bearer token + workspace slug.
 *   - daemon.pid   — PID of a backgrounded daemon, used by stop/status.
 *   - daemon.json  — last-known runtimeId (so restarts don't spawn a
 *                    duplicate Runtime row in Forge).
 */

const HEARTBEAT_INTERVAL_MS = 60_000;

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

async function refreshLinkedAgent(auth: AuthFile): Promise<AgentMe | null> {
  const me = await callTool<AgentMe>(auth, "agents.me", {});
  if (me.isError || !me.data) return null;
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

function describeEvent(evt: RealtimeEvent): string {
  return `${evt.kind} ${evt.subjectType ?? ""}${evt.subjectId ? `#${evt.subjectId}` : ""}`;
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

  let linkedAgent = await refreshLinkedAgent(auth);
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

  // PID file (foreground only writes if requested too — `stop` works
  // either way).
  await fs.writeFile(pidPath(), String(process.pid) + "\n", { mode: 0o600 });

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
      // Refresh agent linkage opportunistically — admins can swap the
      // key's linkedAgentId without restarting the daemon.
      linkedAgent = await refreshLinkedAgent(auth);
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

  es.onopen = () => console.log(chalk.gray("  SSE connected"));
  es.onerror = (err) => {
    console.error(chalk.yellow("SSE error:"), err);
  };
  es.onmessage = async (ev: MessageEvent) => {
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
    // OR chat events for the agent we're linked to. We don't yet know
    // which arbitrary agents on this runtime exist (no list MCP), so
    // chat dispatch is gated on agents.me.
    const payloadRuntime = (data.payload as { runtimeId?: string } | undefined)
      ?.runtimeId;
    const targetsThisRuntime = payloadRuntime === runtimeId;

    if (
      data.kind === "CHAT_MESSAGE_POSTED" &&
      data.subjectType === "chat-thread"
    ) {
      const payload = data.payload as
        | { agentId?: string; role?: string; threadId?: string }
        | undefined;
      if (
        payload?.role === "USER" &&
        payload?.agentId &&
        linkedAgent &&
        payload.agentId === linkedAgent.id
      ) {
        await handleChatDispatch(auth, linkedAgent, payload, opts.foreground);
      }
      return;
    }

    if (data.kind === "AGENT_ASSIGNED") {
      const payload = data.payload as
        | { agentId?: string; previousAgentId?: string | null }
        | undefined;
      if (linkedAgent && payload?.agentId === linkedAgent.id) {
        await handleAgentAssigned(auth, data, linkedAgent, opts.foreground);
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
  payload: { agentId?: string; role?: string; threadId?: string; messageId?: string },
  foreground: boolean,
) {
  if (!payload.threadId) return;
  if (foreground) {
    console.log(
      chalk.cyan(`  → dispatching chat to ${agent.profileKey} (${agent.provider})`),
    );
  }
  // We need the user message body. The SSE event currently only carries
  // metadata (threadId, messageId, agentId) — the body is in the
  // ChatMessage row. We can fetch it via... hmm, there's no
  // chat.getMessage MCP tool. For v1 we send a minimal placeholder
  // describing the prompt + suggesting the user re-prompts via the
  // chat UI if they need richer context. Future: add a chat.getThread
  // MCP tool.
  //
  // For now, we use the messageId in the prompt so the agent knows
  // which message it's replying to and can hint to the operator.
  const userMessage = payload.messageId
    ? `(Forge daemon received chat dispatch for message ${payload.messageId}. The local daemon does not yet fetch message bodies — please ensure your message body is available via chat.getThread when that MCP tool ships, or paste the prompt into the issue if Claude needs the full text.)\n\nRespond with a brief acknowledgement so the operator knows the daemon path is alive.`
    : "Forge daemon dispatched a chat message but no body was provided. Reply briefly.";

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
  });
}

async function handleAgentAssigned(
  auth: AuthFile,
  evt: RealtimeEvent,
  agent: AgentMe,
  foreground: boolean,
) {
  const issueId = evt.subjectId;
  if (!issueId) return;
  if (foreground) {
    console.log(
      chalk.cyan(`  → AGENT_ASSIGNED for ${agent.profileKey} on issue ${issueId}`),
    );
  }
  // v1 stub: drop a placeholder comment so the operator knows the
  // daemon picked up the assignment. Full agent loop (spawn claude,
  // iterate, post progress comments, recordUsage) is a future stream.
  try {
    await callTool(auth, "comments.create", {
      issueId,
      body: `[forge-cli local daemon] Picked up assignment on ${os.hostname()}. The full agent work loop is not yet implemented in this daemon — please dispatch via Hermes or work this issue manually for now.`,
    });
  } catch (err) {
    console.error(`[daemon] comments.create failed:`, err);
  }
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
