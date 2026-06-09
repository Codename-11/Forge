import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";

const COOKIE = "forge_github_app_install";

function baseUrl(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return (process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  }
}

function settingsRedirect(req: NextRequest, error: string): NextResponse {
  const url = new URL("/settings/connections", baseUrl(req));
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
    return NextResponse.redirect(new URL("/signin", baseUrl(req)));
  }

  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  if (!appSlug) return settingsRedirect(req, "GITHUB_APP_SLUG is not configured.");

  const state = randomBytes(24).toString("base64url");
  const returnTo = safeReturnTo(req);
  const url = new URL(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`);
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url);
  res.cookies.set(COOKIE, signState(state, returnTo), {
    httpOnly: true,
    secure: req.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/api/connections/github",
    maxAge: 10 * 60,
  });
  return res;
}
