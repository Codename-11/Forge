import { requireInstanceAdmin } from "@/components/global-shell/data";

/**
 * Gates the entire `/admin` subtree to INSTANCE_ADMIN. Non-admins get a
 * 404 (not a 403) so the surface stays unadvertised. Part of the
 * multi-workspace restructure.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await requireInstanceAdmin())) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  return <>{children}</>;
}
