import { Icon } from "@/components/icon";
import { SectionShell } from "@/components/primitives";

type DocItem = { name: string; path: string; blurb: string };
type DocGroup = { title: string; icon: string; items: DocItem[] };

export function DocsContent() {
  const groups: DocGroup[] = [
    {
      title: "Get started",
      icon: "Rocket",
      items: [
        { name: "Install Forge", path: "docs.forge.dev/install", blurb: "Postgres, Node, 60 seconds." },
        { name: "Your first issue", path: "docs.forge.dev/first-issue", blurb: "C anywhere. Title. Save." },
        { name: "Connect an agent", path: "docs.forge.dev/connect-agent", blurb: "Hermes, Orca, Claude, Codex." },
        { name: "Self-host with Docker", path: "docs.forge.dev/docker", blurb: "Compose file + env vars." },
      ],
    },
    {
      title: "Runtimes & agents",
      icon: "Bot",
      items: [
        { name: "Hermes setup", path: "docs.forge.dev/hermes", blurb: "Persistent gateway." },
        { name: "Orca ADE integration", path: "docs.forge.dev/orca", blurb: "Auto-open + dispatch." },
        { name: "Claude Code (MCP)", path: "docs.forge.dev/claude-code", blurb: "Drop-in config." },
        { name: "Codex CLI (MCP)", path: "docs.forge.dev/codex", blurb: "Streamable HTTP." },
        { name: "Custom HTTP webhook", path: "docs.forge.dev/custom-http", blurb: "BYO bridge." },
        { name: "Dispatch rules", path: "docs.forge.dev/dispatch", blurb: "Capability matching." },
      ],
    },
    {
      title: "Reference",
      icon: "BookOpen",
      items: [
        { name: "tRPC API", path: "docs.forge.dev/api", blurb: "Every router + procedure." },
        { name: "MCP tool catalogue", path: "docs.forge.dev/mcp", blurb: "14 tools, all keyboard-driven." },
        { name: "Webhook payloads", path: "docs.forge.dev/webhooks", blurb: "Signing, retries, headers." },
        { name: "Prisma schema", path: "docs.forge.dev/schema", blurb: "The source of truth." },
        { name: "CLI · forge daemon", path: "docs.forge.dev/cli", blurb: "Local runtime." },
        { name: "Keyboard shortcuts", path: "docs.forge.dev/shortcuts", blurb: "Cheat sheet." },
      ],
    },
  ];
  return (
    <SectionShell
      titleAs="h1"
      eyebrow="docs · docs.forge.dev"
      title="Read it once. Bookmark forever."
      kicker="Everything you need to install Forge, connect an agent, and ship the first plan."
    >
      {/* Search bar */}
      <div style={{ marginBottom: 36, padding: "14px 18px", border: "1px solid hsl(var(--border))", background: "hsl(var(--card))", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name="Search" size={15} style={{ color: "hsl(var(--muted-foreground))" }} />
        <span style={{ flex: 1, fontSize: 14, color: "hsl(var(--muted-foreground))" }}>Search the docs…</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, padding: "2px 7px", border: "1px solid hsl(var(--border))", borderRadius: 3, color: "hsl(var(--muted-foreground))" }}>⌘ K</span>
      </div>

      <div className="lnd-cols-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 24 }}>
        {groups.map((g, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 14, padding: 22, border: "1px solid hsl(var(--border))", background: "hsl(var(--card) / 0.7)", borderRadius: "var(--radius)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 26, height: 26, display: "grid", placeItems: "center", background: "hsl(var(--ember) / 0.13)", color: "hsl(var(--ember))", borderRadius: 5 }}>
                <Icon name={g.icon} size={14} />
              </span>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.005em" }}>{g.title}</h2>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {g.items.map((it, j) => (
                <a
                  key={j}
                  href="#"
                  className="lnd-doclink"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    padding: "9px 10px",
                    margin: "0 -10px",
                    borderRadius: 4,
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{it.name}</span>
                    <Icon name="ArrowRight" size={11} style={{ color: "hsl(var(--muted-foreground))" }} />
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>{it.path}</span>
                  <span style={{ fontSize: 11.5, color: "hsl(var(--muted-foreground))" }}>{it.blurb}</span>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
