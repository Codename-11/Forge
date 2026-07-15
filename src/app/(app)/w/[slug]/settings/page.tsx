"use client";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { WORKSPACE_SETTINGS_GROUPS, type SettingsNavItem } from "@/components/settings/settings-nav";
import { User } from "lucide-react";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";

/**
 * Workspace settings landing. Renders the grouped index from the single
 * source of truth in `settings-nav.ts` — the same list the
 * {@link SettingsRail} uses — followed by the account-level group as a
 * cross-link. Add or move a settings surface in `settings-nav.ts` and both
 * this page and the rail update together.
 */
function EntryRow({ href, item }: { href: string; item: SettingsNavItem }) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-start gap-4 px-4 py-3 hover:bg-subtle/60"
      >
        <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-ember" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{item.label}</span>
            {item.badge && (
              <span className="rounded border border-ember/30 bg-ember/10 px-1.5 py-0.5 text-[0.6875rem] uppercase tracking-wider text-ember">
                {item.badge}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{item.description}</div>
        </div>
        <span className="mt-1 text-muted-foreground transition-colors group-hover:text-ember">
          →
        </span>
      </Link>
    </li>
  );
}

export default function SettingsPage() {
  const ws = useWorkspace();
  const w = (p: string) => `/w/${ws.slug}/settings${p}`;

  return (
    <>
      <Topbar title="Settings" subtitle={`${ws.name} · workspace configuration`} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
          {WORKSPACE_SETTINGS_GROUPS.map((group) => (
            <Section key={group.id} title={group.label} hint={group.hint}>
              <Card>
                {group.items.map((item) => (
                  <EntryRow key={item.path} href={w(item.path)} item={item} />
                ))}
              </Card>
            </Section>
          ))}

          <Section title="Personal" hint="A separate scope: these changes follow you across workspaces.">
            <Card as="div" className="p-4">
              <Link href="/settings" className="focus-ring flex items-start gap-3 rounded-md p-2 hover:bg-subtle/60">
                <User className="mt-0.5 h-4 w-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Open personal settings</span>
                  <span className="mt-1 block text-xs text-muted-foreground">Profile, appearance, connected accounts, owned agent profiles, and runtime inventory.</span>
                </span>
                <span aria-hidden>→</span>
              </Link>
            </Card>
          </Section>

          <AboutFooter slug={ws.slug} />
        </div>
      </div>
    </>
  );
}

/** Build identity — precise "what's running" anchor for support / bug reports. */
function AboutFooter({ slug }: { slug: string }) {
  const { data: build } = trpc.system.buildInfo.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const parts = [
    `Forge v${build?.version ?? "—"}`,
    build?.release ? `release ${build.release}` : null,
    build?.gitSha ? `build ${build.gitSha}` : "build dev",
    build?.buildTime ? new Date(build.buildTime).toLocaleString() : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2 text-meta text-muted-foreground/70">
      <span className="font-mono">{parts.join(" · ")}</span>
      <Link
        href={`/w/${slug}/whats-new`}
        className="hover:text-foreground hover:underline"
      >
        What&apos;s new →
      </Link>
    </div>
  );
}
