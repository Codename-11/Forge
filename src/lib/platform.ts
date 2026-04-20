"use client";
import { useEffect, useState } from "react";

/**
 * True when the current browser reports a Mac platform. Falls back to false
 * on the server so SSR output matches non-Mac clients (keeps hydration
 * stable for the majority and corrects on mount).
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    // `userAgentData.platform` is the modern API; `platform` is the fallback.
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
    setIsMac(/mac/i.test(platform));
  }, []);
  return isMac;
}

/** Display string for the meta modifier on the current platform. */
export function useModKeyLabel(): string {
  const isMac = useIsMac();
  return isMac ? "⌘" : "Ctrl";
}
