import { redirect } from "next/navigation";

/**
 * Agent client inventory now lives with credential lifecycle in Agent access.
 * Keep workspace-scoped links and their selected workspace intact.
 */
export default async function AgentClientsRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/w/${slug}/settings/access`);
}
