import { GhostButton, SectionShell } from "@/components/primitives";
import { RELEASES, type Release } from "@/lib/releases";

export function ReleaseRow({ r, expanded }: { r: Release; expanded?: boolean }) {
  return (
    <article
      className="lnd-release-row"
      style={{
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card) / 0.7)",
        borderRadius: "var(--radius)",
        padding: expanded ? 24 : 18,
        display: "grid",
        gridTemplateColumns: "180px minmax(0, 1fr)",
        gap: 28,
        alignItems: "flex-start",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "hsl(var(--ember))" }}>{r.v}</span>
        <span style={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }}>{r.date}</span>
        <span style={{ marginTop: 4, alignSelf: "flex-start", padding: "1px 6px", border: "1px solid hsl(var(--border))", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.12em", color: "hsl(var(--muted-foreground))" }}>{r.tag}</span>
      </div>
      <div>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.005em" }}>{r.title}</h3>
        <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 7 }}>
          {r.bullets.map((b, i) => (
            <li key={i} style={{ display: "flex", gap: 9, fontSize: 13, lineHeight: 1.5, color: "hsl(var(--muted-foreground))" }}>
              <span style={{ width: 4, height: 4, borderRadius: 9999, background: "hsl(var(--ember))", marginTop: 9, flexShrink: 0 }} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function LandingReleasesPreview() {
  return (
    <SectionShell
      id="releases"
      eyebrow="06 · changelog"
      title="Shipping every week or two."
      kicker="Tracked in the open on GitHub. Releases are tagged, signed, and tested against the same seed data you'd run locally."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {RELEASES.map((r, i) => <ReleaseRow key={i} r={r} />)}
      </div>
      <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 12 }}>
        <GhostButton icon="ArrowRight" href="/releases/">See all releases</GhostButton>
        <GhostButton icon="GitBranch" href="https://github.com/Codename-11/forge/releases" mono>github.com/.../releases</GhostButton>
      </div>
    </SectionShell>
  );
}
