import { redirect } from "next/navigation";

/**
 * `/w/[slug]/personal` is retired by the multi-workspace restructure —
 * the per-workspace PERSONAL canvas is subsumed by global Mission
 * Control at the app root. This route now just redirects there so old
 * bookmarks don't 404.
 */
export default function PersonalCanvasRedirect() {
  redirect("/");
}
