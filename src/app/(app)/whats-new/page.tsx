import { redirect } from "next/navigation";
import { GlobalShell } from "@/components/global-shell/global-shell";
import { getGlobalShellData } from "@/components/global-shell/data";
import { WhatsNewContent } from "@/components/global-shell/whats-new-content";

/**
 * Global What's New — the canonical CHANGELOG rendered in the concourse
 * shell, reachable from Mission Control and Instance Admin (and the
 * version chip in either footer). The workspace dashboard tile +
 * `/w/[slug]/whats-new` still exist; all read the same source.
 */
export default async function WhatsNewPage() {
  const data = await getGlobalShellData();
  if (!data) redirect("/signin");

  return (
    <GlobalShell
      user={data.user}
      workspaces={data.workspaces}
      activePath="/whats-new"
      crumbs={["Forge", "What's New"]}
      title="What's New"
      subtitle="Shipped changes, newest first"
      eyebrow="Release notes"
    >
      <WhatsNewContent />
    </GlobalShell>
  );
}
