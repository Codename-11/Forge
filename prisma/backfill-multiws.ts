/**
 * Backfill for the multi-workspace restructure (migration 0069).
 *
 * IDEMPOTENT and SAFE to re-run. NOT auto-applied on deploy — run it
 * explicitly once the schema migration has landed:
 *
 *   pnpm exec tsx prisma/backfill-multiws.ts
 *
 * What it does:
 *   1. Stamps the bootstrap operator (ADMIN_EMAIL) as INSTANCE_ADMIN.
 *   2. Creates one global AgentProfile per (owner, profileKey) and links
 *      each existing Agent binding to it (Agent.profileId). The owner is
 *      the workspace's OWNER (fallback: ADMIN, then any member). The
 *      profile's definitional columns are copied from the binding.
 *   3. Backfills Runtime.ownerId from the workspace owner where null.
 *
 * Until this runs, Agent.profileId is null and the app treats each
 * binding's own columns as its definition (transitional). Running it is
 * additive: it never deletes, and re-running only fills gaps.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** The user who owns a workspace: OWNER first, then ADMIN, then anyone. */
async function workspaceOwnerUserId(workspaceId: string): Promise<string | null> {
  for (const role of ["OWNER", "ADMIN"] as const) {
    const m = await db.membership.findFirst({
      where: { workspaceId, role },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    if (m) return m.userId;
  }
  const any = await db.membership.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  return any?.userId ?? null;
}

async function main() {
  let promoted = 0;
  let profilesCreated = 0;
  let bindingsLinked = 0;
  let runtimesOwned = 0;

  // 1. Bootstrap instance admin.
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
  if (adminEmail) {
    const r = await db.user.updateMany({
      where: { email: { equals: adminEmail, mode: "insensitive" }, instanceRole: { not: "INSTANCE_ADMIN" } },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    promoted = r.count;
  } else {
    console.warn("ADMIN_EMAIL not set — skipping instance-admin promotion.");
  }

  // 2. Agent bindings → global profiles.
  const agents = await db.agent.findMany({
    where: { profileId: null },
    orderBy: { createdAt: "asc" },
  });
  // Cache: `${ownerId}:${profileKey}` → profileId, so the same handle
  // across a single owner's workspaces collapses to one profile.
  const profileCache = new Map<string, string>();

  for (const a of agents) {
    const ownerId = await workspaceOwnerUserId(a.workspaceId);
    if (!ownerId) {
      console.warn(`agent ${a.id} (${a.profileKey}) has no workspace member — skipping.`);
      continue;
    }
    const cacheKey = `${ownerId}:${a.profileKey}`;
    let profileId = profileCache.get(cacheKey);

    if (!profileId) {
      const existing = await db.agentProfile.findUnique({
        where: { ownerId_profileKey: { ownerId, profileKey: a.profileKey } },
        select: { id: true },
      });
      if (existing) {
        profileId = existing.id;
      } else {
        const created = await db.agentProfile.create({
          data: {
            ownerId,
            profileKey: a.profileKey,
            name: a.name,
            description: a.description,
            avatar: a.avatar,
            provider: a.provider,
            runtimeMode: a.runtimeMode,
            runEngine: a.runEngine,
            webhookUrl: a.webhookUrl,
            webhookSecret: a.webhookSecret,
            runtimeId: a.runtimeId,
            baseCapabilities: a.capabilities,
            role: a.role,
            templateMarkdown: a.templateMarkdown,
          },
          select: { id: true },
        });
        profileId = created.id;
        profilesCreated++;
      }
      profileCache.set(cacheKey, profileId);
    }

    await db.agent.update({ where: { id: a.id }, data: { profileId } });
    bindingsLinked++;
  }

  // 3. Runtime ownership.
  const runtimes = await db.runtime.findMany({ where: { ownerId: null }, select: { id: true, workspaceId: true } });
  for (const rt of runtimes) {
    const ownerId = await workspaceOwnerUserId(rt.workspaceId);
    if (ownerId) {
      await db.runtime.update({ where: { id: rt.id }, data: { ownerId } });
      runtimesOwned++;
    }
  }

  console.log(
    `backfill-multiws done — promoted ${promoted} admin, created ${profilesCreated} profiles, ` +
      `linked ${bindingsLinked} bindings, owned ${runtimesOwned} runtimes.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
