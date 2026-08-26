import { notFound, redirect } from "next/navigation";
import { db } from "@/server/db";
import { auth } from "@/server/auth";
import { issueWhereForViewer } from "@/server/services/project-access";

/**
 * Short-link route: `/w/{slug}/i/{KEY-NN}` resolves to the corresponding
 * issue and redirects to its full detail page. Used by the markdown
 * renderer's auto-linking — agents and humans can write `AXI-42` in any
 * comment / description and the renderer turns it into a real link
 * without needing the cuid up front.
 *
 * Server-side resolve keeps the URL canonical: the redirect lands on
 * `/issues/{cuid}` so refreshes / share-links still work after a
 * workspace key rename.
 */
export default async function IssueByKeyRedirect({
  params,
}: {
  params: Promise<{ slug: string; key: string }>;
}) {
  const { slug, key } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();
  const workspace = await db.workspace.findUnique({
    where: { slug },
    select: { id: true, key: true },
  });
  if (!workspace) notFound();
  const membership = await db.membership.findUnique({
    where: {
      userId_workspaceId: { userId: session.user.id, workspaceId: workspace.id },
    },
    select: { id: true, role: true },
  });
  if (!membership) notFound();

  // KEY-NN format: split on the last `-`. Workspace keys are uppercase
  // alnum (validated server-side), the suffix is the integer. Reject
  // anything that doesn't match before going to the DB.
  const m = /^([A-Z0-9]+)-(\d+)$/i.exec(key);
  if (!m) notFound();
  const wsKey = m[1].toUpperCase();
  const number = parseInt(m[2], 10);

  // Cross-workspace check — only resolve if the prefix matches the
  // workspace's own key. Refuse to leak across tenants.
  if (wsKey !== workspace.key) notFound();

  const issue = await db.issue.findFirst({
    where: {
      workspaceId: workspace.id,
      number,
      deletedAt: null,
      AND: [issueWhereForViewer({ workspaceId: workspace.id, membership })],
    },
    select: { id: true },
  });
  if (!issue) notFound();

  redirect(`/w/${slug}/issues/${issue.id}`);
}
