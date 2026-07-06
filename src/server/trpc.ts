import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { rateLimit } from "@/server/rate-limit";
import type { NextRequest } from "next/server";
import type { ApiKeyContext } from "@/server/services/api-key-auth";

/**
 * tRPC context — carries session + db + request metadata.
 *
 * Workspace scoping is resolved in priority order:
 *   1. `x-workspace-slug` header (preferred — set by the tRPC link that reads
 *      the `/w/[slug]` segment from window.location).
 *   2. `x-workspace-id` header (legacy callers / focus bootstrap).
 *
 * Procedures that require workspace scope go through `workspaceProcedure`
 * which validates membership and role. The header → id lookup happens there
 * so the context stays cheap for public + protected routes.
 */
export async function createContext(req: NextRequest): Promise<BaseContext> {
  const session = (await auth()) as Session | null;
  const workspaceId = req.headers.get("x-workspace-id");
  const workspaceSlug = req.headers.get("x-workspace-slug");
  // `apiKey` is null on session-authenticated requests. It gets populated
  // on MCP-layer callers that construct contexts manually with an
  // authenticated key. Procedures that care about narrowing read this via
  // `assertKeyScope` / `buildKeyScopeWhere` from api-key-auth.ts.
  return {
    db,
    session,
    workspaceId,
    workspaceSlug,
    apiKey: null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}

/**
 * The shape of `ctx` before `workspaceProcedure`/`adminProcedure` inject
 * extra fields. `apiKey` is widened to `ApiKeyContext | null` so caller
 * shims (MCP handlers, tests) can populate it.
 */
export interface BaseContext {
  db: typeof db;
  session: Session | null;
  workspaceId: string | null;
  workspaceSlug: string | null;
  apiKey: ApiKeyContext | null;
  ip: string | null;
  userAgent: string | null;
}

export type Context = BaseContext;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/**
 * Global (cross-workspace) procedure. Session required, NO workspace
 * context. Powers the "concourse" global shell + Mission Control, which
 * read across every workspace the caller belongs to. READ-ONLY by
 * convention — any write must go through a `workspaceProcedure` (the user
 * enters a workspace first). It's `protectedProcedure` today; kept as a
 * distinct, greppable name so the cross-workspace read surface is obvious
 * and we can layer a hard read-only assertion here later.
 */
export const globalProcedure = protectedProcedure;

export const workspaceProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  // Resolve slug → id if the caller only sent a slug. The URL segment
  // `/w/[slug]` is the source of truth for the client shell, so most
  // modern calls arrive via `x-workspace-slug`. Legacy callers (focus
  // bootstrap, external tooling) may still send `x-workspace-id`.
  let workspaceId = ctx.workspaceId;
  if (!workspaceId && ctx.workspaceSlug) {
    const ws = await ctx.db.workspace.findUnique({
      where: { slug: ctx.workspaceSlug },
      select: { id: true },
    });
    if (!ws) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
    }
    workspaceId = ws.id;
  }
  if (!workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing x-workspace-slug or x-workspace-id header.",
    });
  }
  const membership = await ctx.db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.session.user.id, workspaceId } },
  });
  if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx: { ...ctx, workspaceId, membership } });
});

export const adminProcedure = workspaceProcedure.use(async ({ ctx, next }) => {
  if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required." });
  }
  return next({ ctx });
});

/**
 * Instance-admin gate — for settings that are global to the whole
 * self-hosted instance rather than a single workspace (the /admin shell:
 * tenants, users, instance-wide runtimes, audit, system info, sign-in /
 * SSO providers, and global AgentProfile governance). Distinct from
 * `adminProcedure`, which is a *per workspace* OWNER/ADMIN check.
 *
 * Source of truth is `User.instanceRole === INSTANCE_ADMIN`. The legacy
 * env-based `ADMIN_EMAIL` match is kept as a bootstrap fallback so the
 * very first operator can administer the instance before their row has
 * been stamped (auth.ts stamps it on sign-in; the backfill script stamps
 * existing rows). `ctx.instanceRole` is injected for downstream use.
 */
export const instanceAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const user = await ctx.db.user.findUnique({
    where: { id: ctx.session.user.id },
    select: { instanceRole: true, email: true },
  });
  const isAdmin = user?.instanceRole === "INSTANCE_ADMIN";
  if (!isAdmin) {
    // Env ADMIN_EMAIL is a BOOTSTRAP fallback ONLY — honored exclusively while
    // no instance admin exists yet, so the very first operator can administer
    // before their row is stamped. Once someone is INSTANCE_ADMIN, the DB is
    // authoritative: a demoted operator stays demoted, and a shared / recycled /
    // SSO-asserted ADMIN_EMAIL can't silently regain full instance control.
    const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
    const who = (user?.email ?? ctx.session.user?.email)?.toLowerCase();
    const emailMatches = !!adminEmail && !!who && who === adminEmail;
    const isBootstrap = emailMatches
      ? (await ctx.db.user.count({ where: { instanceRole: "INSTANCE_ADMIN" } })) === 0
      : false;
    if (!isBootstrap) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Instance admin required." });
    }
  }
  return next({ ctx: { ...ctx, instanceRole: "INSTANCE_ADMIN" as const } });
});

/**
 * Per-procedure rate limiter. Key includes userId so one user can't exhaust
 * a workspace-wide bucket, and procedure path so limits are isolated.
 */
export function withRateLimit(limit: number, windowSec = 60) {
  return t.middleware(async ({ ctx, path, next }) => {
    const who = ctx.session?.user?.id ?? ctx.ip ?? "anon";
    const key = `trpc:${path}:${who}`;
    const r = await rateLimit(key, limit, windowSec);
    if (!r.ok) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded. Retry after ${new Date(r.resetAt).toISOString()}`,
      });
    }
    return next();
  });
}
