import { redirect } from "next/navigation";

/**
 * Legacy workspace landing — merged into the Inbox as the primary "what's
 * next" view. Hard-redirect preserves existing bookmarks and any agent
 * links that still point at `/dashboard`. When the old dashboard's
 * onboarding and focus-grid blocks eventually need a home again, they
 * can move onto the Inbox page directly.
 */
export default async function DashboardRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/w/${slug}/inbox`);
}
