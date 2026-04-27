import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { TrpcProvider } from "@/lib/trpc-provider";

/**
 * Outer authenticated layout. Purely auth-gating + a slug-aware tRPC
 * provider. Workspace-scoped pages additionally mount the full shell in
 * `w/[slug]/layout.tsx`. Account-level settings (`/settings/account`,
 * `/settings/access`, `/settings/workspaces`) render inside
 * `(app)/settings/layout.tsx` which adds its own chromeless shell. When an
 * active workspace exists, the same account surfaces are also reachable under
 * `/w/[slug]/settings/*` to preserve the workspace shell while navigating.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return <TrpcProvider>{children}</TrpcProvider>;
}
