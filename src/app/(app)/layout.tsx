import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { TrpcProvider } from "@/lib/trpc-provider";
import { PushNotificationProvider } from "@/components/push-notification-provider";

/**
 * Outer authenticated layout. Purely auth-gating + a slug-aware tRPC
 * provider. Workspace-scoped pages additionally mount the full shell in
 * `w/[slug]/layout.tsx`. Account-level settings (`/settings/account`,
 * `/settings/access`, `/settings/workspaces`) render inside
 * `(app)/settings/layout.tsx` which adds its own chromeless shell. The
 * `/w/[slug]/settings/{account,appearance,access,workspaces}` paths are thin
 * redirect stubs to those bare `/settings/*` surfaces, so old workspace-scoped
 * links keep resolving.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <TrpcProvider>
      <PushNotificationProvider />
      {children}
    </TrpcProvider>
  );
}
