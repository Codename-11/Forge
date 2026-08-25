"use server";

import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import {
  acceptWorkspaceInvitation,
  registerLocalAccountFromInvitation,
} from "@/server/services/workspace-invitations";

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

export async function registerLocalInvitationAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const path = `/invite/${encodeURIComponent(token)}/local`;
  if (!token || token.length > 256 || !name || name.length > 80) {
    redirect(`${path}?error=invalid`);
  }
  if (password !== confirmPassword) redirect(`${path}?error=mismatch`);
  let result: Awaited<ReturnType<typeof registerLocalAccountFromInvitation>>;
  try {
    result = await registerLocalAccountFromInvitation({ token, name, password });
  } catch {
    redirect(`${path}?error=password`);
  }
  if (result.state === "CREATED") {
    redirect(
      `/signin/local?${new URLSearchParams({
        notice: "activated",
        callbackUrl: `/w/${result.workspaceSlug}/dashboard?invite=accepted`,
      })}`,
    );
  }
  if (result.state === "EXISTING_ACCOUNT") {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/invite/${token}`)}&manual=1`);
  }
  redirect(`${path}?error=${result.state.toLowerCase()}`);
}
