"use client";
import { createContext, useCallback, useMemo, useState, useContext } from "react";

export interface ChatContextSnapshot {
  route?: string;
  slug?: string;
  issueId?: string;
  selectedIds?: string[];
  visibleEntities?: { kind: string; ids: string[] }[];
  pinnedRunIds?: string[];
  liveRunIds?: string[];
}

interface ChatContextRegistryValue {
  /** Accumulated state from page-level setters. */
  registered: ChatContextSnapshot;
  /** Page components call this to advertise context. Returns an unregister fn. */
  register: (id: string, snapshot: ChatContextSnapshot) => () => void;
}

const Ctx = createContext<ChatContextRegistryValue | null>(null);

export function ChatContextProvider({ children }: { children: React.ReactNode }) {
  // Map of registration-id → snapshot. Pages register/unregister on mount/unmount.
  const [registry, setRegistry] = useState<Record<string, ChatContextSnapshot>>({});

  const register = useCallback((id: string, snapshot: ChatContextSnapshot) => {
    setRegistry((prev) => ({ ...prev, [id]: snapshot }));
    return () => {
      setRegistry((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    };
  }, []);

  // Merge all registrations into a single snapshot. Last-writer-wins per
  // field, but selectedIds / visibleEntities concat to capture multi-source.
  const merged = useMemo<ChatContextSnapshot>(() => {
    const out: ChatContextSnapshot = {};
    for (const id of Object.keys(registry)) {
      const r = registry[id];
      if (r.route) out.route = r.route;
      if (r.slug) out.slug = r.slug;
      if (r.issueId) out.issueId = r.issueId;
      if (r.selectedIds?.length) out.selectedIds = [...(out.selectedIds ?? []), ...r.selectedIds];
      if (r.pinnedRunIds?.length) out.pinnedRunIds = [...(out.pinnedRunIds ?? []), ...r.pinnedRunIds];
      if (r.liveRunIds?.length) out.liveRunIds = [...(out.liveRunIds ?? []), ...r.liveRunIds];
      if (r.visibleEntities?.length) out.visibleEntities = [...(out.visibleEntities ?? []), ...r.visibleEntities];
    }
    return out;
  }, [registry]);

  const value = useMemo<ChatContextRegistryValue>(
    () => ({ registered: merged, register }),
    [merged, register],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatContextRegistry(): ChatContextRegistryValue {
  const v = useContext(Ctx);
  if (!v) {
    return {
      registered: {},
      register: () => () => {
        /* noop */
      },
    };
  }
  return v;
}
