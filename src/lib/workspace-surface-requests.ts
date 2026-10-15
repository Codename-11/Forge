import type { QuickCreateOverride } from "@/components/quick-create";

type QuickCreateListener = (request: QuickCreateOverride) => void;

const quickCreateListeners = new Set<QuickCreateListener>();
let pendingQuickCreate: QuickCreateOverride | null = null;

/** Read named creation intent consistently before and after lazy hydration. */
export function quickCreateRequestFromDataset(dataset: {
  quickCreateProject?: string;
  quickCreateMode?: string;
}): QuickCreateOverride {
  const modes = [
    "issue",
    "task",
    "project",
    "cycle",
    "initiative",
    "note",
    "artifact",
    "action-request",
  ];
  return {
    ...(dataset.quickCreateProject ? { projectId: dataset.quickCreateProject } : {}),
    ...(dataset.quickCreateMode && modes.includes(dataset.quickCreateMode)
      ? { mode: dataset.quickCreateMode as QuickCreateOverride["mode"] }
      : {}),
  };
}

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
