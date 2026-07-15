import "server-only";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import type { GlobalShellUser, GlobalShellWorkspace } from "./global-shell";

/**
 * Server-side resolver for the global ("concourse") shell chrome: the
 * signed-in user (+ instanceRole) and the workspaces they belong to for
 * the rail switcher. Returns null when unauthenticated (the (app) layout
 * already redirects, but callers should guard). Part of the
 * multi-workspace restructure.
 */
export async function getGlobalShellData(): Promise<{
  user: GlobalShellUser;
  workspaces: GlobalShellWorkspace[];
} | null> {
  const session = await auth();
  if (!session?.user) return null;

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      image: true,
      instanceRole: true,
      memberships: {
        where: { workspace: { deletedAt: null } },
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          workspace: {
            select: { id: true, slug: true, name: true, key: true, avatarUrl: true },
          },
        },
      },
    },
  });
  if (!user) return null;

  return {
    user: {
      name: user.name,
      email: user.email,
      image: user.image,
      instanceRole: user.instanceRole,
    },
    workspaces: user.memberships.map((m) => ({ ...m.workspace, role: m.role })),
  };
}

/** Convenience guard for instance-admin-only routes. */
export async function requireInstanceAdmin(): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  const u = await db.user.findUnique({
    where: { id: session.user.id },
    select: { instanceRole: true, email: true },
  });
  if (u?.instanceRole === "INSTANCE_ADMIN") return true;
  // Env ADMIN_EMAIL is a BOOTSTRAP fallback ONLY — honored while no instance
  // admin exists yet, so the first operator can reach /admin before their row
  // is stamped. Once one exists the DB is authoritative (a demoted operator
  // stays demoted; a shared/recycled ADMIN_EMAIL can't regain control).
  const emailMatches = !!adminEmail && !!u?.email && u.email.toLowerCase() === adminEmail;
  if (!emailMatches) return false;
  const adminCount = await db.user.count({ where: { instanceRole: "INSTANCE_ADMIN" } });
  return adminCount === 0;
}
