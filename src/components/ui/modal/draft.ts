/**
 * Draft-state persistence for modal primitives.
 *
 * Small, typed wrapper around `localStorage` with a common prefix and a
 * 24-hour TTL. Any value written via `saveDraft` that's older than the
 * TTL is treated as absent by `readDraft` (and GC'd on read).
 *
 * Used by <QuickForm> and the floating quick-create input so that
 * accidentally dismissed forms don't lose work.
 */

const PREFIX = "forge.draft.";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

type DraftEnvelope<T> = {
  value: T;
  savedAt: number; // epoch ms
};

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Persist `value` under `forge.draft.<key>` with a `savedAt` timestamp.
 * Best-effort — silently swallows storage errors (quota, privacy mode, SSR).
 */
export function saveDraft<T>(key: string, value: T): void {
  const ls = storage();
  if (!ls) return;
  try {
    const envelope: DraftEnvelope<T> = { value, savedAt: Date.now() };
    ls.setItem(PREFIX + key, JSON.stringify(envelope));
  } catch {
    /* noop */
  }
}

/**
 * Read and return the draft for `key` if it exists and is fresher than
 * 24h. Stale or malformed entries are removed and `null` is returned.
 */
export function readDraft<T>(key: string): T | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftEnvelope<T>;
    if (
      !parsed ||
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > TTL_MS
    ) {
      ls.removeItem(PREFIX + key);
      return null;
    }
    return parsed.value;
  } catch {
    try {
      ls.removeItem(PREFIX + key);
    } catch {
      /* noop */
    }
    return null;
  }
}

/**
 * Remove the draft for `key`. Safe to call whether or not a draft exists.
 */
export function clearDraft(key: string): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(PREFIX + key);
  } catch {
    /* noop */
  }
}
