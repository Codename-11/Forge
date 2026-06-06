import type { MetadataRoute } from "next";

const DESCRIPTION =
  "Fast, keyboard-driven project management. Extensible via plugins, skills, and the Model Context Protocol.";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Forge",
    short_name: "Forge",
    description: DESCRIPTION,
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fef3e6",
    theme_color: "#d97706",
    prefer_related_applications: false,
    shortcuts: [
      {
        name: "Mission Control",
        short_name: "Home",
        description: "Open Forge Mission Control.",
        url: "/",
        icons: [{ src: "/icons/forge-icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Inbox",
        short_name: "Inbox",
        description: "Open your cross-workspace Forge inbox.",
        url: "/inbox",
        icons: [{ src: "/icons/forge-icon-192.png", sizes: "192x192" }],
      },
      {
        name: "What's New",
        short_name: "Updates",
        description: "Open recent Forge changes.",
        url: "/whats-new",
        icons: [{ src: "/icons/forge-icon-192.png", sizes: "192x192" }],
      },
    ],
    icons: [
      {
        src: "/icons/forge-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/forge-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/forge-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
