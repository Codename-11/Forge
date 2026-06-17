import { Icon } from "@/components/icon";
import { GhostButton } from "@/components/primitives";
import { LATEST_RELEASE, VERSION_LABEL } from "@/lib/releases";

function HeroVisual() {
  // A composed stylized "dispatch" frame — the story Forge tells: an
  // issue is filed by a human, picked up by an agent runtime, and runs
  // through a plan. Static React, all token-driven.
  return (
    <div
      className="lnd-hero-visual"
      style={{
        position: "relative",
        height: 520,
        borderRadius: "calc(var(--radius) + 4px)",
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card) / 0.55)",
        overflow: "hidden",
        boxShadow:
          "0 1px 0 hsl(var(--background)) inset, 0 30px 60px -30px hsl(var(--ember) / 0.18), 0 10px 30px -15px hsl(var(--foreground) / 0.18)",
      }}
    >
      {/* faint grid background */}
      <div
        className="forge-grid-bg"
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.45,
          maskImage: "radial-gradient(120% 70% at 50% 30%, black 50%, transparent 95%)",
          WebkitMaskImage: "radial-gradient(120% 70% at 50% 30%, black 50%, transparent 95%)",
        }}
      />
      {/* ember aurora */}
      <div className="forge-aurora" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      {/* fake app chrome */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid hsl(var(--border) / 0.7)",
          background: "hsl(var(--background) / 0.7)",
        }}
      >
        <span style={{ display: "flex", gap: 6 }}>
          <i style={{ width: 9, height: 9, borderRadius: 9999, background: "hsl(0 60% 64%)" }} />
          <i style={{ width: 9, height: 9, borderRadius: 9999, background: "hsl(45 80% 60%)" }} />
          <i style={{ width: 9, height: 9, borderRadius: 9999, background: "hsl(140 40% 56%)" }} />
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>
          forge / w/forge / activity
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "hsl(var(--muted-foreground))",
          }}
        >
          <span className="forge-breath" style={{ display: "inline-block", width: 6, height: 6, borderRadius: 9999, background: "hsl(var(--success))" }} />
          3 running · 2 queued
        </span>
      </div>

      <div style={{ position: "absolute", inset: "44px 22px 22px", display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)", gap: 18 }}>
        {/* Left: an issue card flowing into a plan */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <DispatchCard />
          <PlanProgressCard />
        </div>

        {/* Right: agent runtimes column */}
        <RuntimePeek />
      </div>
    </div>
  );
}

function DispatchCard() {
  return (
    <div
      style={{
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card))",
        borderRadius: "var(--radius)",
        padding: 14,
        boxShadow: "0 1px 0 hsl(var(--background))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 6px",
            background: "hsl(var(--ember) / 0.12)",
            color: "hsl(var(--ember))",
            borderRadius: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 600,
          }}
        >
          Dispatching
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>FRG-128</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-0.005em" }}>
        Cut chat-stream tail latency below 250ms
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 7px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 5,
            fontSize: 11,
            color: "hsl(var(--muted-foreground))",
          }}
        >
          <i style={{ width: 6, height: 6, borderRadius: 9999, background: "hsl(0 60% 50%)" }} />
          urgent
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 7px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 5,
            fontSize: 11,
            color: "hsl(var(--muted-foreground))",
          }}
        >
          <i style={{ width: 6, height: 6, borderRadius: 9999, background: "hsl(195 70% 40%)" }} />
          backend
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>match · capability</span>
        <Icon name="ArrowRight" size={12} style={{ color: "hsl(var(--ember))" }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 7px",
            background: "hsl(var(--ember) / 0.12)",
            color: "hsl(var(--ember))",
            borderRadius: 5,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          🔷 @victor
        </span>
      </div>
    </div>
  );
}

function PlanProgressCard() {
  const steps = [
    { label: "Replay scope on existing keys", state: "done" },
    { label: "Adapter registry · phase 2", state: "running" },
    { label: "Webhook backoff tuning", state: "pending" },
    { label: "Verify p99 < 250ms", state: "pending" },
  ];
  return (
    <div
      style={{
        flex: 1,
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card))",
        borderRadius: "var(--radius)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="Workflow" size={13} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Plan · auto-dispatch capability matching</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>
          step 2 / 4
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 9999,
                background: s.state === "done" ? "hsl(var(--success))" : "transparent",
                border: s.state === "running" ? "1.5px solid hsl(var(--ember))" : "1.5px solid hsl(var(--border))",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
              className={s.state === "running" ? "forge-active-node" : undefined}
            >
              {s.state === "done" && <Icon name="Check" size={9} style={{ color: "white" }} />}
              {s.state === "running" && <i style={{ width: 5, height: 5, borderRadius: 9999, background: "hsl(var(--ember))" }} />}
            </span>
            <span style={{ color: s.state === "pending" ? "hsl(var(--muted-foreground))" : "hsl(var(--foreground))" }}>
              {s.label}
            </span>
            {s.state === "running" && (
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--ember))" }}>
                · running
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RuntimePeek() {
  const runtimes = [
    { name: "hermes-prod",       provider: "Hermes",      tier: "first-class", load: "2 / 3", color: "hsl(210 60% 55%)" },
    { name: "codex-app-server",  provider: "Codex App",   tier: "first-class", load: "1 / 2", color: "hsl(var(--ember))" },
    { name: "claude-mcp",        provider: "Claude Code", tier: "MCP",         load: "—",   color: "hsl(30 50% 45%)" },
    { name: "codex-cli",         provider: "Codex CLI",   tier: "MCP",         load: "—",   color: "hsl(265 30% 50%)" },
    { name: "orca-bridge",       provider: "Orca",        tier: "connector",   load: "—",   color: "hsl(150 35% 45%)" },
  ];
  return (
    <div
      style={{
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card))",
        borderRadius: "var(--radius)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="Server" size={13} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Runtimes</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>5 connected</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {runtimes.map((r, i) => {
          const tierFg = r.tier === "first-class" ? "hsl(var(--ember))" : r.tier === "MCP" ? "hsl(var(--muted-foreground))" : "hsl(var(--muted-foreground))";
          const tierBg = r.tier === "first-class" ? "hsl(var(--ember) / 0.13)" : "hsl(var(--muted))";
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 10px",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                background: r.tier === "first-class" ? "hsl(var(--background) / 0.8)" : "hsl(var(--muted) / 0.3)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: r.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "hsl(var(--foreground))" }}>{r.name}</span>
              <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>{r.provider}</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  padding: "1px 4px",
                  background: tierBg,
                  color: tierFg,
                  borderRadius: 3,
                  fontWeight: 600,
                }}
              >
                {r.tier}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>{r.load}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "hsl(var(--muted-foreground))",
          padding: "8px 10px",
          background: "hsl(var(--muted) / 0.4)",
          borderRadius: 5,
          border: "1px dashed hsl(var(--border))",
        }}
      >
        <span style={{ color: "hsl(var(--ember))" }}>+</span> Add runtime · <span style={{ color: "hsl(var(--foreground))" }}>forge daemon start</span>
      </div>
    </div>
  );
}

export function LandingHero() {
  return (
    <section
      id="top"
      className="lnd-pad"
      style={{
        position: "relative",
        padding: "84px 96px 96px",
        overflow: "hidden",
      }}
    >
      <div className="forge-glow-grid" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div className="forge-glow-grid-dots" />
        <div className="forge-glow-grid-blob forge-glow-grid-blob-a" />
        <div className="forge-glow-grid-blob forge-glow-grid-blob-b" />
      </div>

      <div className="lnd-hero-grid" style={{ position: "relative", display: "grid", gridTemplateColumns: "minmax(0, 0.85fr) minmax(0, 1.15fr)", gap: 64, alignItems: "center" }}>
        <div>
          <h1
            style={{
              marginTop: 0,
              marginBottom: 0,
              fontSize: "clamp(40px, 8.6vw, 124px)",
              lineHeight: 0.94,
              fontWeight: 600,
              letterSpacing: "-0.045em",
              textWrap: "balance",
            }}
          >
            Issue tracking for Humans &amp; <span style={{ color: "hsl(var(--ember))" }}>Agents</span>.
          </h1>
          <p
            style={{
              marginTop: 26,
              marginBottom: 0,
              fontSize: 19,
              lineHeight: 1.5,
              color: "hsl(var(--muted-foreground))",
              maxWidth: 520,
              textWrap: "pretty",
            }}
          >
            Humans file, agents pick up, humans review — same issues, same plans, same keyboard. One workspace for the work humans and agents do together.
          </p>

          <div style={{ marginTop: 36, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <GhostButton primary icon="Terminal" href="#self-host">Self-host in 60 seconds</GhostButton>
            <GhostButton icon="GitBranch" href="https://github.com/Codename-11/forge" mono>
              github.com/Codename-11/forge
            </GhostButton>
          </div>

          <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 14, fontSize: 12.5, color: "hsl(var(--muted-foreground))" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span className="forge-breath" style={{ width: 6, height: 6 }} />
              {VERSION_LABEL} · {LATEST_RELEASE.title} · {LATEST_RELEASE.date}
            </span>
            <span>·</span>
            <span>MIT · Postgres + Node · self-host or fly.io</span>
          </div>
        </div>

        <HeroVisual />
      </div>
    </section>
  );
}
