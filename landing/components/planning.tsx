import { Icon } from "@/components/icon";
import { SectionShell } from "@/components/primitives";

export function LandingPlanning() {
  return (
    <SectionShell
      id="planning"
      eyebrow="04 · how work moves"
      title="Plans, goals, sprints — and a dock that watches it all."
    >
      <div className="lnd-cols-2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)", gap: 56, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {[
            { icon: "Target", title: "Goals roll up to initiatives", body: "Quarter-scale outcomes hold the bigger picture. Plans and issues attach to the goals they advance — progress is computed, not promised." },
            { icon: "Workflow", title: "Plans break work into ordered steps", body: "Each step has owners, budgets, and a status. Agents run their steps; humans review them. Both speak the same vocabulary." },
            { icon: "Activity", title: "Activity dock — chord G then 5", body: "One pill, six tabs: Live, Queue, Agents, History, Chat, Admin. Always one keystroke from the work that's running right now." },
          ].map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 14 }}>
              <span style={{ width: 30, height: 30, display: "grid", placeItems: "center", background: "hsl(var(--ember) / 0.12)", color: "hsl(var(--ember))", borderRadius: 6, flexShrink: 0 }}>
                <Icon name={row.icon} size={15} />
              </span>
              <div>
                <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>{row.title}</h3>
                <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55, color: "hsl(var(--muted-foreground))", textWrap: "pretty" }}>{row.body}</p>
              </div>
            </div>
          ))}
        </div>
        <PlanningVisual />
      </div>
    </SectionShell>
  );
}

function PlanningVisual() {
  // A composed visualization: sprint progress + goals breakdown + activity pill
  return (
    <div
      style={{
        position: "relative",
        height: 460,
        border: "1px solid hsl(var(--border))",
        background: "hsl(var(--card) / 0.7)",
        borderRadius: "calc(var(--radius) + 4px)",
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        overflow: "hidden",
        boxShadow: "0 22px 40px -28px hsl(var(--foreground) / 0.2)",
      }}
    >
      {/* Sprint header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--muted-foreground))", textTransform: "uppercase", letterSpacing: "0.12em" }}>
          Sprint 1 · May 21 → May 28
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--ember))" }}>
          <span className="forge-breath" style={{ width: 6, height: 6, background: "hsl(var(--ember))" }} />
          42% complete
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ position: "relative", height: 8, borderRadius: 4, background: "hsl(var(--muted))", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: "0 58% 0 0", background: "linear-gradient(90deg, hsl(var(--ember) / 0.6), hsl(var(--ember)))", borderRadius: 4 }} />
      </div>

      {/* Goals */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
        {[
          { title: "Ship MCP scope tightening to GA", done: 8, total: 12, budget: "$16.42 / $40.00" },
          { title: "Cut chat-stream tail latency < 250ms", done: 5, total: 8, budget: "$6.10 / $20.00" },
          { title: "Onboarding · time-to-first-issue < 90s", done: 4, total: 9, budget: "$3.85 / $12.00" },
        ].map((g, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "hsl(var(--background) / 0.5)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="Target" size={12} style={{ color: "hsl(var(--ember))" }} />
              <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.title}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "hsl(var(--muted-foreground))" }}>{g.done}/{g.total} steps</span>
            </div>
            <div style={{ position: "relative", height: 4, background: "hsl(var(--muted))", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, right: `${100 - (g.done / g.total) * 100}%`, background: "hsl(var(--ember) / 0.7)" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "hsl(var(--muted-foreground))" }}>
              <Icon name="Zap" size={9} />
              <span>budget {g.budget}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Activity pill floating */}
      <div
        style={{
          position: "absolute",
          bottom: 22,
          right: 22,
          left: 22,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "hsl(var(--background))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 9999,
          boxShadow: "0 20px 32px -18px hsl(var(--foreground) / 0.25)",
        }}
      >
        <span style={{ position: "relative", width: 8, height: 8 }}>
          <span style={{ position: "absolute", inset: 0, borderRadius: 9999, background: "hsl(var(--success))" }} />
          <span style={{ position: "absolute", inset: -3, borderRadius: 9999, background: "hsl(var(--success))", animation: "forge-act-pulse 2.2s ease-out infinite" }} className="forge-act-pulse" />
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--foreground))" }}>3 running</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "hsl(var(--muted-foreground))" }}>· 2 queued · 0 stalled</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "2px 6px", border: "1px solid hsl(var(--border))", borderRadius: 4, color: "hsl(var(--muted-foreground))" }}>G 5</span>
      </div>
    </div>
  );
}
