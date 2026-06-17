import type { Metadata } from "next";
import { LandingNav } from "@/components/nav";
import { LandingFooter } from "@/components/footer";
import { DocsContent } from "@/components/docs-content";

const DESCRIPTION =
  "Everything you need to install Forge, connect an agent, and ship the first plan. Get started, runtimes & agents, and full reference.";

export const metadata: Metadata = {
  title: "Docs",
  description: DESCRIPTION,
  alternates: { canonical: "/docs/" },
  openGraph: {
    type: "website",
    siteName: "Forge",
    url: "/docs/",
    title: "Docs · Forge",
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Forge — issue tracking for humans & agents." }],
  },
};

// Docs landing — ported from the prototype's DocsPage.
export default function DocsPage() {
  return (
    <div
      style={{
        background: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        fontFamily: "var(--font-sans)",
        minHeight: "100%",
      }}
    >
      <LandingNav />
      <main>
        <DocsContent />
      </main>
      <LandingFooter />
    </div>
  );
}
