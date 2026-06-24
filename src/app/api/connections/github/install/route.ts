import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { publicOrigin } from "@/server/integrations/public-origin";

const COOKIE = "forge_github_app_install";

function settingsRedirect(req: NextRequest, error: string): NextResponse {
  const url = new URL("/settings/connections", publicOrigin(req));
  url.searchParams.set("connection_error", error);
  return NextResponse.redirect(url);
}

function safeReturnTo(req: NextRequest): string {
  const value = req.nextUrl.searchParams.get("returnTo") ?? "/settings/connections";
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 400) {
    return "/settings/connections";
  }
  return value;
}

function signState(state: string, returnTo: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for GitHub App install state.");
  const encodedReturnTo = Buffer.from(returnTo, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret)
    .update(`github-app:${state}:${encodedReturnTo}`)
    .digest("base64url");
  return `${state}.${encodedReturnTo}.${sig}`;
}

/**
 * Resolve the GitHub App slug to deep-link the install flow at. Prefer the
 * `GITHUB_APP_SLUG` env, but fall back to a GitHub App the user already
 * configured (e.g. via Settings → GitHub Apps "Create with GitHub") so a
 * single-tenant deploy that never set the env var still works. Scopes to the
 * caller's workspaces; prefers the workspace in `returnTo` when present.
 */
async function resolveAppSlug(userId: string, returnTo: string): Promise<string | null> {
  const fromEnv = process.env.GITHUB_APP_SLUG?.trim();
  if (fromEnv) return fromEnv;

  const wsSlug = returnTo.match(/^\/w\/([^/]+)(?:\/|$)/)?.[1];
  const memberOf = { memberships: { some: { userId } } };
  const pick = async (workspaceWhere: Record<string, unknown>) =>
    db.githubApp.findFirst({
      where: { slug: { not: null }, workspace: workspaceWhere },
      orderBy: [{ lastMintedAt: "desc" }, { createdAt: "desc" }],
      select: { slug: true },
    });

  // Prefer the workspace the operator came from, then any workspace they belong to.
  const scoped = wsSlug ? await pick({ ...memberOf, slug: wsSlug }) : null;
  const app = scoped ?? (await pick(memberOf));
  return app?.slug ?? null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", publicOrigin(req)));
  }

  const returnTo = safeReturnTo(req);
  const appSlug = await resolveAppSlug(session.user.id, returnTo);
  if (!appSlug) {
    return settingsRedirect(
      req,
      "No GitHub App is configured. Create one in Settings → GitHub Apps (Create with GitHub), or set GITHUB_APP_SLUG.",
    );
  }

  const state = randomBytes(24).toString("base64url");
  const url = new URL(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`);
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url);
  // Derive `secure` from the PUBLIC origin (https in prod behind Traefik),
  // not the internal request protocol — otherwise the cookie is dropped.
  const secure = publicOrigin(req).startsWith("https:");
  res.cookies.set(COOKIE, signState(state, returnTo), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/api/connections/github",
    maxAge: 10 * 60,
  });
  return res;
}
