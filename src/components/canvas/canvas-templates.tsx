"use client";
import { Grid2x2, LayoutDashboard, MessagesSquare, Target, Sparkles, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Canvas templates seed a new canvas with a meaningful starting layout.
 * Each template is a pure data description — the index page calls
 * `canvas.create` then iterates the template's nodes/edges and dispatches
 * them as `canvas.addNode` / `canvas.addEdge` calls.
 *
 * Notes are seeded as `targetType: "artifact"` placeholders only when the
 * server-side `canvases.addNote` helper (Agent H) is on the trpc proxy —
 * otherwise the template falls back to text-only sticky-note style nodes
 * that point at the special `note:` artifact ids the helper produces.
 * Empty templates always work.
 */

export type CanvasTemplateNode = {
  /** stable key inside the template, used by edges to reference this node */
  key: string;
  /** body for note nodes (rendered as sticky); when present, the seed
   *  uses `canvases.addNote` if available, else falls back to a note in a
   *  context-only ephemeral way. */
  noteBody?: string;
  /** existing entity ref — for templates that include canonical refs (none ship today). */
  targetType?: string;
  targetId?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** optional lane label rendered as a soft band */
  lane?: string;
};

export type CanvasTemplateEdge = {
  from: string;
  to: string;
  label?: string;
  kind?: string;
};

export type CanvasTemplate = {
  id: string;
  name: string;
  blurb: string;
  icon: LucideIcon;
  nodes: CanvasTemplateNode[];
  edges?: CanvasTemplateEdge[];
};

const NOTE_W = 220;
const COL = 280;
const ROW = 200;

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: "empty",
    name: "Empty",
    blurb: "A blank canvas. Drag in entities or right-click to add notes.",
    icon: Sparkles,
    nodes: [],
  },
  {
    id: "decision-matrix",
    name: "Decision matrix",
    blurb: "2×2 with axis labels — score options against two criteria.",
    icon: Grid2x2,
    nodes: [
      { key: "axis-x", noteBody: "**Effort →**", x: 200, y: -80, width: 200, height: 60 },
      { key: "axis-y", noteBody: "**Impact ↑**", x: -200, y: 200, width: 200, height: 60 },
      { key: "q1", noteBody: "**High impact · Low effort**\nQuick wins", x: 60, y: 60, lane: "Top-right" },
      { key: "q2", noteBody: "**High impact · High effort**\nBig bets", x: 320, y: 60, lane: "Top-right" },
      { key: "q3", noteBody: "**Low impact · Low effort**\nFill-in", x: 60, y: 320, lane: "Bottom" },
      { key: "q4", noteBody: "**Low impact · High effort**\nAvoid", x: 320, y: 320, lane: "Bottom" },
    ],
  },
  {
    id: "architecture",
    name: "Architecture board",
    blurb: "System on top, components in the middle, dependencies at the bottom.",
    icon: LayoutDashboard,
    nodes: [
      { key: "system", noteBody: "**System**\nName + one-line purpose.", x: 120, y: -40, width: 320, lane: "System" },
      { key: "c1", noteBody: "Component A\n_purpose_", x: -80, y: 200, lane: "Components" },
      { key: "c2", noteBody: "Component B\n_purpose_", x: 200, y: 200, lane: "Components" },
      { key: "c3", noteBody: "Component C\n_purpose_", x: 480, y: 200, lane: "Components" },
      { key: "d1", noteBody: "Dependency · external", x: -80, y: 440, lane: "Dependencies" },
      { key: "d2", noteBody: "Dependency · internal", x: 200, y: 440, lane: "Dependencies" },
      { key: "d3", noteBody: "Dependency · data", x: 480, y: 440, lane: "Dependencies" },
    ],
    edges: [
      { from: "system", to: "c1", kind: "contains" },
      { from: "system", to: "c2", kind: "contains" },
      { from: "system", to: "c3", kind: "contains" },
      { from: "c1", to: "d1", kind: "depends_on" },
      { from: "c2", to: "d2", kind: "depends_on" },
      { from: "c3", to: "d3", kind: "depends_on" },
    ],
  },
  {
    id: "standup",
    name: "Standup",
    blurb: "Three columns: Yesterday, Today, Blockers.",
    icon: MessagesSquare,
    nodes: [
      { key: "y-h", noteBody: "**Yesterday**", x: 0, y: -60, width: NOTE_W, height: 50, lane: "Yesterday" },
      { key: "y1", noteBody: "Wrapped: …", x: 0, y: 40, lane: "Yesterday" },
      { key: "y2", noteBody: "Shipped: …", x: 0, y: 40 + ROW, lane: "Yesterday" },
      { key: "t-h", noteBody: "**Today**", x: COL, y: -60, width: NOTE_W, height: 50, lane: "Today" },
      { key: "t1", noteBody: "Focus: …", x: COL, y: 40, lane: "Today" },
      { key: "t2", noteBody: "Stretch: …", x: COL, y: 40 + ROW, lane: "Today" },
      { key: "b-h", noteBody: "**Blockers**", x: COL * 2, y: -60, width: NOTE_W, height: 50, lane: "Blockers" },
      { key: "b1", noteBody: "Waiting on: …", x: COL * 2, y: 40, lane: "Blockers" },
    ],
  },
  {
    id: "retro",
    name: "Retro",
    blurb: "Four quadrants: Went well, Didn't, Confused by, Action items.",
    icon: FileText,
    nodes: [
      { key: "ww-h", noteBody: "**Went well**", x: 0, y: -60, width: NOTE_W, height: 50, lane: "Went well" },
      { key: "ww1", noteBody: "Win: …", x: 0, y: 40, lane: "Went well" },
      { key: "dd-h", noteBody: "**Didn't go well**", x: COL, y: -60, width: NOTE_W, height: 50, lane: "Didn't" },
      { key: "dd1", noteBody: "Friction: …", x: COL, y: 40, lane: "Didn't" },
      { key: "cb-h", noteBody: "**Confused by**", x: 0, y: 40 + ROW, width: NOTE_W, height: 50, lane: "Confused by" },
      { key: "cb1", noteBody: "Unclear: …", x: 0, y: 40 + ROW + 100, lane: "Confused by" },
      { key: "ai-h", noteBody: "**Action items**", x: COL, y: 40 + ROW, width: NOTE_W, height: 50, lane: "Action items" },
      { key: "ai1", noteBody: "[ ] Owner — task", x: COL, y: 40 + ROW + 100, lane: "Action items" },
    ],
  },
  {
    id: "okr-tree",
    name: "OKR tree",
    blurb: "Objective at top, three key results below, action notes under each.",
    icon: Target,
    nodes: [
      { key: "obj", noteBody: "**Objective**\nThe outcome we want.", x: 200, y: -40, width: 320, lane: "Objective" },
      { key: "kr1", noteBody: "**KR 1**\nMeasure → target.", x: -80, y: 220, lane: "Key Results" },
      { key: "kr2", noteBody: "**KR 2**\nMeasure → target.", x: 200, y: 220, lane: "Key Results" },
      { key: "kr3", noteBody: "**KR 3**\nMeasure → target.", x: 480, y: 220, lane: "Key Results" },
      { key: "a1", noteBody: "Action: …", x: -80, y: 440, lane: "Actions" },
      { key: "a2", noteBody: "Action: …", x: 200, y: 440, lane: "Actions" },
      { key: "a3", noteBody: "Action: …", x: 480, y: 440, lane: "Actions" },
    ],
    edges: [
      { from: "obj", to: "kr1", kind: "contains" },
      { from: "obj", to: "kr2", kind: "contains" },
      { from: "obj", to: "kr3", kind: "contains" },
      { from: "kr1", to: "a1", kind: "contains" },
      { from: "kr2", to: "a2", kind: "contains" },
      { from: "kr3", to: "a3", kind: "contains" },
    ],
  },
];

export function CanvasTemplatePicker({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-2">
      {CANVAS_TEMPLATES.map((tpl) => {
        const Icon = tpl.icon;
        const active = tpl.id === selectedId;
        return (
          <li key={tpl.id}>
            <button
              type="button"
              onClick={() => onSelect(tpl.id)}
              className={
                "flex h-full w-full flex-col gap-1 rounded-md border p-2 text-left transition-all duration-200 " +
                (active
                  ? "border-ember bg-ember/10 text-foreground shadow-sm"
                  : "border-border bg-card/40 text-muted-foreground hover:border-ember/40 hover:bg-subtle")
              }
            >
              <div className="flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                <span className="text-sm font-medium text-foreground">{tpl.name}</span>
              </div>
              <p className="line-clamp-2 text-meta text-muted-foreground">{tpl.blurb}</p>
              <div className="mt-1 flex items-center gap-1 text-meta text-muted-foreground/70">
                <span>{tpl.nodes.length} node{tpl.nodes.length === 1 ? "" : "s"}</span>
                {tpl.edges && tpl.edges.length > 0 ? (
                  <span>· {tpl.edges.length} edge{tpl.edges.length === 1 ? "" : "s"}</span>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function getTemplate(id: string): CanvasTemplate | undefined {
  return CANVAS_TEMPLATES.find((t) => t.id === id);
}
