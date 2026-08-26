"use server";

import { redirect } from "next/navigation";
import { auth, signIn } from "@/server/auth";
import { bustSsoCache, getEnabledSsoRows, providerIdFor } from "@/server/sso";

/**
 * Start an explicit provider-link flow from an authenticated account. Auth.js
 * binds the callback to the current User session; the provider reauthentication
 * proves control of the external identity. Operational Connections are never
 * touched by this login-method action.
 */
export async function linkIdentityAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin?manual=1");
  const requested = String(formData.get("providerId") ?? "");
  // The chooser is rendered from a direct account-security query while Auth.js
  // uses a short provider cache. Refresh before resolving the request so a
  // just-enabled provider is usable immediately.
  bustSsoCache();
  const provider = (await getEnabledSsoRows()).find(
    (candidate) => providerIdFor(candidate) === requested,
  );
  if (!provider) redirect("/settings/security?error=provider-unavailable");
  await signIn(requested, { redirectTo: "/settings/security?linked=1" });
}
