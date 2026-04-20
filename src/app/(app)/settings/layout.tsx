import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Key, Layers, User as UserIcon } from "lucide-react";
import { auth } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Account-level settings shell.
 *
 * This layout only applies to the *bare* `/settings/*` tree — workspace
 * settings live under `/w/[slug]/settings/*` and use the normal workspace
 * shell. Account settings are global to the user and get a simple two-column
 * chrome: a small nav column on the left, page content on the right, with
 * a back-link that returns to the user's last active workspace.
 */
export default async function AccountSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      lastWorkspaceId: true,
      memberships: {
        select: { workspace: { select: { slug: true, deletedAt: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const active =
    user?.memberships.map((m) => m.workspace).filter((w) => !w.deletedAt) ?? [];
  let backSlug: string | null = null;
  if (user?.lastWorkspaceId) {
    const last = await db.workspace.findUnique({
      where: { id: user.lastWorkspaceId },
      select: { slug: true, deletedAt: true },
    });
    if (last && !last.deletedAt) backSlug = last.slug;
  }
  if (!backSlug) backSlug = active[0]?.slug ?? null;

  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="flex h-svh w-56 flex-col border-r border-border bg-card/40">
        <div className="flex h-12 items-center gap-2 px-4">
          <Link
            href={backSlug ? `/w/${backSlug}/dashboard` : "/"}
            className="focus-ring flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{backSlug ? "Back to workspace" : "Home"}</span>
          </Link>
        </div>

        <div className="mt-2 px-3 text-[10px] uppercase tracking-wider text-muted-foreground">
          Account
        </div>
        <nav className="mt-1 flex flex-col gap-px px-2">
          <NavLink href="/settings/account" label="Profile" Icon={UserIcon} />
          <NavLink href="/settings/access" label="Developer access" Icon={Key} />
          <NavLink href="/settings/workspaces" label="Workspaces" Icon={Layers} />
        </nav>

        <div className="mt-auto px-4 py-3 text-[10px] text-muted-foreground">
          Signed in as <span className="font-medium">{session.user.email}</span>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      className="row h-7 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-subtle hover:text-foreground"
    >
      <Icon className="mr-2 h-3.5 w-3.5" />
      {label}
    </Link>
  );
}
