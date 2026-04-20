import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { rateLimit } from "@/server/rate-limit";
import type { NextRequest } from "next/server";

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
export async function createContext(req: NextRequest) {
  const session = (await auth()) as Session | null;
  const workspaceId = req.headers.get("x-workspace-id");
  const workspaceSlug = req.headers.get("x-workspace-slug");
  return {
    db,
    session,
    workspaceId,
    workspaceSlug,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

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
