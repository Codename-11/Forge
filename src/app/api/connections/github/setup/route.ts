import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ConnectionProvider, ConnectionStatus, type Prisma } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { getGitHubAppInstallation } from "@/server/services/github/client";

const COOKIE = "forge_github_app_install";

function baseUrl(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return (process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  }
}

function done(
  req: NextRequest,
  params: Record<string, string>,
  returnTo = "/settings/connections",
): NextResponse {
  const url = new URL(returnTo, baseUrl(req));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(COOKIE, "", { path: "/api/connections/github", maxAge: 0 });
  return res;
}

function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 400) {
    return "/settings/connections";
  }
  return value;
}

function verifyState(cookieValue: string | undefined, returnedState: string | null): string | null {
  if (!cookieValue || !returnedState) return null;
  const [state, encodedReturnTo, sig] = cookieValue.split(".");
  if (!state || !encodedReturnTo || !sig || state !== returnedState) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const expected = createHmac("sha256", secret)
    .update(`github-app:${state}:${encodedReturnTo}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return safeReturnTo(Buffer.from(encodedReturnTo, "base64url").toString("utf8"));
  } catch {
    return "/settings/connections";
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", baseUrl(req)));
  }

  const url = new URL(req.url);
  const returnTo = verifyState(req.cookies.get(COOKIE)?.value, url.searchParams.get("state"));
  if (!returnTo) {
    return done(req, { connection_error: "GitHub App install state did not match. Retry installation." });
  }

  const installationId = url.searchParams.get("installation_id");
  if (!installationId) {
    return done(req, { connection_error: "GitHub did not return an installation id." }, returnTo);
  }

  try {
    const installation = await getGitHubAppInstallation({ installationId });
    const accountLogin = installation.account?.login ?? `installation-${installation.id}`;
    const accountType = installation.account?.type ?? "Account";
    const config: Prisma.InputJsonObject = {
      authKind: "github_app_installation",
      installationId: installation.id,
      accountLogin,
      accountType,
      repositorySelection: installation.repository_selection ?? null,
      permissions: installation.permissions ?? {},
      events: installation.events ?? [],
    };

    const existing = (await db.connection.findMany({
      where: { ownerId: session.user.id, provider: ConnectionProvider.GITHUB },
    })).find((row) => {
      const cfg = row.config;
      return (
        cfg &&
        typeof cfg === "object" &&
        "installationId" in cfg &&
        String((cfg as { installationId?: unknown }).installationId) === String(installation.id)
      );
    });

    const label = `GitHub App - ${accountLogin}`;
    if (existing) {
      await db.connection.update({
        where: { id: existing.id },
        data: {
          label,
          account: `github.com/${accountLogin}`,
          status: ConnectionStatus.CONNECTED,
          error: null,
          config,
        },
      });
    } else {
      await db.connection.create({
        data: {
          ownerId: session.user.id,
          provider: ConnectionProvider.GITHUB,
          label,
          account: `github.com/${accountLogin}`,
          status: ConnectionStatus.CONNECTED,
          config,
        },
      });
    }

    return done(req, { connection_connected: label }, returnTo);
  } catch (err) {
    return done(req, {
      connection_error: err instanceof Error ? err.message : "GitHub App setup failed.",
    }, returnTo);
  }
}
