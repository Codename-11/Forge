import Link from "next/link";
import { PlugZap, Server, type LucideIcon } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Card } from "@/components/settings/card";
import { Section } from "@/components/settings/section";
import { ACCOUNT_SETTINGS_GROUP } from "@/components/settings/settings-nav";

const RESOURCES = [
  {
    href: "/settings/runtimes",
    label: "Runtime inventory",
    hint: "Hosts you own, their health, and their authoritative home workspace.",
    icon: Server,
  },
  {
    href: "/settings/connections",
    label: "Connected accounts",
    hint: "OAuth identities that workspace integration mappings can use.",
    icon: PlugZap,
  },
] as const;

function OverviewLink({
  href,
  label,
  hint,
  icon: Icon,
}: {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <li>
      <Link
        href={href}
        className="focus-ring group flex items-start gap-3 px-4 py-3 hover:bg-subtle/60"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-ember" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
        </span>
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
      </Link>
    </li>
  );
}

export default function PersonalSettingsOverview() {
  return (
    <>
      <Topbar title="Settings" subtitle="Personal · follows you across every workspace" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
          <Section title="Personal" hint="Preferences and workspace directory tied to your login.">
            <Card>
              {ACCOUNT_SETTINGS_GROUP.items.map((item) => (
                <OverviewLink
                  key={item.path}
                  href={item.path}
                  label={item.label}
                  hint={item.description}
                  icon={item.icon}
                />
              ))}
            </Card>
          </Section>
          <Section
            title="Resources"
            hint="Runtime hosts and connected accounts tied to your login."
          >
            <Card>
              {RESOURCES.map((item) => (
                <OverviewLink key={item.href} {...item} />
              ))}
            </Card>
          </Section>
        </div>
      </div>
    </>
  );
}
