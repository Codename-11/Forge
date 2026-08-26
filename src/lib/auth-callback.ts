/**
 * Keep authentication callbacks on this Forge instance. NextAuth also checks
 * redirect origins, but public auth pages use this helper before rendering
 * links and hidden form values so an untrusted URL never reaches the UI.
 */
export function safeAuthCallbackUrl(value: string | null | undefined): string {
  if (!value) return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//")) return "/dashboard";

  try {
    const parsed = new URL(value, "http://forge.local");
    if (parsed.origin !== "http://forge.local") return "/dashboard";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/dashboard";
  }
}

export function authPath(pathname: string, callbackUrl?: string): string {
  const callback = safeAuthCallbackUrl(callbackUrl);
  return `${pathname}?callbackUrl=${encodeURIComponent(callback)}`;
}
