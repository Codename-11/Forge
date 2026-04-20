"use client";
import { useEffect } from "react";

/**
 * Writes a short-lived hint cookie so the edge middleware can redirect
 * legacy URLs (`/issues/AXI-42`) into the user's current workspace without
 * touching the database. The authoritative value lives on
 * `User.lastWorkspaceId`; this cookie is pure UX sugar.
 */
export function WorkspaceCookieSync({ slug }: { slug: string }) {
  useEffect(() => {
    const maxAge = 60 * 60 * 24 * 90; // 90 days
    document.cookie = `forge.lastSlug=${encodeURIComponent(slug)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  }, [slug]);
  return null;
}
