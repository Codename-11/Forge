import { redirect } from "next/navigation";

/**
 * Global agent **profiles** — the user-owned definitions (the same
 * Compatibility route retained for bookmarks from the former account-level
 * Agent Studio. Mission Control now owns agent management at `/agents`.
 */
export default async function GlobalAgentsPage() {
  redirect("/agents");
}
