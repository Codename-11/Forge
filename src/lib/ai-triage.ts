/**
 * Technical lease for a single small (512-token) triage completion. This is
 * not a workspace policy knob: it only bounds ownership of an in-flight
 * background claim so a process exit cannot strand PENDING forever.
 */
export const AI_TRIAGE_PENDING_LEASE_MS = 5 * 60 * 1000;

export function isAiTriagePendingStale(
  startedAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (!startedAt) return true;
  const timestamp = new Date(startedAt).getTime();
  return !Number.isFinite(timestamp) || now - timestamp >= AI_TRIAGE_PENDING_LEASE_MS;
}
