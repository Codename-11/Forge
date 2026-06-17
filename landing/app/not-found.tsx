import { LandingNav } from "@/components/nav";
import { LandingFooter } from "@/components/footer";
import { Eyebrow, GhostButton } from "@/components/primitives";

export default function NotFound() {
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
      <main
        className="lnd-pad"
        style={{
          padding: "140px 96px",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 18,
          maxWidth: 720,
        }}
      >
        <Eyebrow tone="ember">error · 404</Eyebrow>
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(40px, 7vw, 88px)",
            fontWeight: 600,
            letterSpacing: "-0.035em",
            lineHeight: 0.98,
            textWrap: "balance",
          }}
        >
          This page took a different <span style={{ color: "hsl(var(--ember))" }}>dispatch</span>.
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: 17,
            lineHeight: 1.55,
            color: "hsl(var(--muted-foreground))",
            maxWidth: 520,
          }}
        >
          The URL you followed doesn&rsquo;t resolve to a page. Head back to the
          workspace, or jump straight to the docs.
        </p>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <GhostButton primary icon="ArrowRight" href="/">
            Back to home
          </GhostButton>
          <GhostButton icon="BookOpen" href="/docs/">
            Read the docs
          </GhostButton>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
