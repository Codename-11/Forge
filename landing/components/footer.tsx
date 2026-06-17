import { Icon } from "@/components/icon";
import { GitHubStars } from "@/components/github-stars";
import { Logo } from "@/components/logo";
import { VERSION_LABEL } from "@/lib/releases";

export function LandingFooter() {
  const REPO = "https://github.com/Codename-11/forge";
  // [label, href]. Internal sections + real pages are wired; community
  // links that have no target yet stay as "#" placeholders.
  const cols: { title: string; items: [string, string][] }[] = [
    {
      title: "Product",
      items: [
        ["Features", "/#features"],
        ["Runtimes", "/#runtimes"],
        ["Activity dock", "/#planning"],
        ["Roadmap", "/releases/"],
      ],
    },
    {
      title: "Docs",
      items: [
        ["Install", "/docs/"],
        ["MCP reference", "/docs/"],
        ["Dispatch rules", "/docs/"],
        ["Self-host guide", "/#self-host"],
      ],
    },
    {
      title: "Open source",
      items: [
        ["GitHub", REPO],
        ["Releases", "/releases/"],
        ["Issues", `${REPO}/issues`],
        ["License (MIT)", `${REPO}/blob/main/LICENSE`],
      ],
    },
    {
      title: "Community",
      items: [
        ["Discord", "#"],
        ["Mastodon", "#"],
        ["Email", "#"],
        ["Security", "#"],
      ],
    },
  ];
  return (
    <footer
      className="lnd-footer"
      style={{
        padding: "72px 96px 56px",
        borderTop: "1px solid hsl(var(--border))",
        background: "hsl(var(--background))",
      }}
    >
      <div className="lnd-footer-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(4, 1fr)", gap: 48, marginBottom: 56 }}>
        <div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
            <Logo size={22} />
            <span style={{ fontWeight: 600, fontSize: 15 }}>Forge</span>
          </div>
          <p style={{ marginTop: 14, marginBottom: 0, fontSize: 13, lineHeight: 1.55, color: "hsl(var(--muted-foreground))", maxWidth: 280 }}>
            An open-source work tracker built for teams of humans <span style={{ color: "hsl(var(--foreground))" }}>and</span> agents.
          </p>
          <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>
            <span className="forge-breath" style={{ width: 6, height: 6 }} />
            <span>{VERSION_LABEL} · latest</span>
          </div>
        </div>
        {cols.map((c, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h5 style={{ margin: 0, fontSize: 11, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.14em", color: "hsl(var(--muted-foreground))" }}>{c.title}</h5>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 7 }}>
              {c.items.map(([label, href], j) => {
                const external = href.startsWith("http");
                return (
                  <li key={j}>
                    <a
                      href={href}
                      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                      style={{ fontSize: 13, color: "hsl(var(--foreground))", textDecoration: "none", borderBottom: "1px dotted hsl(var(--border))", paddingBottom: 1 }}
                    >
                      {label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="lnd-footer-bottom" style={{ display: "flex", alignItems: "center", gap: 16, paddingTop: 24, borderTop: "1px solid hsl(var(--border))", fontSize: 11.5, color: "hsl(var(--muted-foreground))", fontFamily: "var(--font-mono)" }}>
        <span>© 2026 Forge — MIT</span>
        <span>·</span>
        <span>built by humans + agents</span>
        <span style={{ flex: 1 }} />
        <a href="https://github.com/Codename-11/forge" style={{ color: "hsl(var(--muted-foreground))", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="GitBranch" size={11} />
          <span>github.com/Codename-11/forge</span>
          <GitHubStars size={11} />
        </a>
      </div>
    </footer>
  );
}
