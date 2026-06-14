import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { encryptSecret } from "@/server/crypto";
import { convertManifestCode } from "@/server/services/github-app";
import {
  isWorkspaceAdmin,
  signManifestState,
  verifyManifestState,
} from "@/server/integrations/github-app-manifest";

/**
 * Manifest conversion callback. GitHub redirects here with a one-time `code`
 * after the app is created. We exchange it for the app's credentials (App ID,
 * slug, freshly-generated PEM), persist a `GithubApp` row, then send the
 * operator on to install it (which yields the installation id).
 */

function origin(req: NextRequest): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return (process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(
      /\/+$/,
      "",
    );
  }
}

function errorRedirect(req: NextRequest, returnTo: string, error: string): NextResponse {
  const url = new URL(returnTo, origin(req));
  url.searchParams.set("github_app_error", error);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", origin(req)));
  }

  const params = req.nextUrl.searchParams;
  const code = params.get("code")?.trim();
  const stateToken = params.get("state")?.trim();
  const state = stateToken ? verifyManifestState(stateToken) : null;

  if (!state || state.purpose !== "create") {
    return errorRedirect(req, "/", "GitHub App link expired or invalid — start again.");
  }
  if (state.userId !== session.user.id || !(await isWorkspaceAdmin(db, session.user.id, state.workspaceId))) {
    return errorRedirect(req, state.returnTo, "Not authorized for this workspace.");
  }
  if (!code) {
    return errorRedirect(req, state.returnTo, "GitHub returned no code.");
  }

  let app;
  try {
    const conv = await convertManifestCode(code);
    app = await db.githubApp.create({
      data: {
        workspaceId: state.workspaceId,
        name: conv.name?.slice(0, 120) || "GitHub App",
        appId: conv.appId,
        slug: conv.slug || null,
        privateKeyEnc: encryptSecret(conv.privateKeyPem),
        clientId: conv.clientId,
        createdViaManifest: true,
      },
      select: { id: true, slug: true },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "GitHub App creation failed.";
    return errorRedirect(req, state.returnTo, message);
  }

  // Created — now install it (picks repos, yields the installation id). Carry an
  // install-leg state so the post-install callback can stamp the row.
  if (!app.slug) {
    // No slug → can't deep-link the install; land back with a notice.
    const url = new URL(state.returnTo, origin(req));
    url.searchParams.set("github_app_created", "1");
    return NextResponse.redirect(url);
  }
  const installState = signManifestState({
    purpose: "install",
    workspaceId: state.workspaceId,
    userId: session.user.id,
    githubAppId: app.id,
    returnTo: state.returnTo,
  });
  const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`);
  installUrl.searchParams.set("state", installState);
  return NextResponse.redirect(installUrl);
}
