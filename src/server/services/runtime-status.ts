import "server-only";
import type { RuntimeKind } from "@prisma/client";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";

export type RuntimeHealthKind =
  | "online"
  | "stale"
  | "disabled"
  | "archived"
  | "never_seen"
  | "probe_failed"
  | "probe_not_configured";

export type RuntimeHealthTone = "success" | "warning" | "danger" | "muted";

export interface RuntimeHealthStatus {
  kind: RuntimeHealthKind;
  label: string;
  tone: RuntimeHealthTone;
  reason: string;
  lastSignal: string;
  adapter: string;
  endpoint: string | null;
  probeSupported: boolean;
  sweepCovered: boolean;
  sweepExpectation: string;
}

export interface RuntimeHealthInput {
  kind: RuntimeKind;
  adapterKey: string | null;
  endpoint: string | null;
  archivedAt: Date | string | null;
  disabledAt: Date | string | null;
  heartbeatAt: Date | string | null;
  connectedAt?: Date | string | null;
  lastProbeAt: Date | string | null;
  lastProbeAttempted: boolean | null;
  lastProbeReachable: boolean | null;
  lastProbeDetail: string | null;
}

export const RUNTIME_HEARTBEAT_ONLINE_MS = 5 * 60 * 1000;

const SUPPORTED_PROBE_ADAPTERS = new Set(["hermes", "codex-app-server"]);

export function supportsRuntimeProbe(adapterKey: string | null | undefined): boolean {
  return !!adapterKey && SUPPORTED_PROBE_ADAPTERS.has(adapterKey);
}

export function sanitizeRuntimeProbeDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const sanitized = detail
    .replace(/Bearer\s+[^\s,)]+/gi, "Bearer [redacted]")
    .replace(/(authorization\s*[:=]\s*)[^\s,)]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|secret|api_key|access_token)=)[^\s&#)]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return sanitized.length > 320 ? `${sanitized.slice(0, 317)}…` : sanitized;
}

function asDate(input: Date | string | null | undefined): Date | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function rel(input: Date | string | null | undefined, now: Date): string | null {
  const d = asDate(input);
  if (!d) return null;
  const diffMs = Math.max(0, now.getTime() - d.getTime());
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sweepExpectationFor(input: RuntimeHealthInput): { covered: boolean; text: string } {
  const adapter = getRuntimeAdapter(input.adapterKey);
  if (!input.endpoint) {
    return { covered: false, text: "Not swept: no endpoint is configured." };
  }
  if (!adapter) {
    return { covered: false, text: "Not swept: runtime adapter is unknown." };
  }
  if (adapter.transport === "app-server" && adapter.capabilities.presence === "runtime-heartbeat") {
    return { covered: true, text: "Swept by the runtime health worker." };
  }
  if (adapter.key === "hermes") {
    return {
      covered: true,
      text: "Swept by the runtime health worker; Hermes presence still comes from agent heartbeat / forge-presence or webhook delivery.",
    };
  }
  if (adapter.capabilities.presence === "runtime-heartbeat") {
    return { covered: false, text: "Not swept: this adapter heartbeats or connects inbound." };
  }
  return { covered: false, text: "Not swept: this adapter uses session or delivery-derived presence." };
}

function signalFor(input: RuntimeHealthInput, now: Date): string {
  const beat = rel(input.heartbeatAt, now);
  const probe = rel(input.lastProbeAt, now);
  const connected = rel(input.connectedAt, now);
  const parts: string[] = [];
  if (beat) parts.push(`heartbeat ${beat}`);
  if (probe) {
    const result = input.lastProbeAttempted
      ? input.lastProbeReachable === true
        ? "probe reachable"
        : input.lastProbeReachable === false
          ? "probe failed"
          : "probe unknown"
      : "probe not attempted";
    parts.push(`${result} ${probe}`);
  }
  if (connected) parts.push(`connected ${connected}`);
  return parts.length ? parts.join(" · ") : "No heartbeat or probe has been recorded.";
}

export function deriveRuntimeHealthStatus(
  input: RuntimeHealthInput,
  opts: { now?: Date; onlineMs?: number } = {},
): RuntimeHealthStatus {
  const now = opts.now ?? new Date();
  const onlineMs = opts.onlineMs ?? RUNTIME_HEARTBEAT_ONLINE_MS;
  const adapter = getRuntimeAdapter(input.adapterKey);
  const adapterLabel = adapter?.title ?? input.adapterKey ?? input.kind.toLowerCase().replace("_", " ");
  const probeSupported = supportsRuntimeProbe(input.adapterKey);
  const sweep = sweepExpectationFor(input);
  const heartbeatAt = asDate(input.heartbeatAt);
  const heartbeatFresh = !!heartbeatAt && now.getTime() - heartbeatAt.getTime() < onlineMs;
  const failedProbe = input.lastProbeAttempted === true && input.lastProbeReachable === false;
  const successfulProbe = input.lastProbeAttempted === true && input.lastProbeReachable === true;
  const probeDetail = sanitizeRuntimeProbeDetail(input.lastProbeDetail);
  const lastSignal = signalFor(input, now);

  if (input.archivedAt) {
    return {
      kind: "archived",
      label: "archived",
      tone: "muted",
      reason: "Runtime is archived and hidden from active dispatch.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  if (input.disabledAt) {
    return {
      kind: "disabled",
      label: "disabled",
      tone: "danger",
      reason: "Runtime is disabled; dispatch and chat will refuse to dial it until re-enabled.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  if (failedProbe) {
    return {
      kind: "probe_failed",
      label: "probe failed",
      tone: "danger",
      reason: probeDetail ?? "Last handshake probe failed.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  if (heartbeatFresh) {
    return {
      kind: "online",
      label: "online",
      tone: "success",
      reason: successfulProbe
        ? "Fresh heartbeat and the last handshake probe succeeded."
        : "Fresh runtime heartbeat received.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  if (heartbeatAt) {
    return {
      kind: "stale",
      label: "stale / offline",
      tone: "warning",
      reason: successfulProbe
        ? adapter?.key === "hermes"
          ? "Gateway handshake passed, but the Hermes presence heartbeat is stale. Check forge-presence, agent heartbeat, or webhook delivery."
          : "Last heartbeat is stale even though the last handshake probe succeeded. Check the runtime health worker and heartbeat propagation."
        : "Last runtime heartbeat is stale.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  if (!probeSupported || !input.endpoint) {
    return {
      kind: "probe_not_configured",
      label: "probe not configured",
      tone: "muted",
      reason: input.endpoint
        ? "No handshake probe is configured for this adapter; rely on adapter-specific delivery or session signals."
        : "No endpoint is configured, so Forge cannot run a handshake probe.",
      lastSignal,
      adapter: adapterLabel,
      endpoint: input.endpoint,
      probeSupported,
      sweepCovered: sweep.covered,
      sweepExpectation: sweep.text,
    };
  }
  return {
    kind: "never_seen",
    label: "never seen",
    tone: "warning",
    reason: successfulProbe
      ? adapter?.key === "hermes"
        ? "Gateway handshake passed, but no Hermes presence heartbeat has arrived yet. Check forge-presence, agent heartbeat, or webhook delivery."
        : "Handshake probe succeeded, but no runtime heartbeat has been recorded yet."
      : "No runtime heartbeat has been recorded yet.",
    lastSignal,
    adapter: adapterLabel,
    endpoint: input.endpoint,
    probeSupported,
    sweepCovered: sweep.covered,
    sweepExpectation: sweep.text,
  };
}
