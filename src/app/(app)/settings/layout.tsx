import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { SettingsRail } from "@/components/settings/settings-rail";

/**
 * Account-level settings shell.
 *
 * This layout only applies to the *bare* `/settings/*` tree — workspace
 * settings live under `/w/[slug]/settings/*` and use the normal workspace
 * shell. Account settings are global to the user and get the same compact
 * settings navbar as workspace settings, plus a back-link to the last active
 * workspace.
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
    <div className="flex h-svh overflow-hidden bg-background">
      <SettingsRail
        scope="account"
        backHref={backSlug ? `/w/${backSlug}/inbox` : "/"}
        backLabel={backSlug ? "Back to workspace" : "Home"}
        email={session.user.email}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
