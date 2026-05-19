"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import {
  CanvasTemplatePicker,
  getTemplate,
  type CanvasTemplate,
} from "@/components/canvas/canvas-templates";

/**
 * Canvas index — lists every non-archived workspace canvas. "+ New
 * canvas" creates an empty board and routes the operator straight
 * to the viewer so they can start dragging cards in.
 */
export default function CanvasIndexPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.canvas.list.useQuery({ includeArchived: false });
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [templateId, setTemplateId] = useState<string>("empty");
  const [seeding, setSeeding] = useState(false);

  const items = useMemo(() => data?.items ?? [], [data]);

  // Optional helper exposed by Agent H. When present we use it to seed
  // sticky-note nodes from a template; when absent we skip notes and
  // only seed edge-less canonical nodes.
  const canvasRouterAny = (trpc as unknown as Record<string, unknown>).canvas as
    | Record<string, unknown>
    | undefined;
  const addNoteAny = canvasRouterAny?.addNote as
    | {
        useMutation: () => {
          mutateAsync: (input: {
            canvasId: string;
            body: string;
            x: number;
            y: number;
          }) => Promise<{ id?: string; nodeId?: string }>;
        };
      }
    | undefined;
  const addNoteMutAny = addNoteAny?.useMutation();
  const addNodeMut = trpc.canvas.addNode.useMutation();
  const addEdgeMut = trpc.canvas.addEdge.useMutation();

  const create = trpc.canvas.create.useMutation({
    onSuccess: async ({ id }) => {
      const tpl = getTemplate(templateId);
      if (tpl && tpl.nodes.length > 0) {
        setSeeding(true);
        try {
          await seedTemplate({
            canvasId: id,
            template: tpl,
            addNode: addNodeMut.mutateAsync,
            addEdge: addEdgeMut.mutateAsync,
            addNote: addNoteMutAny?.mutateAsync,
          });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to seed template");
        }
        setSeeding(false);
      }
      toast.success("Canvas created");
      utils.canvas.list.invalidate();
      setCreating(false);
      setDraftName("");
      setTemplateId("empty");
      router.push(`/w/${ws.slug}/canvas/${id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Canvas"
        subtitle={data ? `${items.length} active` : undefined}
        actions={
          <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New canvas
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <SkeletonList rows={4} />
        ) : items.length === 0 ? (
          <EmptyState
            variant="page"
            icon={<Sparkles />}
            title="No canvases yet"
            description="Canvases are spatial synthesis boards for arranging issues, artifacts, chats, runs, and notes side-by-side without duplicating the canonical content. Drag cards around; click through to source."
            action={
              <Button variant="ember" size="sm" onClick={() => setCreating(true)}>
                Create first canvas
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {items.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/w/${ws.slug}/canvas/${row.id}`}
                  className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 transition-all duration-300 hover:border-ember/40 hover:bg-subtle hover:shadow-sm"
                >
                  <div className="flex items-center gap-2 text-meta uppercase tracking-wide text-muted-foreground">
                    <Sparkles className="h-3 w-3" />
                    Canvas
                  </div>
                  <div className="text-sm font-medium leading-snug text-foreground group-hover:text-ember">
                    {row.name}
                  </div>
                  <p className="mt-auto text-meta text-muted-foreground">
                    {row._count.nodes} card{row._count.nodes === 1 ? "" : "s"} ·{" "}
                    {row._count.edges} edge{row._count.edges === 1 ? "" : "s"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={() => {
            if (!create.isPending && !seeding) setCreating(false);
          }}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-sm font-medium">New canvas</h2>
            <input
              autoFocus
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftName.trim()) {
                  create.mutate({ name: draftName.trim() });
                }
                if (e.key === "Escape" && !create.isPending) setCreating(false);
              }}
              placeholder="Canvas name"
              className="w-full rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            />
            <div className="mt-3">
              <div className="mb-1.5 text-meta uppercase tracking-wide text-muted-foreground">
                Template
              </div>
              <CanvasTemplatePicker selectedId={templateId} onSelect={setTemplateId} />
            </div>
            {!addNoteAny && templateId !== "empty" ? (
              <p className="mt-2 text-meta text-muted-foreground">
                Note seeding requires <span className="font-mono">canvases.addNote</span> — only edges and structural nodes will be created.
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
                disabled={create.isPending || seeding}
              >
                Cancel
              </Button>
              <Button
                variant="ember"
                size="sm"
                onClick={() => create.mutate({ name: draftName.trim() || "Untitled canvas" })}
                disabled={create.isPending || seeding || !draftName.trim()}
              >
                {create.isPending || seeding ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

async function seedTemplate({
  canvasId,
  template,
  addNode,
  addEdge,
  addNote,
}: {
  canvasId: string;
  template: CanvasTemplate;
  addNode: (input: {
    canvasId: string;
    targetType: "issue" | "artifact";
    targetId: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<{ id: string }>;
  addEdge: (input: {
    canvasId: string;
    fromNodeId: string;
    toNodeId: string;
    label?: string | null;
    kind?: string | null;
  }) => Promise<{ id: string }>;
  addNote?: (input: {
    canvasId: string;
    body: string;
    x: number;
    y: number;
  }) => Promise<{ id?: string; nodeId?: string }>;
}) {
  const keyToNodeId = new Map<string, string>();
  for (const n of template.nodes) {
    let nodeId: string | undefined;
    if (n.noteBody !== undefined && addNote) {
      const res = await addNote({
        canvasId,
        body: n.noteBody,
        x: n.x,
        y: n.y,
      });
      nodeId = res.nodeId ?? res.id;
    } else if (n.targetType && n.targetId) {
      const res = await addNode({
        canvasId,
        targetType: n.targetType as "issue" | "artifact",
        targetId: n.targetId,
        x: n.x,
        y: n.y,
        width: n.width ?? 240,
        height: n.height ?? 140,
      });
      nodeId = res.id;
    }
    if (nodeId) keyToNodeId.set(n.key, nodeId);
  }
  for (const e of template.edges ?? []) {
    const fromId = keyToNodeId.get(e.from);
    const toId = keyToNodeId.get(e.to);
    if (!fromId || !toId) continue;
    await addEdge({
      canvasId,
      fromNodeId: fromId,
      toNodeId: toId,
      label: e.label ?? null,
      kind: e.kind ?? null,
    });
  }
}
