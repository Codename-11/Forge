import type { Metadata } from "next";
import { LandingNav } from "@/components/nav";
import { LandingFooter } from "@/components/footer";
import { ReleaseRow } from "@/components/releases-section";
import { SectionShell, GhostButton } from "@/components/primitives";
import { Icon } from "@/components/icon";
import { RELEASES_ALL } from "@/lib/releases";

const DESCRIPTION =
  "Every Forge release, every tag, in the open. Patches are bug-fixes only; minors bring new surfaces. Signed and tagged on GitHub.";

export const metadata: Metadata = {
  title: "Releases",
  description: DESCRIPTION,
  alternates: { canonical: "/releases/" },
  openGraph: {
    type: "website",
    siteName: "Forge",
    url: "/releases/",
    title: "Releases · Forge",
    description: DESCRIPTION,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Forge — issue tracking for humans & agents." }],
  },
};

// Full changelog page — ported from the prototype's ReleasesPage.
export default function ReleasesPage() {
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
        <SectionShell
          titleAs="h1"
          eyebrow="changelog · github.com/Codename-11/forge/releases"
          title="Every release. Every tag. In the open."
          kicker="Forge ships every week or two. Patches are bug-fixes only; minors bring new surfaces. Releases are signed and tagged on GitHub."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {RELEASES_ALL.map((r, i) => (
              <ReleaseRow key={i} r={r} expanded />
            ))}
          </div>
          <div
            style={{
              marginTop: 36,
              padding: 24,
              border: "1px dashed hsl(var(--border))",
              borderRadius: 6,
              background: "hsl(var(--muted) / 0.3)",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <Icon name="GitBranch" size={16} style={{ color: "hsl(var(--muted-foreground))" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Subscribe to release notes</div>
              <div style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", marginTop: 3 }}>
                RSS · Atom · or watch the repo on GitHub.
              </div>
            </div>
            <GhostButton icon="Download" mono href="#" style={{ flexShrink: 0 }}>
              releases.atom
            </GhostButton>
          </div>
        </SectionShell>
      </main>
      <LandingFooter />
    </div>
  );
}
