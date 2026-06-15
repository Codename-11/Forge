import "server-only";
import type { NextRequest } from "next/server";

/**
 * The public origin of this Forge instance for a given request — correct even
 * behind a reverse proxy (Traefik), where `new URL(req.url).origin` resolves to
 * the internal bind (e.g. `https://0.0.0.0:3000`).
 *
 * Priority: the proxy's `X-Forwarded-Host`/`-Proto` (per-request, host-accurate)
 * → the configured public URL env → the raw request origin as a last resort.
 * Used wherever we hand a URL back to a browser or to GitHub (manifest
 * redirect/setup URLs, the baked default base in the provisioning script).
 */
export function publicOrigin(req: NextRequest): string {
  const xfHost = req.headers.get("x-forwarded-host");
  if (xfHost) {
    const host = xfHost.split(",")[0].trim();
    const proto = (req.headers.get("x-forwarded-proto") || "https").split(",")[0].trim();
    if (host) return `${proto}://${host}`;
  }
  const env = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
  if (env) return env.replace(/\/+$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}
