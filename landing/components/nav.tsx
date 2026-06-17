import { Icon } from "@/components/icon";
import { GitHubStars } from "@/components/github-stars";
import { Logo } from "@/components/logo";
import { GhostButton } from "@/components/primitives";
import { ThemeToggle } from "@/components/theme-toggle";
import { REPO_URL, VERSION_SHORT } from "@/lib/releases";

export function LandingNav({ compact = false }: { compact?: boolean }) {
  // Absolute hrefs so the nav works from every page (the prototype used
  // bare in-page anchors, which are dead on /docs and /releases). Docs and
  // Changelog route to their real pages.
  const links: [string, string][] = [
    ["Features", "/#features"],
    ["Runtimes", "/#runtimes"],
    ["Docs", "/docs/"],
    ["Changelog", "/releases/"],
    ["Self-host", "/#self-host"],
  ];
  return (
    <nav
      className="lnd-nav"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "16px 32px",
        background: "hsl(var(--background) / 0.78)",
        backdropFilter: "saturate(140%) blur(8px)",
        WebkitBackdropFilter: "saturate(140%) blur(8px)",
        borderBottom: "1px solid hsl(var(--border) / 0.6)",
      }}
    >
      {/* Logo lockup */}
      <a href="/#top" style={{ display: "inline-flex", alignItems: "center", gap: 9, textDecoration: "none", color: "inherit" }}>
        <Logo size={22} />
        <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.01em" }}>Forge</span>
        <span
          className="lnd-nav-badge"
          style={{
            marginLeft: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "hsl(var(--ember))",
            border: "1px solid hsl(var(--ember) / 0.4)",
            borderRadius: 3,
            padding: "1px 5px",
            background: "hsl(var(--ember) / 0.08)",
          }}
        >
          {VERSION_SHORT} beta
        </span>
      </a>

      <div style={{ flex: 1 }} />

      {!compact && (
        <div className="lnd-nav-links" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {links.map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="lnd-navlink"
              style={{
                padding: "6px 10px",
                fontSize: 13,
                textDecoration: "none",
                borderRadius: 4,
              }}
            >
              {label}
            </a>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ThemeToggle />
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="lnd-nav-gh"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 10px",
            border: "1px solid hsl(var(--border))",
            borderRadius: "calc(var(--radius) - 2px)",
            background: "hsl(var(--card) / 0.6)",
            color: "hsl(var(--foreground))",
            textDecoration: "none",
            fontSize: 12.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          <Icon name="GitBranch" size={12} />
          <span>Codename-11/forge</span>
          <GitHubStars size={12} />
        </a>
        <GhostButton primary icon="ArrowRight" href="/#self-host">Get started</GhostButton>
      </div>
    </nav>
  );
}
