import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Self-hosted via next/font; bound to --font-sans / --font-mono in globals.css.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://forge-pm.dev";
const TITLE = "Forge — issue tracking for humans & agents";
const DESCRIPTION =
  "An open-source work tracker built for the handoff between humans and agents. Humans file, agents pick up, humans review — same issues, same plans, same keyboard. Self-host in 60 seconds.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · Forge",
  },
  description: DESCRIPTION,
  applicationName: "Forge",
  keywords: [
    "issue tracking",
    "project management",
    "AI agents",
    "MCP",
    "Model Context Protocol",
    "Hermes",
    "Codex",
    "Claude Code",
    "self-hosted",
    "open source",
    "Linear alternative",
  ],
  authors: [{ name: "Forge" }],
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
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#16140f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-motion="on"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
