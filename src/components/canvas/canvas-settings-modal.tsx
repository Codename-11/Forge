"use client";
import { useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import { CenterModal, Confirm } from "@/components/ui/modal";
import { Section } from "@/components/ui";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

/**
 * Canvas settings — replaces inline topbar affordances with a single modal.
 *
 * View state (showGrid / snapToGrid / presenceVisible) lives on the page and
 * is passed in/out via props so keyboard bindings on the page stay intact.
 * Name has its own autosave (debounced 600ms after last keystroke).
 */
export function CanvasSettingsModal({
  open,
  onOpenChange,
  canvasId,
  name,
  scopeType,
  showGrid,
  snapToGrid,
  presenceVisible,
  onShowGridChange,
  onSnapToGridChange,
  onPresenceVisibleChange,
  onArchived,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canvasId: string;
  name: string;
  scopeType: string | null;
  showGrid: boolean;
  snapToGrid: boolean;
  presenceVisible: boolean;
  onShowGridChange: (v: boolean) => void;
  onSnapToGridChange: (v: boolean) => void;
  onPresenceVisibleChange: (v: boolean) => void;
  onArchived: () => void;
}) {
  const utils = trpc.useUtils();
  const [draftName, setDraftName] = useState(name);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const lastSavedNameRef = useRef(name);

  useEffect(() => {
    setDraftName(name);
    lastSavedNameRef.current = name;
  }, [name, open]);

  const renameMut = trpc.canvas.rename.useMutation({
    onSuccess: () => {
      utils.canvas.hydrate.invalidate({ id: canvasId });
      utils.canvas.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const archiveMut = trpc.canvas.archive.useMutation({
    onSuccess: () => {
      toast.success("Canvas archived");
      setConfirmArchive(false);
      onOpenChange(false);
      onArchived();
    },
    onError: (e) => toast.error(e.message),
  });

  // Debounced autosave for the name field. Skips empty / unchanged values.
  useEffect(() => {
    if (!open) return;
    const trimmed = draftName.trim();
    if (!trimmed) return;
    if (trimmed === lastSavedNameRef.current) return;
    const t = setTimeout(() => {
      lastSavedNameRef.current = trimmed;
      renameMut.mutate({ id: canvasId, name: trimmed });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftName, open, canvasId]);

  return (
    <>
      <CenterModal
        open={open}
        onOpenChange={onOpenChange}
        title="Canvas settings"
        description="Name, view options, and sharing for this canvas."
        size="md"
        footer={
          <Button
            type="button"
            variant="ember"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        }
      >
        <div className="space-y-6">
          <Section title="General">
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <FieldRow label="Name">
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  maxLength={200}
                  placeholder="Canvas name"
                />
                <div className="mt-1 text-[0.6875rem] text-muted-foreground">
                  {renameMut.isPending
                    ? "Saving…"
                    : "Autosaves shortly after you stop typing."}
                </div>
              </FieldRow>
              <FieldRow label="Scope">
                <span className="inline-flex items-center rounded-full border border-border bg-subtle px-2 py-0.5 font-mono text-id text-muted-foreground">
                  {scopeType ?? "workspace"}
                </span>
              </FieldRow>
              <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Archive canvas</div>
                  <div className="text-xs text-muted-foreground">
                    Hides this canvas from the active list. Can be restored later.
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmArchive(true)}
                  disabled={archiveMut.isPending}
                >
                  <Archive className="h-3.5 w-3.5" /> Archive
                </Button>
              </div>
            </div>
          </Section>

          <Section title="View">
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <ToggleRow
                label="Show grid"
                hint="Render the background dot pattern on the canvas surface."
                checked={showGrid}
                onChange={onShowGridChange}
              />
              <ToggleRow
                label="Snap to grid"
                hint="Snap node positions to the 20px grid while dragging."
                checked={snapToGrid}
                onChange={onSnapToGridChange}
              />
              <ToggleRow
                label="Show presence cursors"
                hint="Display remote operator cursors on this canvas."
                checked={presenceVisible}
                onChange={onPresenceVisibleChange}
              />
            </div>
          </Section>

          <Section title="Sharing">
            <div className="rounded-lg border border-border bg-card/40 p-4 text-xs text-muted-foreground">
              Workspace-scoped. Anyone with access to this workspace can view and
              edit this canvas. Per-canvas sharing controls land in a future
              release.
            </div>
          </Section>
        </div>
      </CenterModal>

      <Confirm
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive canvas?"
        description="Hides this canvas from the active list. You can restore it later."
        primaryLabel="Archive canvas"
        variant="destructive"
        loading={archiveMut.isPending}
        onConfirm={() => archiveMut.mutate({ id: canvasId })}
      />
    </>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0"
      />
    </label>
  );
}
