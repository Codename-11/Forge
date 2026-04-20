import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { QuickCreate } from "@/components/quick-create";
import { RealtimeProvider } from "@/components/realtime-provider";
import { TrpcProvider } from "@/lib/trpc-provider";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) {
    // No workspace yet — send to onboarding (placeholder for now).
    redirect("/signin");
  }

  const ws = membership.workspace;

  return (
    <TrpcProvider workspaceId={ws.id}>
      <div className="flex h-svh overflow-hidden">
        <Sidebar
          workspace={{ name: ws.name, key: ws.key, avatarUrl: ws.avatarUrl }}
          user={{
            name: session.user.name,
            image: session.user.image,
            email: session.user.email,
          }}
        />
        <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
      </div>
      <CommandPalette />
      <QuickCreate />
      <RealtimeProvider workspaceId={ws.id} />
    </TrpcProvider>
  );
}
