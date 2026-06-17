import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://forge.axiom-labs.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  // Trailing slashes match the exported canonical routes (trailingSlash: true).
  return ["/", "/releases/", "/docs/"].map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
