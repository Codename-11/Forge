import { redirect } from "next/navigation";

/**
 * "Integrations" was renamed "Connections" and scoped down to pure
 * inbound/outbound external I/O. The agent-provider adapters that used to
 * live here (Hermes / Claude Code / Codex) moved to Settings → Agents,
 * where provider + runtime + connection now live on one card. This
 * redirect preserves old links (and any query string).
 */
export default async function IntegrationsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) value.forEach((v) => qs.append(key, v));
  }
  const query = qs.toString();
  redirect(`/w/${slug}/settings/connections${query ? `?${query}` : ""}`);
}
