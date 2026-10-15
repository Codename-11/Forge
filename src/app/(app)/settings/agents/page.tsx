import { redirect } from "next/navigation";

/**
 * Compatibility route retained for bookmarks from the former account-level
 * Agent Studio. Agent management now lives at `/agents`.
 */
export default async function GlobalAgentsPage() {
  redirect("/agents");
}
