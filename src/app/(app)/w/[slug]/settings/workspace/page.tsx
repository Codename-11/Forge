"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/modal";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { workspaceColor } from "@/lib/workspace-color";

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: current, refetch } = trpc.workspace.current.useQuery();

  const canEdit = ws.role === "OWNER" || ws.role === "ADMIN";
  const canDelete = ws.role === "OWNER";

  const [name, setName] = useState(ws.name);
  const [avatarUrl, setAvatarUrl] = useState(ws.avatarUrl ?? "");
  const [cycleLengthDays, setCycleLengthDays] = useState(ws.cycleLengthDays);
  const [cycleCooldownDays, setCycleCooldownDays] = useState(ws.cycleCooldownDays);
  const [timeTrackingEnabled, setTimeTrackingEnabled] = useState(ws.timeTrackingEnabled);
  const [attachmentQuotaMb, setAttachmentQuotaMb] = useState(ws.attachmentQuotaMb);
  const [agentIdleTimeoutMinutes, setAgentIdleTimeoutMinutes] = useState(0);
  const [assignmentSlaMinutes, setAssignmentSlaMinutes] = useState(0);
  const [autoRedispatchOnStall, setAutoRedispatchOnStall] = useState(false);
  const [requiredAckSeconds, setRequiredAckSeconds] = useState(0);
  const [autoRedispatchOnNoack, setAutoRedispatchOnNoack] = useState(false);
  const [slaEnforcementEnabled, setSlaEnforcementEnabled] = useState(false);

  useEffect(() => {
    if (!current) return;
    setName(current.name);
    setAvatarUrl(current.avatarUrl ?? "");
    setCycleLengthDays(current.cycleLengthDays);
    setCycleCooldownDays(current.cycleCooldownDays);
    setTimeTrackingEnabled(current.timeTrackingEnabled);
    setAttachmentQuotaMb(current.attachmentQuotaMb);
    setAgentIdleTimeoutMinutes(current.agentIdleTimeoutMinutes);
    setAssignmentSlaMinutes(current.assignmentSlaMinutes);
    setAutoRedispatchOnStall(current.autoRedispatchOnStall);
    setRequiredAckSeconds(current.requiredAckSeconds);
    setAutoRedispatchOnNoack(current.autoRedispatchOnNoack);
    setSlaEnforcementEnabled(current.slaEnforcementEnabled);
  }, [current]);

  const update = trpc.workspace.update.useMutation({
    onSuccess: () => {
      toast.success("Workspace updated.");
      utils.workspace.current.invalidate();
      utils.workspace.list.invalidate();
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      toast.success("Workspace archived.");
      router.push("/settings/workspaces");
    },
    onError: (e) => toast.error(e.message),
  });

  const del = trpc.workspace.delete.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted.");
      router.push("/settings/workspaces");
    },
    onError: (e) => toast.error(e.message),
  });

  const badge = workspaceColor(ws.key);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <>
      <Topbar title="Workspace" subtitle={ws.name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <Section title="Identity">
            <div className="flex items-center gap-4 rounded-lg border border-border bg-card/40 p-4">
              <span
                className="grid h-12 w-12 shrink-0 place-items-center rounded-md font-mono text-base font-semibold"
                style={{
                  backgroundColor: badge.bg,
                  color: badge.fg,
                  boxShadow: `inset 0 0 0 1px ${badge.ring}`,
                }}
              >
                {ws.key.slice(0, 3)}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!canEdit}
                    maxLength={80}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Key">
                    <Input value={ws.key} disabled readOnly />
                  </Field>
                  <Field label="Slug">
                    <Input value={ws.slug} disabled readOnly />
                  </Field>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Keys are immutable once created; slug changes would require a
                  data migration and aren&apos;t supported from the UI.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Appearance">
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-card/40 p-4">
              <Field
                label="Avatar URL"
                hint="Used in the switcher and top-left badge. Leave empty for the auto color badge."
              >
                <Input
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://example.com/avatar.png"
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Sprints"
            hint="Default iteration cadence. Each sprint can still override on create."
          >
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/40 p-4">
              <Field
                label="Sprint length (days)"
                hint="How long a sprint runs by default. Used when rollover creates the next sprint."
              >
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={cycleLengthDays}
                  onChange={(e) => setCycleLengthDays(Number(e.target.value) || 1)}
                  disabled={!canEdit}
                />
              </Field>
              <Field
                label="Cooldown (days)"
                hint="Gap between sprints. 0 means a new sprint starts the day the previous one ends."
              >
                <Input
                  type="number"
                  min={0}
                  max={30}
                  value={cycleCooldownDays}
                  onChange={(e) => setCycleCooldownDays(Number(e.target.value) || 0)}
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Features"
            hint="Settings-driven toggles. No magic numbers baked into handlers."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Time tracking</div>
                  <div className="text-xs text-muted-foreground">
                    Exposes start/stop timers and the time-entry report.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={timeTrackingEnabled}
                  onChange={(e) => setTimeTrackingEnabled(e.target.checked)}
                  disabled={!canEdit}
                  className="h-4 w-4"
                />
              </label>
              <Field
                label="Attachment quota (MB)"
                hint="MB per workspace. Counts file size of finalized attachments only — drafts and aborted uploads don't count."
              >
                <Input
                  type="number"
                  min={0}
                  value={attachmentQuotaMb}
                  onChange={(e) => setAttachmentQuotaMb(Number(e.target.value) || 0)}
                  disabled={!canEdit}
                />
              </Field>
              <Field
                label="Agent idle timeout (minutes)"
                hint="Flip an agent to OFFLINE when no signal has been received for this long. Signals = successful webhook deliveries to the agent's URL (push-dispatch model — every delivered AGENT_ASSIGNED / COMMENT_CREATED counts) plus any explicit agents.heartbeat MCP call. 0 disables the sweep entirely; 15 is a good default if your agents receive regular event traffic, higher if quiet hours are common."
              >
                <Input
                  type="number"
                  min={0}
                  max={1440}
                  value={agentIdleTimeoutMinutes}
                  onChange={(e) =>
                    setAgentIdleTimeoutMinutes(Number(e.target.value) || 0)
                  }
                  disabled={!canEdit}
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Agent SLA"
            hint="Watchdog for assignments where the agent woke up but never moved the issue. Pure follow-through reliability — no priority changes."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <Field
                label="Agent SLA (minutes)"
                hint="Flip an issue to STALLED when an assigned agent hasn't moved it out of BACKLOG/TODO within this window. 0 disables. 30 is a reasonable starting point."
              >
                <Input
                  type="number"
                  min={0}
                  max={10080}
                  value={assignmentSlaMinutes}
                  onChange={(e) =>
                    setAssignmentSlaMinutes(Number(e.target.value) || 0)
                  }
                  disabled={!canEdit}
                />
              </Field>
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Auto-redispatch on stall
                  </div>
                  <div className="text-xs text-muted-foreground">
                    When checked, also clears assignedAgentId so the
                    auto-dispatcher re-picks. Off = event-only (operator-driven).
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoRedispatchOnStall}
                  onChange={(e) => setAutoRedispatchOnStall(e.target.checked)}
                  disabled={!canEdit}
                  className="h-4 w-4"
                />
              </label>
              <Field
                label="Required ack (seconds)"
                hint="How long an agent has to comment or transition an issue after assignment before AGENT_NOACK fires. 0 disables. 60–180s is typical."
              >
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={requiredAckSeconds}
                  onChange={(e) =>
                    setRequiredAckSeconds(Number(e.target.value) || 0)
                  }
                  disabled={!canEdit}
                />
              </Field>
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Auto-redispatch on no-ack
                  </div>
                  <div className="text-xs text-muted-foreground">
                    When checked, AGENT_NOACK also clears assignedAgentId so
                    the auto-dispatcher re-picks. Mirrors the stall toggle.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoRedispatchOnNoack}
                  onChange={(e) => setAutoRedispatchOnNoack(e.target.checked)}
                  disabled={!canEdit}
                  className="h-4 w-4"
                />
              </label>
            </div>
          </Section>

          <Section
            title="Issue SLA"
            hint="Per-issue SLA enforcement. Set slaMinutes from issue detail; this toggle controls workspace-wide enforcement."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Enforce per-issue SLA
                  </div>
                  <div className="text-xs text-muted-foreground">
                    When checked, scans for issues past their slaMinutes
                    target and emits ISSUE_SLA_BREACH. Set per-issue
                    slaMinutes from issue detail.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={slaEnforcementEnabled}
                  onChange={(e) => setSlaEnforcementEnabled(e.target.checked)}
                  disabled={!canEdit}
                  className="h-4 w-4"
                />
              </label>
            </div>
          </Section>

          {canEdit && (
            <div className="flex justify-end">
              <Button
                variant="ember"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    name: name.trim() || undefined,
                    avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
                    cycleLengthDays,
                    cycleCooldownDays,
                    timeTrackingEnabled,
                    attachmentQuotaMb,
                    agentIdleTimeoutMinutes,
                    assignmentSlaMinutes,
                    autoRedispatchOnStall,
                    requiredAckSeconds,
                    autoRedispatchOnNoack,
                    slaEnforcementEnabled,
                  })
                }
              >
                {update.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          )}

          {canDelete && (
            <Section title="Danger zone" hint="These actions cannot be undone.">
              <div className="divide-y divide-border rounded-lg border border-danger/30 bg-danger/5">
                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Archive workspace</div>
                    <div className="text-xs text-muted-foreground">
                      Hides the workspace from members without deleting data.
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setArchiveOpen(true)}>
                    Archive
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">Delete workspace</div>
                    <div className="text-xs text-muted-foreground">
                      Permanently removes all issues, projects, and history.
                    </div>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
                    Delete…
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </div>
      </div>

      <Confirm
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${ws.name}?`}
        description="Members lose access until the workspace is restored. Data is retained."
        primaryLabel="Archive"
        loading={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
      <Confirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        variant="destructive"
        title={`Delete ${ws.name}?`}
        description="This permanently removes all issues, projects, sprints, attachments, and events."
        primaryLabel="Delete workspace"
        typeToConfirm={ws.name}
        loading={del.isPending}
        onConfirm={() => del.mutate({ confirmName: ws.name })}
      />
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

