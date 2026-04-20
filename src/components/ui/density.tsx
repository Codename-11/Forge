"use client";
import * as React from "react";

export type Density = "compact" | "comfortable";

const STORAGE_KEY = "forge.density";
const DEFAULT_DENSITY: Density = "comfortable";

const DensityContext = React.createContext<Density>(DEFAULT_DENSITY);
const DensitySetContext = React.createContext<(d: Density) => void>(() => {});

/**
 * Provides the current list density ("compact" | "comfortable") to
 * descendants. Persists to `localStorage` under `forge.density` and
 * hydrates lazily (SSR-safe — server render defaults to `comfortable`).
 *
 * Wrap the app shell once; individual lists read via {@link useDensity}.
 */
export function DensityProvider({
  value,
  children,
}: {
  /** Optional controlled value. If omitted, hydrates from localStorage. */
  value?: Density;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = React.useState<Density>(value ?? DEFAULT_DENSITY);

  // Hydrate from localStorage once on mount (uncontrolled mode).
  React.useEffect(() => {
    if (value !== undefined) return;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "compact" || stored === "comfortable") {
        setInternal(stored);
      }
    } catch {
      // localStorage unavailable — keep default.
    }
  }, [value]);

  const set = React.useCallback((next: Density) => {
    setInternal(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const current = value ?? internal;

  return (
    <DensityContext.Provider value={current}>
      <DensitySetContext.Provider value={set}>{children}</DensitySetContext.Provider>
    </DensityContext.Provider>
  );
}

/**
 * Read the current density. Returns `"comfortable"` by default.
 */
export function useDensity(): Density {
  return React.useContext(DensityContext);
}

/**
 * Setter paired with {@link useDensity}. Use to wire a toggle button.
 */
export function useSetDensity(): (d: Density) => void {
  return React.useContext(DensitySetContext);
}
