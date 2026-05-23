import { redirect } from "next/navigation";

/**
 * Crews moved out of settings. The canonical surface is the top-level
 * `/crews` index (+ `/crews/<id>` detail), where creation and full roster
 * management live. This redirect keeps old `/settings/crews` links working.
 */
export default async function CrewsSettingsRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/w/${slug}/crews`);
}
