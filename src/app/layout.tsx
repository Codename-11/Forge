import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
import { NativeTooltips } from "@/components/native-tooltips";
import { readAppearance } from "@/server/appearance";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://forge.axiom-labs.dev";
const TITLE = "Forge — project management for humans and agents";
const DESCRIPTION =
  "Fast, keyboard-driven project management. Extensible via plugins, skills, and the Model Context Protocol.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Forge",
    template: "%s · Forge",
  },
  description: DESCRIPTION,
  applicationName: "Forge",
  keywords: [
    "project management",
    "issue tracking",
    "kanban",
    "MCP",
    "Model Context Protocol",
    "agents",
    "Linear alternative",
  ],
  authors: [{ name: "Axiom Labs" }],
  creator: "Axiom Labs",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Forge",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fef3e6" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1917" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Stamp the operator's appearance prefs onto <html> at SSR so the very
  // first paint already has the correct density + text size — the legacy
  // AppearanceProvider effect was the source of a noticeable resize flash
  // on every reload. AppearanceProvider still runs the catch-up + cookie
  // sync once trpc.user.me resolves on the client.
  const appearance = await readAppearance();
  return (
    <html
      lang="en"
      data-density={appearance.density}
      data-textsize={appearance.textSize}
      data-motion={appearance.motion === "reduced" ? "off" : "on"}
      data-bg={appearance.background}
      suppressHydrationWarning
    >
      <body className="font-sans">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" closeButton richColors theme="system" />
          {/* Themed tooltips app-wide — intercepts every `title` attribute
              and renders a token-styled tooltip instead of the browser's
              native one (restoring `title` at rest for a11y). */}
          <NativeTooltips />
        </ThemeProvider>
      </body>
    </html>
  );
}
