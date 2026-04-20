import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { EmptyState as UiEmptyState } from "@/components/ui/empty-state";

/**
 * Backward-compat shim for the original settings-page EmptyState.
 *
 * New code should import `EmptyState` from `@/components/ui` directly
 * — it takes `icon` as a ReactNode and supports size variants. This
 * shim keeps the prior API (`icon` as a Lucide component + `hint`)
 * alive for existing call-sites until Agent 4 retrofits them.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  as = "li",
}: {
  icon?: ComponentType<LucideProps>;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  as?: "li" | "div";
}) {
  return (
    <UiEmptyState
      variant="section"
      as={as}
      icon={Icon ? <Icon /> : undefined}
      title={title}
      description={hint}
      action={action}
    />
  );
}
