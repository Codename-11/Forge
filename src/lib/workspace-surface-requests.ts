import type { QuickCreateOverride } from "@/components/quick-create";

type QuickCreateListener = (request: QuickCreateOverride) => void;

const quickCreateListeners = new Set<QuickCreateListener>();
let pendingQuickCreate: QuickCreateOverride | null = null;

/** Preserve a first-open request even when the lazy surface has not hydrated yet. */
export function requestQuickCreate(request: QuickCreateOverride = {}): void {
  if (quickCreateListeners.size === 0) {
    pendingQuickCreate = request;
    return;
  }
  for (const listener of quickCreateListeners) listener(request);
}

export function subscribeQuickCreate(listener: QuickCreateListener): () => void {
  quickCreateListeners.add(listener);
  if (pendingQuickCreate) {
    const request = pendingQuickCreate;
    pendingQuickCreate = null;
    listener(request);
  }
  return () => quickCreateListeners.delete(listener);
}
