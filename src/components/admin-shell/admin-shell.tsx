"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Layers,
  Users,
  Bot,
  Server,
  FileText,
  Settings,
  Shield,
  ChevronRight,
  ChevronLeft,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Instance-admin shell — the third of Forge's three shells. Distinct
 * cooler graphite tone so it reads as "instance, not tenant", with an
 * instance-scope warning bar. Ports `AdminPage`/`AdminSidebar` from the
 * design handoff. Only reachable by INSTANCE_ADMIN (gated in the route
 * layout). Part of the multi-workspace restructure.
 */

const ADMIN_NAV: { href: string; icon: LucideIcon; label: string; hint: string }[] = [
  { href: "/admin", icon: LayoutDashboard, label: "Overview", hint: "Health & license" },
  { href: "/admin/tenants", icon: Layers, label: "Workspaces", hint: "All tenants" },
  { href: "/admin/users", icon: Users, label: "Users", hint: "Across instance" },
  { href: "/admin/agents", icon: Bot, label: "Agent policy", hint: "Shared & disabled" },
  { href: "/admin/runtimes", icon: Server, label: "Runtimes", hint: "Instance-wide" },
  { href: "/admin/audit", icon: FileText, label: "Audit log", hint: "Cross-tenant" },
  { href: "/admin/system", icon: Settings, label: "System", hint: "Build, regions" },
];

function AdminSidebar({ activePath, instanceUrl }: { activePath: string; instanceUrl: string }) {
  return (
    <aside
      className="flex h-full w-60 shrink-0 flex-col border-r"
      style={{
        background: "linear-gradient(180deg, hsl(var(--admin-surface)) 0%, hsl(var(--admin-bg)) 100%)",
        color: "hsl(var(--admin-text-hi))",
        borderColor: "var(--admin-border-strong)",
        minWidth: 240,
      }}
    >
      <div className="px-3 pb-3 pt-3" style={{ borderBottom: "1px solid var(--admin-border-strong)" }}>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex h-7 w-7 items-center justify-center rounded-md"
            style={{ background: "hsl(var(--ember))", color: "hsl(var(--ember-foreground))" }}
          >
            <Shield size={14} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight" style={{ color: "hsl(var(--admin-text))" }}>
              Instance admin
            </div>
            <div className="truncate text-[10px]" style={{ color: "hsl(var(--admin-text-muted))" }}>
              {instanceUrl}
            </div>
          </div>
        </div>
      </div>

      <nav className="mt-2 flex flex-1 flex-col gap-px px-2">
        {ADMIN_NAV.map((it) => {
          const active = activePath === it.href;
          const Ico = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors"
              style={{
                background: active ? "rgba(217,119,87,0.16)" : "transparent",
                color: active ? "hsl(var(--admin-text))" : "hsl(var(--admin-text-soft))",
              }}
            >
              <Ico size={13} style={{ color: active ? "hsl(var(--ember))" : "currentColor" }} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-tight">{it.label}</span>
                <span className="block text-[10px] leading-tight" style={{ color: "hsl(var(--admin-text-dim))" }}>
                  {it.hint}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="px-2 pb-3 pt-2" style={{ borderTop: "1px solid var(--admin-border-strong)" }}>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]"
          style={{ color: "hsl(var(--admin-text-soft))" }}
        >
          <ChevronLeft size={13} />
          <span className="flex-1">Back to Mission Control</span>
        </Link>
      </div>
    </aside>
  );
}

export function AdminPage({
  activePath,
  crumbs = ["Instance"],
  title,
  subtitle,
  eyebrow,
  actions,
  version,
  buildSha,
  instanceUrl = "self-hosted",
  contentClass = "overflow-y-auto",
  children,
}: {
  activePath?: string;
  crumbs?: string[];
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  version?: string | null;
  buildSha?: string | null;
  instanceUrl?: string;
  contentClass?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = activePath ?? pathname ?? "/admin";
  return (
    <div className="flex h-svh w-full overflow-hidden" style={{ background: "hsl(var(--admin-bg))", color: "hsl(var(--admin-text-hi))" }}>
      <AdminSidebar activePath={active} instanceUrl={instanceUrl} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "hsl(var(--admin-surface))" }}>
        <header
          className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
          style={{ background: "hsl(var(--admin-topbar))", borderColor: "var(--admin-border-strong)", color: "hsl(var(--admin-text-hi))" }}
        >
          <nav className="flex items-center gap-1 text-meta" style={{ color: "hsl(var(--admin-text-muted))" }}>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={11} className="opacity-60" />}
                <span style={i === crumbs.length - 1 ? { color: "hsl(var(--admin-text))" } : undefined}>{c}</span>
              </span>
            ))}
          </nav>
          <span
            className="ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta"
            style={{ background: "rgba(217,119,87,0.16)", color: "hsl(var(--ember))" }}
          >
            <Shield size={10} />
            Instance scope · writes affect every tenant
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-meta" style={{ color: "hsl(var(--admin-text-muted))" }}>
              v{version ?? "dev"}
              {buildSha ? ` · ${buildSha}` : ""}
            </span>
          </div>
        </header>

        {title && (
          <header
            className="flex shrink-0 items-end gap-4 border-b px-8 pb-5 pt-5"
            style={{ background: "hsl(var(--admin-tile))", borderColor: "var(--admin-border-strong)", color: "hsl(var(--admin-text))" }}
          >
            <div className="min-w-0 flex-1">
              {eyebrow && (
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: "hsl(var(--admin-text-dim))" }}>
                  {eyebrow}
                </div>
              )}
              <h1 className="mt-0.5 truncate text-xl font-semibold tracking-tight">{title}</h1>
              {subtitle && (
                <p className="mt-1 truncate text-sm" style={{ color: "hsl(var(--admin-text-soft))" }}>
                  {subtitle}
                </p>
              )}
            </div>
            {actions && <div className="flex items-center gap-1.5">{actions}</div>}
          </header>
        )}

        <div className={cn("min-h-0 flex-1", contentClass)}>{children}</div>
      </main>
    </div>
  );
}
