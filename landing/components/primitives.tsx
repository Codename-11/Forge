import type { CSSProperties, ReactNode } from "react";
import { Icon } from "@/components/icon";

/* Small primitives local to the landing site — ported from the prototype's
   landing-sections.jsx. Visuals are token-driven inline styles; the only
   additions over the prototype are responsive class hooks (.lnd-btn /
   .lnd-pad) defined in globals.css and a clamp() on the section title. */

export function Eyebrow({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "ember";
}) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.16em",
        color: tone === "ember" ? "hsl(var(--ember))" : "hsl(var(--muted-foreground))",
      }}
    >
      {children}
    </div>
  );
}

export function GhostButton({
  children,
  icon,
  kbd,
  href = "#",
  primary = false,
  mono = false,
  style,
}: {
  children: ReactNode;
  icon?: string;
  kbd?: string;
  href?: string;
  primary?: boolean;
  mono?: boolean;
  style?: CSSProperties;
}) {
  return (
    <a
      href={href}
      className="lnd-btn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: primary ? "10px 16px" : "10px 14px",
        background: primary ? "hsl(var(--ember))" : "hsl(var(--card) / 0.6)",
        color: primary ? "hsl(var(--ember-foreground))" : "hsl(var(--foreground))",
        border: primary ? "1px solid hsl(var(--ember))" : "1px solid hsl(var(--border))",
        borderRadius: "calc(var(--radius) - 2px)",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: 13,
        fontWeight: primary ? 600 : 500,
        textDecoration: "none",
        letterSpacing: mono ? 0 : "-0.005em",
        boxShadow: primary
          ? "0 1px 0 hsl(var(--ember) / 0.4), 0 0 0 1px hsl(var(--ember) / 0.5) inset"
          : "0 1px 0 hsl(var(--background))",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={13} />}
      <span>{children}</span>
      {kbd && (
        <span
          style={{
            marginLeft: 4,
            opacity: 0.7,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            letterSpacing: "0.06em",
            border: "1px solid currentColor",
            borderRadius: 3,
            padding: "1px 5px",
            display: "inline-flex",
            alignItems: "center",
            color: primary ? "hsl(var(--ember-foreground))" : "hsl(var(--muted-foreground))",
            borderColor: primary ? "hsl(var(--ember-foreground) / 0.4)" : "hsl(var(--border))",
          }}
        >
          {kbd}
        </span>
      )}
    </a>
  );
}

export function SectionShell({
  id,
  eyebrow,
  title,
  titleAs = "h2",
  kicker,
  children,
  pad = "120px 96px",
  padClass = "lnd-pad",
  bg,
  style,
}: {
  id?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Heading level for the title. Sub-pages pass "h1" so each page has one. */
  titleAs?: "h1" | "h2";
  kicker?: ReactNode;
  children?: ReactNode;
  pad?: string;
  /** Responsive padding hook. Product strip uses "lnd-pad-left" to keep its
   *  right-edge bleed; everything else uses the default "lnd-pad". */
  padClass?: string;
  bg?: string;
  style?: CSSProperties;
}) {
  const TitleTag = titleAs;
  return (
    <section
      id={id}
      className={padClass}
      style={{
        padding: pad,
        background: bg || "transparent",
        position: "relative",
        ...style,
      }}
    >
      {(eyebrow || title || kicker) && (
        <header style={{ maxWidth: 920, marginBottom: 56 }}>
          {eyebrow && (
            <div style={{ marginBottom: 14 }}>
              <Eyebrow tone="ember">{eyebrow}</Eyebrow>
            </div>
          )}
          {title && (
            <TitleTag
              style={{
                fontSize: "clamp(30px, 5.4vw, 44px)",
                fontWeight: 600,
                letterSpacing: "-0.025em",
                lineHeight: 1.05,
                margin: 0,
                textWrap: "balance",
                maxWidth: 820,
              }}
            >
              {title}
            </TitleTag>
          )}
          {kicker && (
            <p
              style={{
                marginTop: 16,
                marginBottom: 0,
                fontSize: 17,
                lineHeight: 1.55,
                color: "hsl(var(--muted-foreground))",
                maxWidth: 680,
                textWrap: "pretty",
              }}
            >
              {kicker}
            </p>
          )}
        </header>
      )}
      {children}
    </section>
  );
}
