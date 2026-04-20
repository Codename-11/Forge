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
 * `workspaceId` is resolved from the `x-workspace-id` header (client sets it)
 * OR from path params in route handlers that need explicit scoping. Procedures
 * that require workspace scope go through `workspaceProcedure` which validates
 * membership and role.
 */
export async function createContext(req: NextRequest) {
  const session = (await auth()) as Session | null;
  const workspaceId = req.headers.get("x-workspace-id");
  return {
    db,
    session,
    workspaceId,
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
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing x-workspace-id header.",
    });
  }
  const membership = await ctx.db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.session.user.id, workspaceId: ctx.workspaceId } },
  });
  if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx: { ...ctx, workspaceId: ctx.workspaceId, membership } });
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
