// =========================================================================
// LIVE STATUS PANEL — the left "marquee" of the split sign-in.
//
// IMPORTANT: this surface is rendered *before* authentication, so it must
// never reveal real workspace state — no issue keys, agent names, run IDs,
// token counts, or counts of any kind. It exists to demonstrate the
// product's *motion vocabulary* (active-node pulse, marching-dash edges,
// idle-breath status) and visual identity — not its data. Anything that
// looks like a count or identifier is a generic glyph.
// =========================================================================

type StepState = "done" | "running" | "pending";

const STEPS: { label: string; state: StepState }[] = [
  // init → plan → edit → test → ship: Forge's universal workflow shape,
  // generic enough to read as "any workflow," not "this user's runs."
  { label: "init", state: "done" },
  { label: "plan", state: "done" },
  { label: "edit", state: "running" },
  { label: "test", state: "pending" },
  { label: "ship", state: "pending" },
];

const NODE = 36;
const GAP = 64;
const TOTAL_W = STEPS.length * NODE + (STEPS.length - 1) * GAP;
const H = NODE + 12;

/**
 * Abstract animated DAG. No identifiers, no labels that reference real
 * entities — just the five generic stages of the Forge loop. Edges along
 * the active path march (`.dag-edge-flow`); the running node pulses
 * (`.forge-active-node`). Both are pure-CSS, gated on `data-motion="on"`.
 */
function AbstractDAG() {
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${TOTAL_W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {STEPS.slice(0, -1).map((s, i) => {
        const x1 = i * (NODE + GAP) + NODE;
        const x2 = x1 + GAP;
        const flowing = s.state === "done" && STEPS[i + 1].state !== "pending";
        const active = s.state === "running" || STEPS[i + 1].state === "running";
        const lit = active || flowing;
        return (
          <line
            key={i}
            x1={x1}
            y1={H / 2}
            x2={x2}
            y2={H / 2}
            className={lit ? "dag-edge-flow" : undefined}
            stroke={lit ? "hsl(var(--ember))" : "hsl(var(--border))"}
            strokeWidth="1.5"
            strokeDasharray={lit ? undefined : "3 4"}
          />
        );
      })}
      {STEPS.map((s, i) => {
        const ink =
          s.state === "done"
            ? "hsl(var(--success))"
            : s.state === "running"
              ? "hsl(var(--ember))"
              : "hsl(var(--muted-foreground))";
        return (
          <foreignObject
            key={s.label}
            x={i * (NODE + GAP)}
            y={(H - NODE) / 2}
            width={NODE}
            height={NODE}
          >
            <div
              className={s.state === "running" ? "forge-active-node" : undefined}
              style={{
                width: NODE,
                height: NODE,
                borderRadius: 4,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--card))",
                display: "grid",
                placeItems: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: ink,
              }}
            >
              {s.label}
            </div>
          </foreignObject>
        );
      })}
    </svg>
  );
}

function Capability({
  glyph,
  name,
  hint,
  accent,
}: {
  glyph: string;
  name: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3.5 py-3">
      <div
        className={`grid h-7 w-7 shrink-0 place-items-center rounded ${
          accent ? "bg-ember/[0.14] text-ember" : "bg-subtle text-foreground"
        }`}
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={glyph} />
        </svg>
      </div>
      <div className="min-w-0">
        <div className="text-[0.8125rem] font-medium leading-tight">{name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      </div>
    </div>
  );
}

/** Compact variant for the mobile header (above the form). */
export function LiveLoopCard({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-col gap-2.5 rounded-md border border-border bg-card px-3.5 py-3 ${className ?? ""}`}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ember">
          · the forge loop ·
        </span>
        <span className="font-mono text-[0.65rem] text-muted-foreground">init → ship</span>
      </div>
      <AbstractDAG />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="forge-breath" />
        <span>All systems normal</span>
      </div>
    </div>
  );
}

/** Full panel for the desktop left column. */
export function LiveStatusPanel() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      {/* the animated DAG — the visual hook, no data */}
      <div className="rounded-md border border-border bg-card px-4 pb-3.5 pt-4">
        <div className="mb-2.5 flex items-baseline justify-between">
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ember">
            · the forge loop ·
          </span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">init → ship</span>
        </div>
        <AbstractDAG />
      </div>

      {/* capability tiles — generic, no counts */}
      <div className="grid gap-2">
        <Capability
          accent
          glyph="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"
          name="Cycles"
          hint="Time-boxed iterations. Sprint-shaped, keyboard-shaped."
        />
        <Capability
          glyph="M12 2a5 5 0 015 5v3a5 5 0 01-10 0V7a5 5 0 015-5zM5 21a7 7 0 0114 0"
          name="Agents"
          hint="First-class non-human actors. Assigned, dispatched, reviewed."
        />
        <Capability
          glyph="M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01"
          name="Runs"
          hint="Every agent step recorded. Token-accounted, replayable."
        />
      </div>

      {/* status footer — ambient, no data */}
      <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
        <span className="forge-breath" />
        <span>All systems normal</span>
      </div>
    </div>
  );
}
