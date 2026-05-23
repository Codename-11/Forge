import { redirect } from "next/navigation";

/**
 * Webhook deliveries moved from `/settings/integrations/deliveries` to the
 * flatter `/settings/deliveries`. This redirect preserves old links and any
 * query string (status / agentId / deliveryId deep-links from the agents
 * page still resolve).
 */
export default async function DeliveriesRedirect({
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
  redirect(`/w/${slug}/settings/deliveries${query ? `?${query}` : ""}`);
}
