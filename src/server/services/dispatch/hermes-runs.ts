import "server-only";
import { logger } from "@/server/logger";
import type {
  DispatchConnector,
  RunEvent,
  RunInput,
  RunStatus,
  StartedRun,
} from "./types";

function mapStatus(raw: string): RunStatus["state"] {
  const s = raw.toLowerCase();
  if (s.includes("complete")) return "completed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("fail") || s.includes("error")) return "failed";
  if (s.includes("approval")) return "waiting_for_approval";
  if (s.includes("run") || s.includes("pending") || s.includes("queue")) return "running";
  return "unknown";
}

/**
 * Connector for Hermes' structured agent-run API:
 *   POST   /v1/runs                 → { run_id }            (202, async)
 *   GET    /v1/runs/{id}/events      → SSE lifecycle events
 *   POST   /v1/runs/{id}/approval    → { choice }
 *   POST   /v1/runs/{id}/stop
 *
 * Auth is the same Bearer token as the OpenAI-compat surface
 * (`HERMES_GATEWAY_TOKEN` must equal the gateway's `API_SERVER_KEY`).
 *
 * The gateway base + token default to env, but a managed Hermes **Runtime**
 * can override them (`Runtime.endpoint` / `Runtime.secret`) so multiple
 * gateways are addressable — see `makeHermesRunsConnector` + the resolver in
 * `resolve.ts`.
 *
 * Native event vocabulary (see hermes-agent gateway `api_server.py`):
 *   message.delta {delta} · reasoning.available {text} ·
 *   tool.started {tool,preview} · tool.completed {tool,duration,error} ·
 *   approval.request {choices,...} · run.completed|failed|cancelled
 */
function envGatewayBase(): string {
  return (
    process.env.HERMES_GATEWAY_URL ??
    `http://127.0.0.1:${process.env.HERMES_GATEWAY_PORT ?? "8642"}/v1`
  );
}

function envGatewayToken(): string {
  return process.env.HERMES_GATEWAY_TOKEN ?? "placeholder";
}

/**
 * Build a Hermes runs connector. With no opts (or null fields) it uses the
 * env gateway — identical to the historical singleton. A managed runtime
 * passes its `endpoint` (gateway base) + `secret` (token) to target a
 * specific gateway.
 */
export function makeHermesRunsConnector(opts?: {
  baseUrl?: string | null;
  token?: string | null;
}): DispatchConnector {
  const base = () => opts?.baseUrl || envGatewayBase();
  const authHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${opts?.token || envGatewayToken()}`,
  });

  return {
    kind: "hermes-runs",

    async startRun(input: RunInput): Promise<StartedRun> {
      const body: Record<string, unknown> = { input: input.message };
      if (input.instructions) body.instructions = input.instructions;
      if (input.history && input.history.length > 0) {
        body.conversation_history = input.history;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...authHeaders(),
      };
      if (input.sessionKey) headers["x-session-key"] = input.sessionKey;

      const res = await fetch(`${base()}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Hermes runs start failed (${res.status})`);
      }
      const json = (await res.json()) as { run_id?: string; id?: string };
      const externalRunId = json.run_id ?? json.id;
      if (!externalRunId) throw new Error("Hermes runs start: no run_id in response");
      return { externalRunId };
    },

    async subscribe(
      externalRunId: string,
      onEvent: (e: RunEvent) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      let res: Response;
      try {
        res = await fetch(`${base()}/runs/${externalRunId}/events`, {
          method: "GET",
          headers: { accept: "text/event-stream", ...authHeaders() },
          signal,
        });
      } catch (err) {
        onEvent({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to open run events",
        });
        return;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        onEvent({ type: "error", message: text || `Run events failed (${res.status})` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let terminal = false;

      const handle = (raw: string) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        const name = String(evt.event ?? "");
        switch (name) {
          case "message.delta": {
            const delta = typeof evt.delta === "string" ? evt.delta : "";
            if (delta) onEvent({ type: "content_delta", delta });
            break;
          }
          case "reasoning.available": {
            const text = typeof evt.text === "string" ? evt.text : "";
            if (text) onEvent({ type: "thinking", text });
            break;
          }
          case "tool.started":
            onEvent({
              type: "tool_started",
              tool: String(evt.tool ?? "tool"),
              preview: typeof evt.preview === "string" ? evt.preview : undefined,
            });
            break;
          case "tool.completed":
            onEvent({
              type: "tool_completed",
              tool: String(evt.tool ?? "tool"),
              durationMs:
                typeof evt.duration === "number" ? Math.round(evt.duration * 1000) : undefined,
              isError: evt.error === true,
            });
            break;
          case "approval.request":
            onEvent({
              type: "approval_required",
              choices: Array.isArray(evt.choices)
                ? (evt.choices as string[])
                : ["once", "deny"],
              tool: typeof evt.tool === "string" ? evt.tool : undefined,
              raw: evt,
            });
            break;
          case "approval.responded":
            onEvent({
              type: "approval_resolved",
              choice: typeof evt.choice === "string" ? evt.choice : undefined,
            });
            break;
          case "run.completed":
            terminal = true;
            onEvent({
              type: "completed",
              finalText: typeof evt.output === "string" ? evt.output : undefined,
            });
            break;
          case "run.cancelled":
            terminal = true;
            onEvent({ type: "completed" });
            break;
          case "run.failed":
            terminal = true;
            onEvent({
              type: "error",
              message:
                (typeof evt.error === "string" && evt.error) ||
                (typeof evt.message === "string" && evt.message) ||
                "Run failed",
            });
            break;
          default:
            break;
        }
      };

      try {
        while (!terminal) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let sep = pending.indexOf("\n\n");
          while (sep !== -1) {
            const block = pending.slice(0, sep);
            pending = pending.slice(sep + 2);
            for (const line of block.split("\n")) {
              const trimmed = line.trimStart();
              if (trimmed.startsWith(":")) continue; // keepalive comment
              if (trimmed.startsWith("data:")) handle(trimmed.slice(5).trim());
            }
            sep = pending.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!signal?.aborted) {
          logger.warn({ err, externalRunId }, "hermes-runs: event stream interrupted");
          onEvent({
            type: "error",
            message: err instanceof Error ? err.message : "Run stream interrupted",
          });
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
      // Defensive: if the stream closed without a terminal event, synthesise one.
      if (!terminal) onEvent({ type: "completed" });
    },

    async getStatus(externalRunId: string): Promise<RunStatus> {
      const res = await fetch(`${base()}/runs/${externalRunId}`, {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders() },
      });
      if (!res.ok) {
        // 404 = run swept (TTL) — treat as completed so the poller stops.
        if (res.status === 404) return { state: "completed" };
        throw new Error(`Run status failed (${res.status})`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const usageRaw = (json.usage ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" ? v : undefined;
      return {
        state: mapStatus(String(json.status ?? "")),
        lastEvent: typeof json.last_event === "string" ? json.last_event : undefined,
        output: typeof json.output === "string" ? json.output : undefined,
        usage: {
          tokensIn: num(usageRaw.input_tokens ?? usageRaw.prompt_tokens),
          tokensOut: num(usageRaw.output_tokens ?? usageRaw.completion_tokens),
          costUsd: num(usageRaw.cost_usd ?? usageRaw.costUsd),
        },
      };
    },

    async approve(externalRunId: string, choice: string): Promise<void> {
      await fetch(`${base()}/runs/${externalRunId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ choice }),
      }).catch((err) => {
        logger.warn({ err, externalRunId }, "hermes-runs: approval post failed");
      });
    },

    async stop(externalRunId: string): Promise<void> {
      await fetch(`${base()}/runs/${externalRunId}/stop`, {
        method: "POST",
        headers: authHeaders(),
      }).catch((err) => {
        logger.warn({ err, externalRunId }, "hermes-runs: stop post failed");
      });
    },
  };
}

/** Env-based singleton — the historical default connector. */
export const hermesRunsConnector: DispatchConnector = makeHermesRunsConnector();
