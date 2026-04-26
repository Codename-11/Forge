import { redirect } from "next/navigation";

/**
 * Workspace root redirects to /dashboard. The dashboard is the default
 * landing — it's a workspace overview (rollups, onboarding, recent
 * issues) and a strict superset of what most operators want when they
 * "go home". Inbox is one chord away (`g i`) for the action queue.
 */
export default async function WorkspaceRoot({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/w/${slug}/dashboard`);
}
