import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { makeCodexAppServerConnector } from "@/server/services/dispatch/codex-app-server";
import type { RunEvent } from "@/server/services/dispatch/types";

/**
 * LIVE end-to-end test of the Codex app-server connector against a real
 * `codex app-server` process. Skipped unless CODEX_LIVE=1 (needs codex-cli
 * installed + logged in). Since codex 0.133 speaks stdio JSON-RPC (no ws
 * listener), we stand up a tiny stdio↔WebSocket bridge — the same bridge an
 * operator runs to expose the app server to Forge — and point the real
 * connector at it. This exercises the shipped WebSocket plumbing + protocol
 * mapping against genuine Codex output.
 *
 *   CODEX_LIVE=1 pnpm vitest run tests/unit/codex-app-server-live.test.ts
 */
const LIVE = process.env.CODEX_LIVE === "1";

describe.skipIf(!LIVE)("codex-app-server connector (live)", () => {
  let server: WebSocketServer;
  let port = 0;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeAll(async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
    server.on("connection", (ws: WebSocket) => {
      const child = spawn(
        "codex",
        ["app-server", "-c", "sandbox_mode=danger-full-access"],
        { stdio: ["pipe", "pipe", "pipe"] },
      ) as ChildProcessWithoutNullStreams;
      children.add(child);
      // ws message (one JSON-RPC object) → ndjson line to codex stdin.
      ws.on("message", (data) => {
        try {
          child.stdin.write(data.toString() + "\n");
        } catch {
          /* pipe closed */
        }
      });
      // codex stdout ndjson lines → one ws message each.
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && ws.readyState === ws.OPEN) ws.send(line);
        }
      });
      const kill = () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        children.delete(child);
      };
      ws.on("close", kill);
      child.on("close", () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      });
    });
  });

  afterAll(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    server?.close();
  });

  it("streams a real Codex reply through the connector", async () => {
    const connector = makeCodexAppServerConnector({ baseUrl: `ws://127.0.0.1:${port}` });
    expect(connector).not.toBeNull();

    const { externalRunId } = await connector!.startRun({
      message:
        "Reply with exactly the token FORGE_CODEX_OK and nothing else. Do not run any tools.",
      instructions: "You are a Forge connectivity test. Keep the reply to one line.",
    });
    expect(externalRunId).toMatch(/#/); // threadId#turnId

    let assembled = "";
    let completed = false;
    await connector!.subscribe(externalRunId, (e: RunEvent) => {
      if (e.type === "content_delta") assembled += e.delta;
      if (e.type === "completed") completed = true;
    });

    expect(completed).toBe(true);
    expect(assembled).toContain("FORGE_CODEX_OK");
  }, 90_000);
});
