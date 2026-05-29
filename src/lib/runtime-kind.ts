import type { RuntimeKind } from "@prisma/client";

/**
 * Human-readable labels for the `RuntimeKind` enum. The raw enum
 * (`REMOTE_HTTP`, `LOCAL_DAEMON`, …) leaks into user-facing strings if
 * used directly — and its embedded underscore even breaks markdown
 * emphasis when wrapped in `_…_`. Single source of truth so the
 * settings UI, Mission Control, and the assignment system-comment in
 * `audit.ts` stay in sync.
 */
export const RUNTIME_KIND_LABEL: Record<RuntimeKind, string> = {
  LOCAL_DAEMON: "local daemon",
  REMOTE_HTTP: "remote webhook",
  CLOUD: "cloud",
};

export function runtimeKindLabel(kind: RuntimeKind | null | undefined): string {
  return kind ? (RUNTIME_KIND_LABEL[kind] ?? String(kind)) : "unknown";
}
