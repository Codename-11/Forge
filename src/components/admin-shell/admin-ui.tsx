"use client";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Shared graphite-styled primitives for the instance-admin (`/admin`)
 * content surfaces. The admin shell intentionally uses explicit graphite
 * hsl() colors instead of the warm tenant tokens (see admin-shell.tsx and
 * the design handoff `InstanceAdminScreen`) — these helpers keep that
 * palette in one place so the individual pages stay declarative.
 * Part of the multi-workspace restructure.
 */

export const ADMIN = {
  panel: "hsl(220 10% 17%)",
  tile: "hsl(220 10% 18%)",
  border: "rgba(255,255,255,0.06)",
  borderRow: "rgba(255,255,255,0.04)",
  text: "hsl(40 12% 95%)",
  textMuted: "hsl(40 8% 65%)",
  textDim: "hsl(40 8% 60%)",
  textSoft: "hsl(40 8% 70%)",
  ember: "hsl(var(--ember))",
} as const;

export function tileTone(tone?: "danger" | "warning" | "success" | "default") {
  return tone === "danger"
    ? "hsl(var(--danger))"
    : tone === "warning"
      ? "hsl(var(--warning))"
      : tone === "success"
        ? "hsl(var(--success))"
        : ADMIN.text;
}

/** Top-of-overview metric tile. Ports `AdminMetricTile`. */
export function AdminMetricTile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon?: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warning" | "success" | "default";
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg p-4"
      style={{ background: ADMIN.tile, border: `1px solid ${ADMIN.border}` }}
    >
      <div className="flex items-center justify-between text-meta" style={{ color: ADMIN.textMuted }}>
        <span className="inline-flex items-center gap-1.5">
          {Icon && <Icon size={11} />}
          {label}
        </span>
      </div>
      <div
        className="text-[1.5rem] font-semibold leading-none tracking-tight tabular-nums"
        style={{ color: tileTone(tone) }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-meta" style={{ color: ADMIN.textDim }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** A bordered graphite panel with an optional header row. */
export function AdminPanel({
  title,
  hint,
  actions,
  className,
  bodyClassName,
  children,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg overflow-hidden ${className ?? ""}`}
      style={{ background: ADMIN.panel, border: `1px solid ${ADMIN.border}` }}
    >
      {(title || actions) && (
        <header
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: `1px solid ${ADMIN.border}` }}
        >
          {title && (
            <h2 className="text-sm font-semibold tracking-tight" style={{ color: ADMIN.text }}>
              {title}
            </h2>
          )}
          {hint && (
            <span className="text-meta" style={{ color: ADMIN.textMuted }}>
              {hint}
            </span>
          )}
          {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Centered spinner block for query loading states. */
export function AdminLoading({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-meta" style={{ color: ADMIN.textMuted }}>
      <Spinner size="md" />
      {label && <span>{label}</span>}
    </div>
  );
}

/** Empty/zero-state row inside a panel. */
export function AdminEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-meta" style={{ color: ADMIN.textMuted }}>
      {children}
    </div>
  );
}

/** Small ghost button styled for the graphite chrome. */
export function AdminButton({
  children,
  onClick,
  icon: Icon,
  tone = "default",
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: LucideIcon;
  tone?: "default" | "ember" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const styles =
    tone === "ember"
      ? { background: "rgba(217,119,87,0.16)", color: ADMIN.ember, border: "1px solid rgba(217,119,87,0.3)" }
      : tone === "danger"
        ? { background: "rgba(239,68,68,0.12)", color: "hsl(var(--danger))", border: "1px solid rgba(239,68,68,0.3)" }
        : { background: "rgba(255,255,255,0.04)", color: ADMIN.textSoft, border: `1px solid ${ADMIN.border}` };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-meta font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
      style={styles}
    >
      {Icon && <Icon size={11} />}
      {children}
    </button>
  );
}

/** Date → short relative string for feeds/tables. */
export function relTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d`;
  return t.toISOString().slice(0, 10);
}
