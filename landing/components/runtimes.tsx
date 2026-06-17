import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { SectionShell } from "@/components/primitives";

function RuntimeCard({
  tier,
  name,
  blurb,
  blurbColor,
  mode,
  status,
  snippet,
  snippetLabel,
  accent,
  glyph,
}: {
  tier: string;
  name: string;
  blurb: string;
  blurbColor?: string;
  mode: string;
  status: string;
  snippet: ReactNode;
  snippetLabel?: string;
  accent: string;
  glyph: string;
}) {
  return (
    <article
      style={{
        border: tier === "first-class" ? "1px solid hsl(var(--ember) / 0.55)" : "1px solid hsl(var(--border))",
        background: tier === "first-class" ? "hsl(var(--card))" : "hsl(var(--card) / 0.5)",
        borderRadius: "var(--radius)",
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        position: "relative",
        boxShadow: tier === "first-class" ? "0 0 0 4px hsl(var(--ember) / 0.06)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            background: accent,
            color: "hsl(var(--background))",
            borderRadius: 7,
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          {glyph}
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.005em" }}>{name}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: blurbColor || "hsl(var(--muted-foreground))", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {mode}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            padding: "2px 7px",
            borderRadius: 4,
            fontWeight: 600,
            background: tier === "first-class" ? "hsl(var(--ember) / 0.16)" : "hsl(var(--muted))",
            color: tier === "first-class" ? "hsl(var(--ember))" : "hsl(var(--muted-foreground))",
          }}
        >
          {tier}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "hsl(var(--muted-foreground))", textWrap: "pretty", minHeight: 60 }}>
        {blurb}
      </p>

      <pre
        style={{
          margin: 0,
          background: "hsl(var(--background) / 0.7)",
          border: "1px solid hsl(var(--border))",
          borderRadius: 6,
          padding: "9px 11px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "hsl(var(--foreground))",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        <span style={{ color: "hsl(var(--muted-foreground))" }}>{snippetLabel}</span>
        {"\n"}
        {snippet}
      </pre>

      <div style={{ display: "flex", alignItems: "center", gap: 9, paddingTop: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: 9999, background: status === "Live" ? "hsl(var(--success))" : status === "Beta" ? "hsl(var(--ember))" : "hsl(var(--muted-foreground))" }} />
        <span style={{ fontSize: 11.5, color: "hsl(var(--muted-foreground))" }}>{status}</span>
        <span style={{ flex: 1 }} />
        <a href="/docs/" style={{ fontSize: 11.5, color: "hsl(var(--foreground))", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
          Setup guide <Icon name="ArrowRight" size={11} />
        </a>
      </div>
    </article>
  );
}

function TierHeader({ n, label, blurb }: { n: string; label: string; blurb: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16, marginTop: 8 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))", letterSpacing: "0.12em" }}>{n}</span>
      <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.005em" }}>{label}</span>
      <span style={{ flex: 1, height: 1, background: "hsl(var(--border))" }} />
      <span style={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }}>{blurb}</span>
    </div>
  );
}

export function LandingRuntimes() {
  return (
    <SectionShell
      id="runtimes"
      eyebrow="02 · agents & runtimes"
      title="First-class runtimes. MCP for everything else."
      kicker="Two runtimes are built and maintained by us — always-on, full workspace members. Claude Code and Codex CLI plug in over MCP. Orca and your own bridges round it out as connectors."
      bg="hsl(var(--muted) / 0.35)"
    >
      <TierHeader n="TIER 1" label="First-class runtimes" blurb="Managed · persistent · full member" />
      <div className="lnd-cols-2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 20, marginBottom: 28 }}>
        <RuntimeCard
          tier="first-class"
          name="Hermes"
          mode="managed · persistent · webhook + MCP"
          status="Live · v1.4"
          blurbColor="hsl(210 60% 55%)"
          accent="hsl(210 65% 50%)"
          glyph="H"
          blurb="Always-on gateway. Signed push dispatch, MCP callbacks, model-router plugin. Use as the default route — no per-agent API keys to manage."
          snippetLabel="# forge.toml"
          snippet={
            <>
              <span style={{ color: "hsl(195 60% 45%)" }}>[runtime.hermes]</span>{"\n"}
              endpoint = <span style={{ color: "hsl(var(--ember))" }}>"https://hermes.forge.local"</span>{"\n"}
              providers = <span style={{ color: "hsl(var(--ember))" }}>["openai", "anthropic"]</span>{"\n"}
              <span style={{ color: "hsl(var(--success))" }}># forge daemon start</span>
            </>
          }
        />
        <RuntimeCard
          tier="first-class"
          name="Codex App Server"
          mode="managed · persistent · webhook"
          status="Live · v1.1"
          blurbColor="hsl(var(--ember))"
          accent="hsl(var(--ember))"
          glyph="C"
          blurb="The persistent counterpart to Codex CLI. Long-lived sessions, capability-matched dispatch, runs as a full agent — chat, plans, the lot."
          snippetLabel="# forge.toml"
          snippet={
            <>
              <span style={{ color: "hsl(195 60% 45%)" }}>[runtime.codex-app]</span>{"\n"}
              endpoint = <span style={{ color: "hsl(var(--ember))" }}>"ws://127.0.0.1:4500"</span>{"\n"}
              providers = <span style={{ color: "hsl(var(--ember))" }}>["openai"]</span>{"\n"}
              <span style={{ color: "hsl(var(--success))" }}># tier-2 capacity by default</span>
            </>
          }
        />
      </div>

      <TierHeader n="TIER 2" label="MCP clients" blurb="Single-session · drop in via config" />
      <div className="lnd-cols-2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 20, marginBottom: 28 }}>
        <RuntimeCard
          tier="MCP client"
          name="Claude Code"
          mode="single-session · MCP"
          status="Live"
          accent="hsl(28 40% 38%)"
          glyph="◇"
          blurb="Drop the Forge MCP URL into your config. Claude Code becomes a contributor — picks issues, leaves comments, files PR links back through the same protocol."
          snippetLabel="# ~/.config/claude/mcp.json"
          snippet={
            <>
              {"{"} <span style={{ color: "hsl(195 60% 45%)" }}>"forge"</span>: {"{ "}
              <span style={{ color: "hsl(195 60% 45%)" }}>"url"</span>: <span style={{ color: "hsl(var(--ember))" }}>"https://forge/mcp"</span> {"} }"}
            </>
          }
        />
        <RuntimeCard
          tier="MCP client"
          name="Codex CLI"
          mode="single-session · MCP"
          status="Live"
          accent="hsl(265 30% 45%)"
          glyph="X"
          blurb="Streamable HTTP MCP. Per-turn sandbox policy. Great for evaluation runs and one-shot fixes that don't need a long-lived runtime."
          snippetLabel="$ codex mcp add forge"
          snippet={
            <>
              codex mcp add forge \{"\n"}
              {"  "}<span style={{ color: "hsl(var(--muted-foreground))" }}>--url</span> <span style={{ color: "hsl(var(--ember))" }}>https://forge/mcp</span>{"\n"}
              codex run <span style={{ color: "hsl(var(--ember))" }}>"triage FRG-128"</span>
            </>
          }
        />
      </div>

      <TierHeader n="TIER 3" label="Connectors" blurb="Bring-your-own · webhook or local daemon" />
      <div className="lnd-cols-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        <RuntimeCard
          tier="connector"
          name="Orca"
          mode="agentic IDE · session"
          status="Integrated"
          accent="hsl(150 35% 40%)"
          glyph="O"
          blurb="Orca ADE talks to Forge through the MCP surface — issues open in the editor with their plan attached, results check back into the workspace."
          snippetLabel="# .orca/forge.yaml"
          snippet={
            <>
              workspace: <span style={{ color: "hsl(var(--ember))" }}>forge.local/w/forge</span>{"\n"}
              auto_open: <span style={{ color: "hsl(195 60% 45%)" }}>true</span>{"\n"}
              <span style={{ color: "hsl(var(--success))" }}># onorca.dev</span>
            </>
          }
        />
        <RuntimeCard
          tier="connector"
          name="Custom HTTP"
          mode="webhook · signed"
          status="Stable"
          accent="hsl(var(--muted-foreground))"
          glyph="↯"
          blurb="Any agent that speaks signed webhooks can register. Forge handles retries, dead-letter, replay — you just point at an endpoint."
          snippetLabel="$ curl forge/api/runtimes"
          snippet={
            <>
              {"{ "}<span style={{ color: "hsl(195 60% 45%)" }}>"kind"</span>: <span style={{ color: "hsl(var(--ember))" }}>"REMOTE_HTTP"</span>,{"\n"}
              {"  "}<span style={{ color: "hsl(195 60% 45%)" }}>"endpoint"</span>: <span style={{ color: "hsl(var(--ember))" }}>"https://yours.dev"</span> {"}"}
            </>
          }
        />
        <RuntimeCard
          tier="connector"
          name="forge daemon"
          mode="LOCAL · stdio + MCP"
          status="Stable"
          accent="hsl(35 25% 40%)"
          glyph="⌘"
          blurb="The local-daemon adapter. Runs on your laptop or build box, registers itself, and accepts dispatch over the same protocol as everything else."
          snippetLabel="$ forge daemon start"
          snippet={
            <>
              <span style={{ color: "hsl(120 50% 35%)" }}>✓</span> registered as{" "}
              <span style={{ color: "hsl(var(--ember))" }}>local-daemon</span>{"\n"}
              <span style={{ color: "hsl(120 50% 35%)" }}>✓</span> heartbeat · 12s{"\n"}
              <span style={{ color: "hsl(120 50% 35%)" }}>✓</span> mcp · 14 tools
            </>
          }
        />
      </div>
    </SectionShell>
  );
}
