import { Icon } from "@/components/icon";
import { GhostButton, SectionShell } from "@/components/primitives";
import { VERSION_LABEL } from "@/lib/releases";

export function LandingSelfHost() {
  return (
    <SectionShell
      id="self-host"
      eyebrow="05 · run it on your hardware"
      title="60 seconds from clone to first dispatch."
      kicker="Forge is open-source under the MIT license. Postgres and Node. Run it on a laptop, a VPS, or wire it into your existing infra."
      bg="hsl(var(--muted) / 0.35)"
    >
      <div className="lnd-cols-2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)", gap: 32, alignItems: "stretch" }}>
        {/* Code block */}
        <pre
          style={{
            margin: 0,
            // Fixed dark terminal surface in BOTH themes. The prototype
            // inverted onto --foreground/--background, which flipped to a
            // near-white block in dark mode and hid the green ✓ / ember text.
            background: "#16140f",
            color: "#f4efe6",
            borderRadius: "var(--radius)",
            padding: "22px 26px",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.65,
            border: "1px solid hsl(var(--border))",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <span style={{ position: "absolute", top: 12, right: 14, fontSize: 10, opacity: 0.5, textTransform: "uppercase", letterSpacing: "0.14em" }}>
            install.sh
          </span>
          <span style={{ opacity: 0.45 }}># 1. Clone</span>{"\n"}
          $ git clone <span style={{ color: "hsl(var(--ember))" }}>github.com/Codename-11/forge</span>{"\n"}
          $ cd forge{"\n"}
          {"\n"}
          <span style={{ opacity: 0.45 }}># 2. Bring up Postgres + the app</span>{"\n"}
          $ <span style={{ color: "hsl(var(--ember))" }}>docker compose</span> up -d{"\n"}
          {"\n"}
          <span style={{ opacity: 0.45 }}># 3. Seed a workspace with sample data</span>{"\n"}
          $ pnpm run seed <span style={{ opacity: 0.45 }}>--workspace forge</span>{"\n"}
          {"\n"}
          <span style={{ opacity: 0.45 }}># 4. Start the local daemon</span>{"\n"}
          $ <span style={{ color: "hsl(var(--ember))" }}>forge daemon start</span>{"\n"}
          <span style={{ color: "hsl(120 50% 70%)" }}>✓</span> http://localhost:3000{"\n"}
          <span style={{ color: "hsl(120 50% 70%)" }}>✓</span> mcp at /api/mcp{"\n"}
          <span style={{ color: "hsl(120 50% 70%)" }}>✓</span> heartbeat · 14s ago
        </pre>

        {/* Side panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[
            { icon: "Server", title: "Postgres + Node", body: "Nothing exotic. Runs alongside your other Next.js apps. Migrations via Prisma." },
            { icon: "Shield", title: "Your data, your box", body: "OIDC, Authelia, Keycloak, Okta — bring your own. API keys never leave Postgres." },
            { icon: "Plug", title: "MCP everywhere", body: "Every action is a tool. Wire Hermes, Orca, Claude Code, or your own bridge." },
            { icon: "GitBranch", title: "MIT, no rug-pull", body: "Build on it. Fork it. Run it forever. Releases tag every 1–2 weeks." },
          ].map((it, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "14px 14px", border: "1px solid hsl(var(--border))", background: "hsl(var(--card) / 0.7)", borderRadius: 6 }}>
              <span style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: "hsl(var(--ember) / 0.13)", color: "hsl(var(--ember))", borderRadius: 5, flexShrink: 0 }}>
                <Icon name={it.icon} size={13} />
              </span>
              <div>
                <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.005em" }}>{it.title}</h3>
                <p style={{ margin: "3px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "hsl(var(--muted-foreground))" }}>{it.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 32, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <GhostButton primary icon="Download" href="/releases/">Download {VERSION_LABEL}</GhostButton>
        <GhostButton icon="BookOpen" href="/docs/">Read the install guide</GhostButton>
        <GhostButton icon="GitBranch" href="https://github.com/Codename-11/forge/releases" mono>github.com/Codename-11/forge</GhostButton>
      </div>
    </SectionShell>
  );
}
