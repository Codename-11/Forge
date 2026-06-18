import "server-only";
import type { Prisma } from "@prisma/client";

type JsonObject = Prisma.JsonObject;

export type RuntimeInfoKind = "version" | "host" | "path" | "auth" | "build" | "runtime";

export type RuntimeInfoField = {
  key: string;
  label: string;
  value: string;
  kind: RuntimeInfoKind;
};

export type RuntimeInfoSummary = {
  status: "missing" | "reported";
  label: string;
  detail: string;
  lastReportedAt: Date | string | null;
  fields: RuntimeInfoField[];
};

const MAX_VALUE_LENGTH = 300;
const MAX_DETAIL_FIELDS = 18;

const STRING_FIELDS: Array<{ key: string; label: string; kind: RuntimeInfoKind }> = [
  { key: "adapterKey", label: "Adapter", kind: "runtime" },
  { key: "runtimeName", label: "Runtime", kind: "runtime" },
  { key: "runtimeVersion", label: "Runtime version", kind: "version" },
  { key: "bridgeName", label: "Bridge", kind: "runtime" },
  { key: "bridgeVersion", label: "Bridge version", kind: "version" },
  { key: "codexVersion", label: "Codex version", kind: "version" },
  { key: "protocolVersion", label: "Protocol", kind: "version" },
  { key: "containerImage", label: "Container image", kind: "runtime" },
  { key: "containerImageDigest", label: "Image digest", kind: "build" },
  { key: "buildSha", label: "Build sha", kind: "build" },
  { key: "buildTime", label: "Built", kind: "build" },
  { key: "startedAt", label: "Started", kind: "runtime" },
  { key: "provisionedAt", label: "Provisioned", kind: "runtime" },
  { key: "provisionStatus", label: "Provisioning", kind: "runtime" },
  { key: "transport", label: "Transport", kind: "runtime" },
  { key: "authMode", label: "Auth", kind: "auth" },
  { key: "hostId", label: "Host id", kind: "host" },
  { key: "hostname", label: "Hostname", kind: "host" },
  { key: "os", label: "OS", kind: "host" },
  { key: "arch", label: "Arch", kind: "host" },
  { key: "nodeVersion", label: "Node", kind: "version" },
  { key: "workspaceRoot", label: "Workspace root", kind: "path" },
  { key: "codexHome", label: "Codex home", kind: "path" },
];

const FIELD_BY_KEY = new Map(STRING_FIELDS.map((field) => [field.key, field]));

const SECRET_KEY_RE = /(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|auth[_-]?json)/i;
const SAFE_DETAIL_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function cleanKey(key: string): string | null {
  const trimmed = key.trim();
  if (!SAFE_DETAIL_KEY_RE.test(trimmed)) return null;
  if (SECRET_KEY_RE.test(trimmed)) return null;
  return trimmed;
}

function cleanValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const raw = String(value).trim().replace(/[\r\n\t]+/g, " ");
    if (!raw) return null;
    const redacted = raw
      .replace(/Bearer\s+[^\s,)]+/gi, "Bearer [redacted]")
      .replace(/(authorization\s*[:=]\s*)[^\s,)]+/gi, "$1[redacted]")
      .replace(/([?&](?:token|key|secret|api_key|access_token)=)[^\s&#)]+/gi, "$1[redacted]");
    return redacted.length > MAX_VALUE_LENGTH
      ? `${redacted.slice(0, MAX_VALUE_LENGTH - 3)}...`
      : redacted;
  }
  return null;
}

function putString(out: Record<string, Prisma.JsonValue>, key: string, value: unknown): void {
  if (!FIELD_BY_KEY.has(key) || SECRET_KEY_RE.test(key)) return;
  const clean = cleanValue(value);
  if (clean) out[key] = clean;
}

function putRecord(
  out: Record<string, Prisma.JsonValue>,
  targetKey: "versions" | "details",
  value: unknown,
): void {
  const record = asRecord(value);
  if (!record) return;
  const target: Record<string, Prisma.JsonValue> = {};
  for (const [rawKey, rawValue] of Object.entries(record).slice(0, MAX_DETAIL_FIELDS * 2)) {
    const key = cleanKey(rawKey);
    if (!key) continue;
    const valueString = cleanValue(rawValue);
    if (!valueString) continue;
    target[key] = valueString;
    if (Object.keys(target).length >= MAX_DETAIL_FIELDS) break;
  }
  if (Object.keys(target).length) out[targetKey] = target;
}

export function sanitizeRuntimeInfo(input: unknown): JsonObject | null {
  const record = asRecord(input);
  if (!record) return null;

  const out: Record<string, Prisma.JsonValue> = {};
  for (const field of STRING_FIELDS) putString(out, field.key, record[field.key]);

  const serverInfo = asRecord(record.serverInfo ?? record.server_info);
  if (serverInfo) {
    putString(out, "runtimeName", out.runtimeName ?? serverInfo.name);
    putString(out, "runtimeVersion", out.runtimeVersion ?? serverInfo.version);
  }

  putRecord(out, "versions", record.versions);
  putRecord(out, "details", record.details);

  if (!Object.keys(out).length) return null;
  return out as JsonObject;
}

export function runtimeInfoUpdateData(
  input: unknown,
  at = new Date(),
): Pick<Prisma.RuntimeUpdateInput, "runtimeInfo" | "lastInfoAt"> {
  const info = sanitizeRuntimeInfo(input);
  return info ? { runtimeInfo: info, lastInfoAt: at } : {};
}

export function runtimeInfoCreateData(
  input: unknown,
  at = new Date(),
): Pick<Prisma.RuntimeCreateInput, "runtimeInfo" | "lastInfoAt"> {
  const info = sanitizeRuntimeInfo(input);
  return info ? { runtimeInfo: info, lastInfoAt: at } : {};
}

export function summarizeRuntimeInfo(input: {
  runtimeInfo: Prisma.JsonValue | null | undefined;
  lastInfoAt: Date | string | null | undefined;
}): RuntimeInfoSummary {
  const info = asRecord(input.runtimeInfo);
  if (!info) {
    return {
      status: "missing",
      label: "no runtime info",
      detail: "This runtime has not reported its host, bridge, or version metadata yet.",
      lastReportedAt: input.lastInfoAt ?? null,
      fields: [],
    };
  }

  const fields: RuntimeInfoField[] = [];
  for (const spec of STRING_FIELDS) {
    const value = cleanValue(info[spec.key]);
    if (value) fields.push({ ...spec, value });
  }

  const versions = asRecord(info.versions);
  if (versions) {
    for (const [key, value] of Object.entries(versions)) {
      const clean = cleanValue(value);
      if (clean) fields.push({ key: `versions.${key}`, label: key, value: clean, kind: "version" });
    }
  }

  const details = asRecord(info.details);
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      const clean = cleanValue(value);
      if (clean) fields.push({ key: `details.${key}`, label: key, value: clean, kind: "runtime" });
    }
  }

  const bridge = cleanValue(info.bridgeVersion) || cleanValue(info.bridgeName);
  const runtime = cleanValue(info.runtimeVersion) || cleanValue(info.runtimeName);
  const codex = cleanValue(info.codexVersion);
  const label = codex
    ? `Codex ${codex}`
    : bridge
      ? `Bridge ${bridge}`
      : runtime
        ? `Runtime ${runtime}`
        : "runtime info reported";

  return {
    status: "reported",
    label,
    detail: input.lastInfoAt
      ? "Reported by the runtime host."
      : "Runtime host metadata is available, but no report timestamp was recorded.",
    lastReportedAt: input.lastInfoAt ?? null,
    fields,
  };
}

export function extractRuntimeInfoFromInitializeResult(
  result: unknown,
  defaults: Record<string, unknown> = {},
): JsonObject | null {
  const record = asRecord(result);
  if (!record) return sanitizeRuntimeInfo(defaults);
  const serverInfo = asRecord(record.serverInfo ?? record.server_info);
  const runtimeInfo = asRecord(record.runtimeInfo ?? record.runtime_info);
  return sanitizeRuntimeInfo({
    ...defaults,
    ...(runtimeInfo ?? {}),
    serverInfo,
    runtimeName: runtimeInfo?.runtimeName ?? serverInfo?.name,
    runtimeVersion: runtimeInfo?.runtimeVersion ?? serverInfo?.version,
    protocolVersion: record.protocolVersion ?? record.protocol_version,
  });
}
