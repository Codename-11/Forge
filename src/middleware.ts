import { NextResponse, type NextRequest } from "next/server";

/**
 * Legacy URL compatibility layer.
 *
 * Phase 2E moves every workspace-scoped route under `/w/[slug]/*`. Old
 * deep links (from bookmarks, chat messages, docs) still work because we
 * redirect them to the current workspace here. The "current" workspace is
 * picked from a lightweight hint cookie set by the workspace shell
 * (`forge.lastSlug`). If the cookie is missing — e.g. first visit after
 * clearing storage — we send users to `/` which does a server-side
 * resolution against `User.lastWorkspaceId`.
 *
 * Keep this active for ~6 weeks. After that we can drop it (or turn it
 * into a hard 410) once bookmarks have caught up.
 */
// NOTE: `/inbox` is intentionally NOT here — post-restructure it's the
// GLOBAL cross-workspace inbox (a real top-level route), not a legacy
// alias for the workspace inbox (which lives at `/w/<slug>/inbox`).
const LEGACY_PREFIXES = [
  "/dashboard",
  "/issues",
  "/projects",
  "/focus",
  "/standup",
  "/analytics",
];

// Settings paths that should redirect to the workspace-scoped equivalent.
// Account-level pages (`/settings/account`, `/settings/access`,
// `/settings/workspaces`) stay at the root.
const WORKSPACE_SETTINGS = [
  "/settings/members",
  "/settings/statuses",
  "/settings/labels",
  "/settings/templates",
  "/settings/project-templates",
  "/settings/recurring",
  "/settings/views",
  "/settings/plugins",
  "/settings/admin",
  "/settings/workspace",
];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const hit =
    LEGACY_PREFIXES.find((p) => pathname === p || pathname.startsWith(`${p}/`)) ??
    WORKSPACE_SETTINGS.find((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!hit) return NextResponse.next();

  // Don't double-redirect things already under /w/... or /api/....
  if (pathname.startsWith("/w/") || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const slug = req.cookies.get("forge.lastSlug")?.value;
  if (!slug) {
    // Let `/` resolve against the user's session instead of guessing here.
    return NextResponse.redirect(new URL("/", req.url));
  }

  const url = new URL(`/w/${slug}${pathname}${search}`, req.url);
  return NextResponse.redirect(url);
}

export const config = {
  // Only run on top-level paths that could be legacy. /w/*, /api/*,
  // /signin, and static assets are excluded via the matcher.
  matcher: [
    "/dashboard/:path*",
    "/issues/:path*",
    "/projects/:path*",
    "/focus/:path*",
    "/standup/:path*",
    "/analytics/:path*",
    "/settings/members/:path*",
    "/settings/statuses/:path*",
    "/settings/labels/:path*",
    "/settings/templates/:path*",
    "/settings/project-templates/:path*",
    "/settings/recurring/:path*",
    "/settings/views/:path*",
    "/settings/plugins/:path*",
    "/settings/admin/:path*",
    "/settings/workspace/:path*",
  ],
};
