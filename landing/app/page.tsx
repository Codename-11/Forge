import type { Metadata } from "next";
import { LandingNav } from "@/components/nav";
import { LandingHero } from "@/components/hero";
import { LandingPillars } from "@/components/pillars";
import { LandingRuntimes } from "@/components/runtimes";
import { LandingProductStrip } from "@/components/product-strip";
import { LandingPlanning } from "@/components/planning";
import { LandingSelfHost } from "@/components/self-host";
import { LandingReleasesPreview } from "@/components/releases-section";
import { LandingFooter } from "@/components/footer";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

// Full landing page — composed from the section components (ported from the
// prototype's LandingPageFull). The page reflows responsively; there is no
// separate mobile route (the prototype's mobile artboard was a preview).
export default function Home() {
  return (
    <div
      style={{
        background: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        fontFamily: "var(--font-sans)",
      }}
    >
      <LandingNav />
      <main>
        <LandingHero />
        <LandingPillars />
        <LandingRuntimes />
        <LandingProductStrip />
        <LandingPlanning />
        <LandingSelfHost />
        <LandingReleasesPreview />
      </main>
      <LandingFooter />
    </div>
  );
}
