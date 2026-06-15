import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { isWorkspaceAdmin, verifyManifestState } from "@/server/integrations/github-app-manifest";
import { publicOrigin as origin } from "@/server/integrations/public-origin";

/**
 * Post-install callback (the app's `setup_url`). GitHub redirects here after the
 * operator installs the app and picks repos, with `installation_id`. We stamp
 * it onto the `GithubApp` row — now provisioning can mint tokens. State carries
 * which app row + workspace this install belongs to.
 */

function redirectBack(req: NextRequest, returnTo: string, key: string, value: string): NextResponse {
  const url = new URL(returnTo, origin(req));
  url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", origin(req)));
  }

  const params = req.nextUrl.searchParams;
  const installationId = params.get("installation_id")?.trim();
  const stateToken = params.get("state")?.trim();
  const state = stateToken ? verifyManifestState(stateToken) : null;

  // Without our state (e.g. user installed from GitHub directly), we can't
  // correlate the install — bounce home with a gentle note.
  if (!state || state.purpose !== "install" || !state.githubAppId) {
    return redirectBack(req, "/", "github_app_error", "Install could not be matched — open the app in Settings and paste its installation ID.");
  }
  if (state.userId !== session.user.id || !(await isWorkspaceAdmin(db, session.user.id, state.workspaceId))) {
    return redirectBack(req, state.returnTo, "github_app_error", "Not authorized for this workspace.");
  }
  if (!installationId || !/^\d+$/.test(installationId)) {
    return redirectBack(req, state.returnTo, "github_app_error", "GitHub returned no installation ID.");
  }

  const updated = await db.githubApp.updateMany({
    where: { id: state.githubAppId, workspaceId: state.workspaceId },
    data: { installationId, lastError: null },
  });
  if (updated.count === 0) {
    return redirectBack(req, state.returnTo, "github_app_error", "GitHub App not found.");
  }
  return redirectBack(req, state.returnTo, "github_app_installed", "1");
}
