"use client";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CREW_ROLE_ORDER,
  ROLE_META,
  roleTone,
  type CrewRole,
} from "@/components/crews/role-chip";

/**
 * Role picker as a list of selectable cards — each role shows what it
 * actually does so the operator isn't guessing from a bare dropdown.
 * Single-select; mirrors the warm-earthy form controls used elsewhere.
 */
export function RolePicker({
  value,
  onChange,
  className,
}: {
  value: CrewRole;
  onChange: (role: CrewRole) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} role="radiogroup">
      {CREW_ROLE_ORDER.map((role) => {
        const meta = ROLE_META[role];
        const selected = value === role;
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(role)}
            className={cn(
              "focus-ring flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition",
              selected
                ? "border-ember/50 bg-ember/5"
                : "border-border bg-card/40 hover:border-ember/30 hover:bg-subtle",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                selected ? "border-ember bg-ember text-ember-foreground" : "border-border",
              )}
            >
              {selected ? <Check className="h-3 w-3" /> : null}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{meta.label}</span>
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px] uppercase tracking-wide",
                    roleTone(role),
                  )}
                >
                  {role.toLowerCase().replace(/_/g, " ")}
                </span>
              </span>
              <span className="mt-0.5 block text-meta text-muted-foreground">
                {meta.summary}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
