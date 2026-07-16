import "server-only";

import { createHash } from "node:crypto";

export const HERMES_SESSIONS_CONNECTOR_KEY = "hermes-sessions";
export const HERMES_SESSIONS_PROTOCOL_V1 = "hermes.sessions.v1";
export const HERMES_MEMORY_KEY_VERSION = 2;

const CAPABILITIES_OBJECT_V1 = "hermes.api_server.capabilities";
const KNOWN_SESSION_EVENTS = new Set([
  "session.created",
  "run.started",
  "message.started",
  "assistant.delta",
  "tool.progress",
  "tool.pending",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "assistant.completed",
  "run.completed",
  "error",
  "done",
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Stable, opaque, tenant-safe Hermes memory namespace. The input contains only
 * immutable database ids; the digest avoids leaking those ids to the runtime.
 * The returned key is persisted on ConnectorSession so a future algorithm
 * change cannot silently move an existing conversation's memory.
 */
export function buildHermesMemoryKey(input: {
  runtimeId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
  chatThreadId: string;
  purpose?: "interactive" | "self-test";
  generation?: string;
}): string {
  const parts = [
    `v${HERMES_MEMORY_KEY_VERSION}`,
    input.purpose ?? "interactive",
    input.runtimeId,
    input.workspaceId,
    input.userId,
    input.agentId,
    input.chatThreadId,
    input.generation ?? "initial",
  ];
  const digest = createHash("sha256").update(parts.join("\u001f"), "utf8").digest("base64url");
  return `forge:v${HERMES_MEMORY_KEY_VERSION}:${digest}`;
}

export interface HermesNegotiatedCapabilities {
  connectorKey: typeof HERMES_SESSIONS_CONNECTOR_KEY;
  protocolVersion: typeof HERMES_SESSIONS_PROTOCOL_V1 | null;
  platform: string | null;
  sessions: boolean;
  streaming: boolean;
  toolEvents: boolean;
  approvals: boolean;
  attachments: boolean;
  resume: boolean;
  proactiveDelivery: boolean;
  stop: boolean;
  sessionKeyHeader: string | null;
  endpoints: {
    sessions: string | null;
    create: string | null;
    get: string | null;
    messages: string | null;
    stream: string | null;
    delete: string | null;
  };
  raw: JsonRecord;
}

function endpointPath(endpoints: JsonRecord, key: string, method?: string): string | null {
  const endpoint = record(endpoints[key]);
  if (!endpoint) return null;
  if (method && stringValue(endpoint.method)?.toUpperCase() !== method) return null;
  return stringValue(endpoint.path);
}

/** Parse the installed Hermes `/v1/capabilities` response fail-closed. */
export function negotiateHermesCapabilities(rawValue: unknown): HermesNegotiatedCapabilities {
  const raw = record(rawValue) ?? {};
  const features = record(raw.features) ?? {};
  const endpoints = record(raw.endpoints) ?? {};
  const sessionsPath = endpointPath(endpoints, "sessions", "GET");
  const createPath = endpointPath(endpoints, "session_create", "POST");
  const getPath = endpointPath(endpoints, "session", "GET");
  const messagesPath = endpointPath(endpoints, "session_messages", "GET");
  const streamPath = endpointPath(endpoints, "session_chat_stream", "POST");
  const deletePath = endpointPath(endpoints, "session_delete", "DELETE");
  const objectContract = stringValue(raw.object);
  const explicitProtocol = stringValue(raw.session_protocol_version ?? raw.protocol_version);
  const protocolVersion =
    explicitProtocol === HERMES_SESSIONS_PROTOCOL_V1
      ? HERMES_SESSIONS_PROTOCOL_V1
      : !explicitProtocol && objectContract === CAPABILITIES_OBJECT_V1
        ? HERMES_SESSIONS_PROTOCOL_V1
        : null;
  const sessions =
    protocolVersion !== null &&
    features.session_resources === true &&
    features.session_chat === true &&
    sessionsPath === "/api/sessions" &&
    createPath === "/api/sessions" &&
    getPath === "/api/sessions/{session_id}";

  return {
    connectorKey: HERMES_SESSIONS_CONNECTOR_KEY,
    protocolVersion,
    platform: stringValue(raw.platform),
    sessions,
    streaming:
      sessions &&
      features.session_chat_streaming === true &&
      streamPath === "/api/sessions/{session_id}/chat/stream",
    toolEvents: sessions && features.tool_progress_events === true,
    // Generic run approval support does not prove session-chat approval
    // support. Require the session-specific capability.
    approvals: sessions && features.session_approval_events === true,
    attachments: sessions && features.session_attachments === true,
    resume: sessions && features.session_resume === true,
    proactiveDelivery: sessions && features.session_proactive_delivery === true,
    stop: sessions && features.session_stop === true,
    sessionKeyHeader: stringValue(features.session_key_header),
    endpoints: {
      sessions: sessionsPath,
      create: createPath,
      get: getPath,
      messages: messagesPath,
      stream: streamPath,
      delete: deletePath,
    },
    raw,
  };
}

export interface HermesSessionEvent {
  name: string;
  known: boolean;
  sseId: string | null;
  sequence: number | null;
  sessionId: string | null;
  runId: string | null;
  messageId: string | null;
  data: JsonRecord;
}

export function parseHermesSessionEvent(input: {
  event: string | null;
  id: string | null;
  data: string;
}): HermesSessionEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.data);
  } catch {
    throw new Error("Hermes Sessions stream emitted invalid JSON.");
  }
  const data = record(parsed);
  if (!data) throw new Error("Hermes Sessions stream event payload must be an object.");
  const embeddedName = stringValue(data.event ?? data.type);
  const name = input.event || embeddedName || "message";
  const message = record(data.message);
  return {
    name,
    known: KNOWN_SESSION_EVENTS.has(name),
    sseId: input.id,
    sequence: numberValue(data.seq ?? data.sequence),
    sessionId: stringValue(data.session_id ?? data.sessionId),
    runId: stringValue(data.run_id ?? data.runId),
    messageId: stringValue(data.message_id ?? data.messageId) ?? stringValue(message?.id),
    data,
  };
}

/** Stable dedupe id. Hermes `seq` restarts for every chat POST, so the run id
 * is part of the namespace and sequence must never be unique by session alone. */
export function hermesSessionExternalEventId(event: HermesSessionEvent): string {
  if (event.sseId) return event.sseId;
  if (event.runId && event.sequence !== null) {
    return `${event.runId}:${event.sequence}:${event.name}`;
  }
  return createHash("sha256")
    .update(JSON.stringify([event.sessionId, event.runId, event.name, event.data]))
    .digest("base64url");
}

/** Incremental SSE parser supporting CRLF, split chunks, comments and data lines. */
export class HermesSessionSseParser {
  private pending = "";

  push(chunk: string): HermesSessionEvent[] {
    this.pending += chunk;
    return this.drain(false);
  }

  finish(): HermesSessionEvent[] {
    return this.drain(true);
  }

  private drain(flush: boolean): HermesSessionEvent[] {
    this.pending = this.pending.replace(/\r\n/g, "\n");
    const blocks: string[] = [];
    let separator = this.pending.indexOf("\n\n");
    while (separator !== -1) {
      blocks.push(this.pending.slice(0, separator));
      this.pending = this.pending.slice(separator + 2);
      separator = this.pending.indexOf("\n\n");
    }
    if (flush && this.pending.trim()) {
      blocks.push(this.pending);
      this.pending = "";
    }
    return blocks.flatMap((block) => {
      let event: string | null = null;
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "id") id = value;
        else if (field === "data") data.push(value);
      }
      return data.length ? [parseHermesSessionEvent({ event, id, data: data.join("\n") })] : [];
    });
  }
}

export function redactConnectorDiagnostic(value: unknown, maxLength = 500): string {
  const text = value instanceof Error ? value.message : String(value ?? "Connector request failed.");
  const redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(token|secret|key|authorization|signature)(["'\s:=]+)[^\s"'&}]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 3)}...` : redacted;
}

export function connectorRetryDecision(input: {
  attempt: number;
  maxAttempts: number;
  initialSeconds: number;
  maxSeconds: number;
  now?: Date;
  random?: () => number;
}): { deadLetter: boolean; delaySeconds: number | null; nextAttemptAt: Date | null } {
  const attempt = Math.max(1, Math.trunc(input.attempt));
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  if (attempt >= maxAttempts) return { deadLetter: true, delaySeconds: null, nextAttemptAt: null };
  const initial = Math.max(1, Math.trunc(input.initialSeconds));
  const maximum = Math.max(initial, Math.trunc(input.maxSeconds));
  const exponential = Math.min(maximum, initial * 2 ** Math.min(30, attempt - 1));
  // Bounded 0.8–1.2 jitter prevents synchronized retries. Tests inject random.
  const jittered = Math.max(1, Math.round(exponential * (0.8 + 0.4 * (input.random ?? Math.random)())));
  const delaySeconds = Math.min(maximum, jittered);
  const nextAttemptAt = new Date((input.now ?? new Date()).getTime() + delaySeconds * 1000);
  return { deadLetter: false, delaySeconds, nextAttemptAt };
}

export interface HermesSessionResource {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number | null;
  raw: JsonRecord;
}

export class HermesSessionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HermesSessionsError";
  }
}

export interface HermesSessionsClientOptions {
  baseUrl: string;
  token?: string | null;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

function apiRoot(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return url;
}

function apiUrl(baseUrl: string, path: string): string {
  const root = apiRoot(baseUrl);
  root.pathname = `${root.pathname}${path}`.replace(/\/+/g, "/");
  return root.toString();
}

function capabilitiesUrl(baseUrl: string): string {
  return apiUrl(baseUrl, "/v1/capabilities");
}

function unwrapSession(value: unknown): HermesSessionResource {
  const outer = record(value);
  const raw = record(outer?.session) ?? outer;
  const id = stringValue(raw?.id);
  if (!raw || !id) throw new HermesSessionsError("Hermes session response omitted an id.", 502, false);
  return {
    id,
    title: stringValue(raw.title),
    createdAt: stringValue(raw.created_at ?? raw.createdAt),
    updatedAt: stringValue(raw.updated_at ?? raw.updatedAt),
    messageCount: numberValue(raw.message_count ?? raw.messageCount),
    raw,
  };
}

export function makeHermesSessionsClient(options: HermesSessionsClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = (sessionKey?: string, idempotencyKey?: string): Record<string, string> => ({
    accept: "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  });

  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, options.requestTimeoutMs));
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const detail = redactConnectorDiagnostic(await response.text().catch(() => ""));
        throw new HermesSessionsError(
          detail || `Hermes Sessions request failed (HTTP ${response.status}).`,
          response.status,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof HermesSessionsError) throw error;
      throw new HermesSessionsError(redactConnectorDiagnostic(error), 0, true);
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    async negotiateCapabilities(): Promise<HermesNegotiatedCapabilities> {
      const response = await request(capabilitiesUrl(options.baseUrl), {
        headers: headers(),
      });
      return negotiateHermesCapabilities(await response.json());
    },

    async createSession(input: {
      sessionId?: string | null;
      title?: string | null;
      model?: string | null;
      memoryKey: string;
      idempotencyKey?: string;
    }): Promise<HermesSessionResource> {
      const sessionId = input.sessionId?.trim() || null;
      try {
        const response = await request(apiUrl(options.baseUrl, "/api/sessions"), {
          method: "POST",
          headers: {
            ...headers(input.memoryKey, input.idempotencyKey),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(sessionId ? { id: sessionId } : {}),
            ...(input.title?.trim() ? { title: input.title.trim() } : {}),
            ...(input.model?.trim() ? { model: input.model.trim() } : {}),
          }),
        });
        return unwrapSession(await response.json());
      } catch (error) {
        // Hermes returns 409 when an explicit id already exists. Reading that
        // id makes a create retry recover safely after a lost 201 response.
        if (sessionId && error instanceof HermesSessionsError && error.status === 409) {
          return this.getSession(sessionId, input.memoryKey);
        }
        throw error;
      }
    },

    async getSession(sessionId: string, memoryKey: string): Promise<HermesSessionResource> {
      const response = await request(
        apiUrl(options.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`),
        { headers: headers(memoryKey) },
      );
      return unwrapSession(await response.json());
    },

    async deleteSession(sessionId: string, memoryKey: string): Promise<void> {
      await request(apiUrl(options.baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`), {
        method: "DELETE",
        headers: headers(memoryKey),
      });
    },

    async *streamMessage(input: {
      sessionId: string;
      memoryKey: string;
      message: string | Array<Record<string, unknown>>;
      instructions?: string;
      model?: string;
      idempotencyKey?: string;
      signal?: AbortSignal;
    }): AsyncGenerator<HermesSessionEvent> {
      const response = await request(
        apiUrl(
          options.baseUrl,
          `/api/sessions/${encodeURIComponent(input.sessionId)}/chat/stream`,
        ),
        {
          method: "POST",
          headers: {
            ...headers(input.memoryKey, input.idempotencyKey),
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: input.message,
            ...(input.instructions ? { instructions: input.instructions } : {}),
            ...(input.model ? { model: input.model } : {}),
          }),
          signal: input.signal,
        },
      );
      if (!response.body) throw new HermesSessionsError("Hermes session stream had no body.", 502, true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new HermesSessionSseParser();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
        }
        for (const event of parser.finish()) yield event;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}

export type HermesSessionsClient = ReturnType<typeof makeHermesSessionsClient>;
