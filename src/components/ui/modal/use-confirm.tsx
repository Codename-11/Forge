"use client";
import * as React from "react";
import { Confirm } from "./confirm";

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  primaryLabel?: string;
  secondaryLabel?: string;
  variant?: "default" | "destructive";
  /** Only honored when variant is "destructive". */
  typeToConfirm?: string;
};

/**
 * Imperative wrapper over <Confirm> so call-sites read like
 *   if (await confirm({ title: "Delete?", variant: "destructive" })) { … }
 * instead of reaching for the native `window.confirm`. Render the returned
 * `confirmElement` once in the component tree.
 */
export function useConfirm() {
  const [state, setState] = React.useState<
    (ConfirmOptions & { resolve: (v: boolean) => void }) | null
  >(null);

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );

  const settle = React.useCallback((value: boolean) => {
    setState((s) => {
      s?.resolve(value);
      return null;
    });
  }, []);

  const confirmElement = state ? (
    <Confirm
      open
      onOpenChange={(o) => {
        if (!o) settle(false);
      }}
      title={state.title}
      description={state.description}
      primaryLabel={state.primaryLabel ?? "Confirm"}
      secondaryLabel={state.secondaryLabel}
      variant={state.variant}
      typeToConfirm={state.typeToConfirm}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, confirmElement };
}
