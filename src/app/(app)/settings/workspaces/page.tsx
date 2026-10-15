import { redirect } from "next/navigation";

/** Keep bookmarks to the former account-settings directory working. */
export default function LegacyWorkspacesPage() {
  redirect("/workspaces");
}
