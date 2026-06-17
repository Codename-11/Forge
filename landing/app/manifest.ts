import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Forge — issue tracking for humans & agents",
    short_name: "Forge",
    description:
      "An open-source work tracker built for the handoff between humans and agents. Self-host in 60 seconds.",
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: "#fef3e6",
    theme_color: "#d97706",
    prefer_related_applications: false,
    icons: [
      { src: "/icons/forge-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/forge-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/forge-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
