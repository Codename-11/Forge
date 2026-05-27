import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ConnectionStatus } from "@prisma/client";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
  decryptBundle,
  encryptBundle,
  exchangeCode,
  fetchAccountHandle,
  FLOW_COOKIE,
  FLOW_TTL_MS,
  readClientSecret,
  readConfig,
  resolveEndpoints,
  verifyFlowState,
} from "@/server/services/connections/oauth";

/**
 * GET /api/connections/[id]/callback
 *
 * OAuth/OIDC redirect target. Verifies the signed `state` cookie (CSRF),
 * exchanges the `code` for tokens at the provider's token endpoint (PKCE
 * verifier from the cookie), fetches the account identity for display,
 * encrypts the token bundle into `connection.tokenEnc`, and flips the
 * connection CONNECTED (or DEGRADED on failure). Redirects back to
 * `/settings/connections`.
 */

function baseUrl(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return (process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  }
}

function done(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL("/settings/connections", baseUrl(req));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  // Always clear the in-flight cookie.
  res.cookies.set(FLOW_COOKIE, "", { path: "/api/connections", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", baseUrl(req)));
  }

  const connection = await db.connection.findUnique({ where: { id } });
  if (!connection || connection.ownerId !== session.user.id) {
    return done(req, { connection_error: "Connection not found." });
  }

  const url = new URL(req.url);
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const desc = url.searchParams.get("error_description") || providerError;
    await markDegraded(connection.id, `Authorization denied: ${desc}`);
    return done(req, { connection_error: desc });
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return done(req, { connection_error: "Missing code/state in callback." });
  }

  // Verify the signed flow cookie matches this connection + returned state.
  const flow = verifyFlowState(req.cookies.get(FLOW_COOKIE)?.value);
  if (
    !flow ||
    flow.connectionId !== connection.id ||
    flow.state !== returnedState ||
    Date.now() - flow.iat > FLOW_TTL_MS
  ) {
    await markDegraded(connection.id, "OAuth state mismatch or expired — retry authorization.");
    return done(req, { connection_error: "State verification failed — retry." });
  }

  const config = readConfig(connection.config);
  const clientId = config.clientId;
  if (!clientId) {
    return done(req, { connection_error: "Missing client ID." });
  }

  try {
    const endpoints = await resolveEndpoints(connection.provider, config);
    const redirectUri = `${baseUrl(req)}/api/connections/${connection.id}/callback`;
    const bundle = await exchangeCode({
      endpoints,
      clientId,
      clientSecret: readClientSecret(config),
      redirectUri,
      code,
      verifier: flow.verifier,
    });

    const account = await fetchAccountHandle(connection.provider, endpoints, bundle);

    await db.connection.update({
      where: { id: connection.id },
      data: {
        tokenEnc: encryptBundle(bundle),
        account: account ?? connection.account,
        status: ConnectionStatus.CONNECTED,
        error: null,
        expiresAt: bundle.expiresAt ? new Date(bundle.expiresAt) : null,
        ...(bundle.scope ? { scopes: bundle.scope.split(/\s+/).filter(Boolean) } : {}),
      },
    });

    return done(req, { connection_connected: connection.label });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Token exchange failed.";
    await markDegraded(connection.id, msg);
    return done(req, { connection_error: msg });
  }
}

async function markDegraded(id: string, error: string): Promise<void> {
  // Preserve any existing token; just record the failure + degrade health.
  const existing = await db.connection.findUnique({ where: { id }, select: { tokenEnc: true } });
  await db.connection.update({
    where: { id },
    data: {
      status: decryptBundle(existing?.tokenEnc) ? ConnectionStatus.DEGRADED : ConnectionStatus.DISCONNECTED,
      error: error.slice(0, 500),
    },
  });
}
