import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import {
  buildManifest,
  isWorkspaceAdmin,
  safeReturnTo,
  signManifestState,
} from "@/server/integrations/github-app-manifest";
import { publicOrigin as origin } from "@/server/integrations/public-origin";

/**
 * Begin the GitHub App manifest flow. Renders a tiny auto-submitting form that
 * POSTs the app manifest to GitHub (user account or org). GitHub creates the
 * app and redirects to our callback with a one-time `code`. No PEM is ever
 * pasted — GitHub generates the key and hands it back at conversion.
 */

function errorRedirect(req: NextRequest, returnTo: string, error: string): NextResponse {
  const url = new URL(returnTo, origin(req));
  url.searchParams.set("github_app_error", error);
  return NextResponse.redirect(url);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/signin", origin(req)));
  }

  const params = req.nextUrl.searchParams;
  const workspaceId = params.get("ws")?.trim();
  const returnTo = safeReturnTo(params.get("returnTo"), "/");
  const org = params.get("org")?.trim();
  const rawName = params.get("name")?.trim();

  if (!workspaceId) return errorRedirect(req, returnTo, "Missing workspace.");
  if (!(await isWorkspaceAdmin(db, session.user.id, workspaceId))) {
    return errorRedirect(req, returnTo, "Only a workspace admin can create a GitHub App.");
  }

  // GitHub app names are global + capped at 34 chars.
  const name = (rawName && rawName.length ? rawName : "Forge Runtime").slice(0, 34);

  const state = signManifestState({
    purpose: "create",
    workspaceId,
    userId: session.user.id,
    returnTo,
  });
  const manifest = buildManifest({ origin: origin(req), name });

  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  // Auto-submitting form: GitHub requires the manifest as a POST form field.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creating GitHub App…</title></head>
<body style="font-family:system-ui;padding:2rem;color:#444">
<p>Redirecting to GitHub to create your app…</p>
<form id="f" action="${escapeAttr(action)}?state=${encodeURIComponent(state)}" method="post">
<input type="hidden" name="manifest" value='${escapeAttr(JSON.stringify(manifest))}'>
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit()</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
