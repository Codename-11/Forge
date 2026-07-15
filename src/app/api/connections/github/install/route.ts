import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", publicOrigin(req)));
  }

  const returnTo = safeReturnTo(req);
  // Native issue/PR sync uses the instance GitHub App credentials. Workspace
  // runtime-auth apps deliberately have different permissions, keys, and an
  // inactive webhook, so their slug must never be substituted here.
  const appSlug = process.env.GITHUB_APP_SLUG?.trim() || null;
  if (!appSlug) {
    return settingsRedirect(
      req,
      "Native GitHub sync is not configured. Set GITHUB_APP_SLUG and the matching instance GitHub App credentials.",
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
