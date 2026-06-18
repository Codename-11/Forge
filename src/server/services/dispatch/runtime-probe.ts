import "server-only";
import WebSocket from "ws";
import type { Prisma } from "@prisma/client";
import { extractRuntimeInfoFromInitializeResult } from "@/server/services/runtime-info";

/**
 * Lightweight reachability probe for a managed runtime endpoint — used by
 * `agent.verifyConnection` so misconfiguration surfaces at setup time instead
 * of on the first chat. Does the minimum to prove the endpoint answers: a
 * WebSocket open + `initialize` for a Codex app server, a cheap GET for an
 * HTTP gateway (Hermes). Never runs a turn. Always resolves (errors → not
 * reachable + detail) within `timeoutMs`.
 */
export type RuntimeProbeResult = {
  attempted: boolean;
  reachable: boolean | null;
  detail: string;
  runtimeInfo?: Prisma.JsonObject | null;
};

const NOT_ATTEMPTED: RuntimeProbeResult = {
  attempted: false,
  reachable: null,
  detail: "No reachability probe for this transport.",
};

export async function probeRuntime(input: {
  adapterKey: string | null | undefined;
  endpoint: string | null | undefined;
  secret: string | null | undefined;
  timeoutMs?: number;
}): Promise<RuntimeProbeResult> {
  const { adapterKey, endpoint } = input;
  const timeoutMs = input.timeoutMs ?? 6000;
  if (!endpoint) return NOT_ATTEMPTED;

  if (adapterKey === "codex-app-server") {
    return probeCodexWs(endpoint, input.secret, timeoutMs);
  }
  if (adapterKey === "hermes") {
    return probeHermesHttp(endpoint, input.secret, timeoutMs);
  }
  return NOT_ATTEMPTED;
}

/** Open the WebSocket + initialize handshake; reachable once Codex replies. */
function probeCodexWs(
  endpoint: string,
  secret: string | null | undefined,
  timeoutMs: number,
): Promise<RuntimeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (r: RuntimeProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ attempted: true, reachable: false, detail: `No response within ${timeoutMs}ms.` }),
      timeoutMs,
    );
    try {
      const headers: Record<string, string> = {};
      if (secret) headers.authorization = `Bearer ${secret}`;
      ws = new WebSocket(endpoint, { headers });
      ws.on("open", () => {
        try {
          ws?.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                clientInfo: { name: "forge-probe", title: "Forge", version: "1" },
                capabilities: { experimentalApi: true, requestAttestation: false },
              },
            }),
          );
        } catch {
          /* send race */
        }
      });
      ws.on("message", (raw) => {
        finish({
          attempted: true,
          reachable: true,
          detail: "Codex app server responded to initialize.",
          runtimeInfo: runtimeInfoFromCodexMessage(raw),
        });
      });
      ws.on("error", (err: Error) =>
        finish({ attempted: true, reachable: false, detail: err.message }),
      );
    } catch (err) {
      finish({
        attempted: true,
        reachable: false,
        detail: err instanceof Error ? err.message : "Failed to open socket.",
      });
    }
  });
}

function runtimeInfoFromCodexMessage(raw: WebSocket.RawData): Prisma.JsonObject | null {
  try {
    const msg = JSON.parse(raw.toString()) as { result?: unknown };
    return extractRuntimeInfoFromInitializeResult(msg.result, {
      adapterKey: "codex-app-server",
      transport: "app-server",
    });
  } catch {
    return null;
  }
}

/**
 * Hermes gateway contract probe.
 *
 * This is intentionally non-mutating: `/models` proves the configured gateway
 * base + bearer token are valid, and `GET /runs` proves the structured runs
 * route exists without starting a run. Current Hermes returns 405 for that
 * second check, which is a good signal: the path exists, but the method is
 * not the mutating POST that starts work.
 */
async function probeHermesHttp(
  endpoint: string,
  secret: string | null | undefined,
  timeoutMs: number,
): Promise<RuntimeProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = secret ? { authorization: `Bearer ${secret}` } : undefined;
    const models = await fetch(hermesProbeUrl(endpoint, "models"), {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    if (models.status === 401 || models.status === 403) {
      return {
        attempted: true,
        reachable: false,
        detail: `Gateway rejected auth (HTTP ${models.status}).`,
      };
    }
    if (models.status < 200 || models.status >= 300) {
      return {
        attempted: true,
        reachable: false,
        detail:
          models.status === 404
            ? "Hermes model surface missing (HTTP 404); endpoint should point at the gateway /v1 base."
            : `Hermes model surface failed (HTTP ${models.status}).`,
      };
    }

    const runs = await fetch(hermesProbeUrl(endpoint, "runs"), {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    if (runs.status === 401 || runs.status === 403) {
      return {
        attempted: true,
        reachable: false,
        detail: `Gateway rejected auth (HTTP ${runs.status}).`,
      };
    }
    if (runs.status === 404) {
      return {
        attempted: true,
        reachable: false,
        detail:
          "Hermes runs API missing (HTTP 404); upgrade Hermes or point the runtime at a gateway that exposes /v1/runs.",
      };
    }
    if (runs.status >= 500) {
      return {
        attempted: true,
        reachable: false,
        detail: `Hermes runs API failed (HTTP ${runs.status}).`,
      };
    }
    return {
      attempted: true,
      reachable: true,
      detail: `Gateway contract ok (models HTTP ${models.status}; runs route HTTP ${runs.status}).`,
    };
  } catch (err) {
    return {
      attempted: true,
      reachable: false,
      detail: err instanceof Error ? err.message : "Request failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function hermesProbeUrl(endpoint: string, suffix: "models" | "runs"): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = `${path}/${suffix}`;
    return url.toString();
  } catch {
    return endpoint;
  }
}
