"use server";

import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { acceptWorkspaceInvitation } from "@/server/services/workspace-invitations";

export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!token || token.length > 256) redirect("/signin");
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`);
  }
  const result = await acceptWorkspaceInvitation({
    token,
    userId: session.user.id,
    userEmail: session.user.email,
  });
  if (result.state === "ACCEPTED" || result.state === "ALREADY_MEMBER") {
    redirect(`/w/${result.workspaceSlug}/dashboard?invite=accepted`);
  }
  redirect(`/invite/${token}?result=${result.state.toLowerCase()}`);
}
