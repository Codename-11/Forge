import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { SectionShell } from "@/components/primitives";

/* Landing-site sections part 2: product strip, planning/activity callouts,
   self-host, releases, docs, footer + page-level compositions. */

// =========================================================================
// MINI SCREENS — stylized previews of Screens Board surfaces
// =========================================================================

type MiniFrameLabel = { n: string; name: string; path: string };

function MiniFrame({
  label,
  width = 380,
  height = 240,
  children,
}: {
  label: MiniFrameLabel;
  width?: number;
  height?: number;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: `0 0 ${width}px`,
        width,
        scrollSnapAlign: "start",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          width: "100%",
          height,
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--card))",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          position: "relative",
          boxShadow: "0 1px 0 hsl(var(--background)) inset, 0 18px 28px -22px hsl(var(--foreground) / 0.18)",
        }}
      >
        {/* chrome */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 10px",
            borderBottom: "1px solid hsl(var(--border) / 0.7)",
            background: "hsl(var(--background) / 0.7)",
          }}
        >
          <span style={{ display: "flex", gap: 4 }}>
            <i style={{ width: 6, height: 6, borderRadius: 9999, background: "hsl(0 60% 64%)" }} />
            <i style={{ width: 6, height: 6, borderRadius: 9999, background: "hsl(45 80% 60%)" }} />
            <i style={{ width: 6, height: 6, borderRadius: 9999, background: "hsl(140 40% 56%)" }} />
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "hsl(var(--muted-foreground))" }}>{label.path}</span>
        </div>
        <div style={{ padding: 12, height: "calc(100% - 26px)", overflow: "hidden" }}>
          {children}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "hsl(var(--muted-foreground))", letterSpacing: "0.1em" }}>{label.n}</span>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "hsl(var(--foreground))" }}>{label.name}</span>
      </div>
    </div>
  );
}

function MiniMissionControl() {
  const rows = [
    { st: "running", title: "Auto-dispatch capability matching", agent: "@victor", color: "hsl(var(--ember))" },
    { st: "running", title: "Slow board query investigation", agent: "@victor", color: "hsl(var(--ember))" },
    { st: "queued",  title: "Inbox triage walkthrough", agent: "@mizu", color: "hsl(var(--muted-foreground))" },
    { st: "done",    title: "Webhook delivery backoff", agent: "@victor", color: "hsl(var(--success))" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "hsl(var(--muted-foreground))", fontFamily: "var(--font-mono)" }}>
        <span className="forge-breath" style={{ width: 5, height: 5 }} />
        ACTIVITY · LIVE · 3 running
      </div>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "5px 7px",
            borderRadius: 4,
            background: r.st === "running" ? "hsl(var(--ember) / 0.06)" : "transparent",
            border: r.st === "running" ? "1px solid hsl(var(--ember) / 0.25)" : "1px solid transparent",
            fontSize: 10.5,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 9999, background: r.color, flexShrink: 0 }} />
          <span style={{ flex: 1, color: "hsl(var(--foreground))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--muted-foreground))", fontSize: 9.5 }}>{r.agent}</span>
        </div>
      ))}
    </div>
  );
}

function MiniIssueDetail() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "hsl(var(--muted-foreground))" }}>FRG-128</span>
        <span style={{ padding: "1px 5px", background: "hsl(var(--ember) / 0.13)", color: "hsl(var(--ember))", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em" }}>In progress</span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: "hsl(var(--foreground))" }}>
        Cut chat-stream tail latency below 250ms
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {["urgent","backend","perf"].map((l) => (
          <span key={l} style={{ padding: "1px 6px", border: "1px solid hsl(var(--border))", borderRadius: 4, fontSize: 10, color: "hsl(var(--muted-foreground))" }}>{l}</span>
        ))}
      </div>
      <div style={{ marginTop: 4, padding: 8, background: "hsl(var(--background) / 0.6)", border: "1px solid hsl(var(--border))", borderRadius: 5, fontSize: 10.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.5 }}>
        Backpressure on the ingest queue is dominating tail. Likely fix lives in the new adapter registry — gating GA.
      </div>
      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "hsl(var(--muted-foreground))" }}>
        <span style={{ width: 14, height: 14, borderRadius: 9999, background: "hsl(210 65% 50%)", color: "white", display: "grid", placeItems: "center", fontSize: 8, fontWeight: 600 }}>V</span>
        <span>@victor began plan · 23m</span>
      </div>
    </div>
  );
}

function MiniBoard() {
  const cols = [
    { name: "Todo",        items: 4, color: "hsl(var(--muted-foreground))" },
    { name: "In progress", items: 3, color: "hsl(var(--ember))" },
    { name: "Review",      items: 2, color: "hsl(45 80% 45%)" },
    { name: "Done",        items: 6, color: "hsl(var(--success))" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, height: "100%" }}>
      {cols.map((c, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px solid hsl(var(--border) / 0.6)", background: "hsl(var(--muted) / 0.3)", borderRadius: 4, padding: 5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, color: "hsl(var(--muted-foreground))" }}>
            <i style={{ width: 5, height: 5, borderRadius: 9999, background: c.color }} />
            <span>{c.name}</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{c.items}</span>
          </div>
          {Array.from({ length: c.items }).map((_, j) => (
            <div
              key={j}
              style={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border) / 0.6)",
                borderRadius: 3,
                padding: "4px 5px",
                fontSize: 8.5,
                color: "hsl(var(--foreground))",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {["MCP scope", "Auth flow", "Backoff", "Sample data", "Empty-state", "Quota guard", "Cycle edge"][j % 7]}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MiniAgents() {
  const agents = [
    { name: "victor", provider: "Hermes",     status: "ONLINE", load: "2/3", glyph: "🔷", accent: "hsl(210 60% 55%)" },
    { name: "mizu",   provider: "Hermes",     status: "BUSY",   load: "1/2", glyph: "💧", accent: "hsl(210 60% 55%)" },
    { name: "atlas",  provider: "Codex App",  status: "ONLINE", load: "0/2", glyph: "▲",  accent: "hsl(var(--ember))" },
    { name: "rune",   provider: "Codex CLI",  status: "IDLE",   load: "—",   glyph: "▣",  accent: "hsl(265 30% 45%)" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {agents.map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 7px", border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--background) / 0.5)" }}>
          <span style={{ fontSize: 12 }}>{a.glyph}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--foreground))" }}>@{a.name}</span>
          <span style={{ fontSize: 9.5, color: a.accent, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{a.provider}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: a.status === "ONLINE" ? "hsl(var(--success) / 0.15)" : a.status === "BUSY" ? "hsl(var(--ember) / 0.15)" : "hsl(var(--muted))", color: a.status === "ONLINE" ? "hsl(var(--success))" : a.status === "BUSY" ? "hsl(var(--ember))" : "hsl(var(--muted-foreground))", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{a.status}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "hsl(var(--muted-foreground))" }}>{a.load}</span>
        </div>
      ))}
    </div>
  );
}

function MiniDispatch() {
  const rules = [
    { match: "label:urgent + label:backend", target: "@victor", priority: 1 },
    { match: "label:frontend",               target: "@mizu",   priority: 2 },
    { match: "label:qa",                     target: "@atlas",  priority: 3 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "hsl(var(--muted-foreground))", textTransform: "uppercase", letterSpacing: "0.1em" }}>dispatch rules · priority order</div>
      {rules.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--background) / 0.5)", fontSize: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "hsl(var(--muted-foreground))", width: 14 }}>{r.priority}</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--foreground))", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.match}</span>
          <Icon name="ArrowRight" size={10} style={{ color: "hsl(var(--ember))" }} />
          <span style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--ember))" }}>{r.target}</span>
        </div>
      ))}
    </div>
  );
}

export function LandingProductStrip() {
  return (
    <SectionShell
      id="product"
      eyebrow="03 · the actual product"
      title="Built for the team that already shipped this once."
      kicker="A real work tracker. The shortcuts, the keyboard model, the views you expect — without the SaaS lock-in."
      pad="120px 0 120px 96px"
      padClass="lnd-pad-left"
    >
      <div
        style={{
          display: "flex",
          gap: 18,
          overflowX: "auto",
          overflowY: "hidden",
          paddingRight: 96,
          paddingBottom: 24,
          scrollSnapType: "x mandatory",
        }}
      >
        <MiniFrame label={{ n: "01", name: "Activity dock", path: "/w/forge/activity" }}>
          <MiniMissionControl />
        </MiniFrame>
        <MiniFrame label={{ n: "02", name: "Issue detail", path: "/w/forge/i/FRG-128" }}>
          <MiniIssueDetail />
        </MiniFrame>
        <MiniFrame label={{ n: "03", name: "Issues board", path: "/w/forge/issues" }}>
          <MiniBoard />
        </MiniFrame>
        <MiniFrame label={{ n: "04", name: "Agents", path: "/w/forge/settings/agents" }}>
          <MiniAgents />
        </MiniFrame>
        <MiniFrame label={{ n: "05", name: "Dispatch rules", path: "/w/forge/settings/dispatch" }}>
          <MiniDispatch />
        </MiniFrame>
      </div>
    </SectionShell>
  );
}
