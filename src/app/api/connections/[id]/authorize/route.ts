import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
  buildAuthorizeUrl,
  FLOW_COOKIE,
  FLOW_TTL_MS,
  makePkce,
  makeStateToken,
  readClientSecret,
  readConfig,
  resolveEndpoints,
  signFlowState,
} from "@/server/services/connections/oauth";

/**
 * GET /api/connections/[id]/authorize
 *
 * Begins the live OAuth/OIDC authorization-code + PKCE flow for a
 * user-owned connection. Verifies the caller owns the connection, resolves
 * the provider's endpoints (well-known or OIDC discovery), persists a signed
 * `state`+PKCE-verifier in a short-lived HttpOnly cookie, then 302-redirects
 * to the provider's authorization endpoint.
 *
 * The matching redirect/callback is `/api/connections/[id]/callback`.
 */

function baseUrl(req: NextRequest): string {
  // Prefer the request's own origin so the redirect_uri always matches what
  // the browser hit; fall back to AUTH_URL / NEXT_PUBLIC_APP_URL.
  const fromEnv = process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  try {
    return new URL(req.url).origin;
  } catch {
    return (fromEnv ?? "http://localhost:3000").replace(/\/+$/, "");
  }
}

function settingsRedirect(req: NextRequest, error?: string): NextResponse {
  const url = new URL("/settings/connections", baseUrl(req));
  if (error) url.searchParams.set("connection_error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", baseUrl(req)));
  }

  const connection = await db.connection.findUnique({ where: { id } });
  if (!connection || connection.ownerId !== session.user.id) {
    return settingsRedirect(req, "Connection not found.");
  }

  const config = readConfig(connection.config);
  const clientId = config.clientId;
  if (!clientId) {
    return settingsRedirect(req, "Set a client ID before authorizing.");
  }

  let endpoints;
  try {
    endpoints = await resolveEndpoints(connection.provider, config);
  } catch (err) {
    return settingsRedirect(req, err instanceof Error ? err.message : "Could not resolve OAuth endpoints.");
  }

  // PKCE requires no secret; the secret (if present) is used at token time.
  // We still allow connections with no secret (public clients).
  readClientSecret(config); // touch — surfaces nothing, validates shape only

  const state = makeStateToken();
  const { verifier, challenge } = makePkce();
  const redirectUri = `${baseUrl(req)}/api/connections/${connection.id}/callback`;

  const authorizeUrl = buildAuthorizeUrl({
    endpoints,
    clientId,
    redirectUri,
    scopes: connection.scopes,
    state,
    codeChallenge: challenge,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(
    FLOW_COOKIE,
    signFlowState({ connectionId: connection.id, state, verifier, iat: Date.now() }),
    {
      httpOnly: true,
      secure: req.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/api/connections",
      maxAge: Math.floor(FLOW_TTL_MS / 1000),
    },
  );
  return res;
}
