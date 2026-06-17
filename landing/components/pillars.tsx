import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { SectionShell } from "@/components/primitives";

function PillarCard({
  n,
  icon,
  title,
  blurb,
  demo,
}: {
  n: string;
  icon: string;
  title: string;
  blurb: string;
  demo: ReactNode;
}) {
  return (
    <article
      style={{
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card) / 0.7)",
        borderRadius: "var(--radius)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minHeight: 320,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            background: "hsl(var(--ember) / 0.13)",
            color: "hsl(var(--ember))",
            borderRadius: 6,
          }}
        >
          <Icon name={icon} size={15} />
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))", letterSpacing: "0.1em" }}>{n}</span>
      </div>
      <h3 style={{ margin: 0, fontSize: 21, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.2 }}>{title}</h3>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "hsl(var(--muted-foreground))", textWrap: "pretty" }}>{blurb}</p>
      <div style={{ marginTop: "auto" }}>{demo}</div>
    </article>
  );
}

function PillarIssuesDemo() {
  const rows = [
    { id: "FRG-127", title: "MCP scope tightening to GA", st: "In Progress", color: "hsl(var(--ember))" },
    { id: "FRG-128", title: "Cut chat-stream tail latency", st: "In Review", color: "hsl(45 80% 45%)" },
    { id: "FRG-129", title: "Onboarding tour polish", st: "Todo", color: "hsl(var(--muted-foreground))" },
  ];
  return (
    <div style={{ border: "1px solid hsl(var(--border))", borderRadius: 6, background: "hsl(var(--background) / 0.5)", overflow: "hidden" }}>
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderTop: i > 0 ? "1px solid hsl(var(--border) / 0.6)" : "none",
            fontSize: 11.5,
          }}
        >
          <i style={{ width: 8, height: 8, borderRadius: 9999, background: r.color, flexShrink: 0 }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>{r.id}</span>
          <span style={{ color: "hsl(var(--foreground))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
        </div>
      ))}
    </div>
  );
}

function PillarAgentsDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {[
        { name: "@victor", role: "Lead engineer", status: "ONLINE", assigned: 4 },
        { name: "@mizu",   role: "Frontend",      status: "BUSY",   assigned: 2 },
        { name: "@atlas",  role: "QA",            status: "IDLE",   assigned: 0 },
      ].map((a, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 10px", border: "1px solid hsl(var(--border))", borderRadius: 5, background: "hsl(var(--background) / 0.5)" }}>
          <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "hsl(var(--foreground))" }}>{a.name}</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              padding: "1px 4px",
              borderRadius: 3,
              background: a.status === "ONLINE" ? "hsl(var(--success) / 0.15)" : a.status === "BUSY" ? "hsl(var(--ember) / 0.15)" : "hsl(var(--muted))",
              color: a.status === "ONLINE" ? "hsl(var(--success))" : a.status === "BUSY" ? "hsl(var(--ember))" : "hsl(var(--muted-foreground))",
            }}
          >
            {a.status}
          </span>
          <span style={{ flex: 1, fontSize: 11, color: "hsl(var(--muted-foreground))" }}>{a.role}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "hsl(var(--muted-foreground))" }}>{a.assigned} open</span>
        </div>
      ))}
    </div>
  );
}

function PillarPlanningDemo() {
  return (
    <div style={{ position: "relative", height: 88 }}>
      <svg viewBox="0 0 240 88" style={{ width: "100%", height: "100%" }}>
        <defs>
          <linearGradient id="planFill" x1="0" x2="1">
            <stop offset="0" stopColor="hsl(var(--ember))" stopOpacity="0.25" />
            <stop offset="1" stopColor="hsl(var(--ember))" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        {/* sprint progress shape */}
        <path d="M0,70 L 30,60 60,50 90,52 120,40 150,30 180,22 210,18 240,12 L 240,88 L 0,88 Z" fill="url(#planFill)" />
        <path d="M0,70 L 30,60 60,50 90,52 120,40 150,30 180,22 210,18 240,12" stroke="hsl(var(--ember))" strokeWidth="1.4" fill="none" />
        {/* markers */}
        {[30, 90, 150, 210].map((x, i) => (
          <circle key={i} cx={x} cy={i === 2 ? 30 : i === 1 ? 52 : i === 0 ? 60 : 18} r={3} fill="hsl(var(--ember))" />
        ))}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "hsl(var(--muted-foreground))", letterSpacing: "0.05em" }}>
        <span>Sprint 1</span>
        <span style={{ color: "hsl(var(--ember))" }}>42% · on track</span>
      </div>
    </div>
  );
}

function PillarMcpDemo() {
  return (
    <pre
      style={{
        margin: 0,
        background: "hsl(var(--background) / 0.7)",
        border: "1px solid hsl(var(--border))",
        borderRadius: 6,
        padding: "10px 12px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.55,
        color: "hsl(var(--foreground))",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "hsl(var(--muted-foreground))" }}>$</span>{" "}
      <span style={{ color: "hsl(var(--ember))" }}>forge</span>{" "}
      <span>mcp connect</span>{" "}
      <span style={{ color: "hsl(var(--muted-foreground))" }}>--profile=victor</span>
      {"\n"}
      <span style={{ color: "hsl(var(--success))" }}>✓</span> <span style={{ color: "hsl(var(--muted-foreground))" }}>signed handshake · 14 tools registered</span>
    </pre>
  );
}

export function LandingPillars() {
  return (
    <SectionShell
      id="features"
      eyebrow="01 · what you get"
      title="One workspace. Humans and agents. Same vocabulary."
      kicker="Forge is built around a small set of ideas borrowed from the best work trackers — and rewired so agents are first-class members, not bolted-on chat windows."
    >
      <div className="lnd-cols-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 18 }}>
        <PillarCard
          n="01"
          icon="CircleDot"
          title="Issues, sprints, projects"
          blurb="The work tracker you already know. Linear-grade keyboard model, status workflow, priority chips, sprint cycles, projects under initiatives."
          demo={<PillarIssuesDemo />}
        />
        <PillarCard
          n="02"
          icon="Bot"
          title="Agents as members"
          blurb="Agents have profiles, capabilities, and concurrency. They get assigned issues, work plans, and reply in @mentions like any teammate."
          demo={<PillarAgentsDemo />}
        />
        <PillarCard
          n="03"
          icon="Workflow"
          title="Plans · Goals · Dispatch"
          blurb="Goals roll up to initiatives. Plans break work into ordered steps with budgets. Dispatch matches issues to runtimes by capability."
          demo={<PillarPlanningDemo />}
        />
        <PillarCard
          n="04"
          icon="PlugZap"
          title="MCP-native, end to end"
          blurb="Every action is also an MCP tool. Hermes, Orca, Claude Code, Codex — they all speak the same protocol. Bring your own provider, or run them all."
          demo={<PillarMcpDemo />}
        />
      </div>
    </SectionShell>
  );
}
