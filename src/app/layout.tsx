import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" closeButton richColors theme="system" />
        </ThemeProvider>
      </body>
    </html>
  );
}
