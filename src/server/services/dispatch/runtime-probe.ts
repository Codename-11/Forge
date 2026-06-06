import "server-only";
import WebSocket from "ws";

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
      ws.on("message", () =>
        finish({ attempted: true, reachable: true, detail: "Codex app server responded to initialize." }),
      );
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

/** Cheap Hermes gateway handshake. Uses `/models` when the endpoint looks OpenAI-compatible so bad bearer tokens surface as auth failures. */
async function probeHermesHttp(
  endpoint: string,
  secret: string | null | undefined,
  timeoutMs: number,
): Promise<RuntimeProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = hermesProbeUrl(endpoint);
    const res = await fetch(url, {
      method: "GET",
      headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        attempted: true,
        reachable: false,
        detail: `Gateway rejected auth (HTTP ${res.status}).`,
      };
    }
    return {
      attempted: true,
      reachable: true,
      detail: `Gateway answered (HTTP ${res.status}).`,
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

function hermesProbeUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/v1")) {
      url.pathname = `${path}/models`;
    }
    return url.toString();
  } catch {
    return endpoint;
  }
}
