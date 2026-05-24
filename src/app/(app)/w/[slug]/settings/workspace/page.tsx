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
  const [agentRunStaleMinutes, setAgentRunStaleMinutes] = useState(0);
  const [autoRedispatchOnStall, setAutoRedispatchOnStall] = useState(false);
  const [requiredAckSeconds, setRequiredAckSeconds] = useState(0);
  const [autoRedispatchOnNoack, setAutoRedispatchOnNoack] = useState(false);
  const [slaEnforcementEnabled, setSlaEnforcementEnabled] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiTriageOnCreate, setAiTriageOnCreate] = useState(true);
  const [aiCoachEnabled, setAiCoachEnabled] = useState(true);
  const [aiProvider, setAiProvider] = useState<
    "hermes" | "openai" | "anthropic" | "custom"
  >("hermes");
  const [aiModel, setAiModel] = useState("");
  const [startedStatusId, setStartedStatusId] = useState<string | null>(null);

  const { data: aiStatus, refetch: refetchAi } = trpc.ai.status.useQuery();
  const ensureCoach = trpc.ai.ensureCoach.useMutation({
    onSuccess: () => {
      toast.success("Coach agent ready.");
      refetchAi();
    },
    onError: (e) => toast.error(e.message),
  });

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
    setAgentRunStaleMinutes(current.agentRunStaleMinutes);
    setAutoRedispatchOnStall(current.autoRedispatchOnStall);
    setRequiredAckSeconds(current.requiredAckSeconds);
    setAutoRedispatchOnNoack(current.autoRedispatchOnNoack);
    setSlaEnforcementEnabled(current.slaEnforcementEnabled);
    setAiEnabled(current.aiEnabled);
    setAiTriageOnCreate(current.aiTriageOnCreate);
    setAiCoachEnabled(current.aiCoachEnabled);
    setAiProvider(
      (current.aiProvider as "hermes" | "openai" | "anthropic" | "custom") ??
        "hermes",
    );
    setAiModel(current.aiModel ?? "");
    setStartedStatusId(current.startedStatusId ?? null);
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
      utils.workspace.list.invalidate();
      utils.workspace.current.invalidate();
      router.push("/settings/workspaces");
    },
    onError: (e) => toast.error(e.message),
  });

  const del = trpc.workspace.delete.useMutation({
    onSuccess: () => {
      toast.success("Workspace deleted.");
      utils.workspace.list.invalidate();
      utils.workspace.current.invalidate();
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
                <p className="text-[0.6875rem] text-muted-foreground">
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
              <Field
                label="Agent run stale timeout (minutes)"
                hint="Close ACTIVE agent runs as STALLED when their last run event is older than this window. 0 disables auto-close; the UI can still surface runs as stale earlier for operator attention."
              >
                <Input
                  type="number"
                  min={0}
                  max={10080}
                  value={agentRunStaleMinutes}
                  onChange={(e) =>
                    setAgentRunStaleMinutes(Number(e.target.value) || 0)
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

          <Section
            title="Auto-transition on assignment"
            hint="When an agent is assigned to a queued/backlog issue, the server can flip the issue into a chosen IN_PROGRESS status atomically with the AGENT_ASSIGNED event. Lets agents skip the statuses.list + issues.transition round-trip on every dispatch."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <Field
                label="Started status"
                hint="Pick the IN_PROGRESS-category status to transition into. Off = no auto-transition (agents handle it client-side). The transition is skipped when the issue is already in IN_PROGRESS / IN_REVIEW or in DONE / CANCELED."
              >
                <select
                  value={startedStatusId ?? ""}
                  onChange={(e) =>
                    setStartedStatusId(
                      e.target.value === "" ? null : e.target.value,
                    )
                  }
                  disabled={!canEdit}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  <option value="">Off — agents handle transition client-side</option>
                  {(current?.statuses ?? [])
                    .filter((s) => s.category === "IN_PROGRESS")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </Field>
              {startedStatusId && (
                <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-[0.6875rem] text-muted-foreground">
                  When AGENT_ASSIGNED fires, the issue auto-transitions
                  to this status. The event payload gains an{" "}
                  <code>autoTransitionedTo</code> field so receivers can
                  distinguish a server-driven transition from a
                  pre-existing status.
                </div>
              )}
            </div>
          </Section>

          <Section
            title="AI"
            hint="Forge-internal AI features. Calls Anthropic directly; no cross-system data sharing. Off by default."
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              <Field
                label="Provider"
                hint="Hermes is the default — it routes through your model-router plugin so you don't need a direct API key. Switch to another provider for direct calls."
              >
                <select
                  value={aiProvider}
                  onChange={(e) =>
                    setAiProvider(
                      e.target.value as
                        | "hermes"
                        | "openai"
                        | "anthropic"
                        | "custom",
                    )
                  }
                  disabled={!canEdit}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  {(aiStatus?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {!p.available ? " (env not configured)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {aiStatus &&
                !aiStatus.activeProviderAvailable &&
                aiStatus.activeProviderReason && (
                  <div className="rounded-md border border-amber-300/30 bg-amber-300/[0.05] px-3 py-2 text-[0.6875rem] text-amber-200/90">
                    <span className="font-medium">Provider unavailable.</span>{" "}
                    {aiStatus.activeProviderReason} — calls will be skipped
                    until env is set.
                  </div>
                )}
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Enable AI features</div>
                  <div className="text-xs text-muted-foreground">
                    Master toggle. When off, no AI calls are made regardless
                    of the sub-toggles below.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={aiEnabled}
                  onChange={(e) => setAiEnabled(e.target.checked)}
                  disabled={!canEdit}
                  className="h-4 w-4"
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Triage on create</div>
                  <div className="text-xs text-muted-foreground">
                    When a human creates an issue, run a one-shot AI
                    classification (priority, labels, agent) and surface
                    it as an apply/dismiss chip on the issue page.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={aiTriageOnCreate}
                  onChange={(e) => setAiTriageOnCreate(e.target.checked)}
                  disabled={!canEdit || !aiEnabled}
                  className="h-4 w-4"
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Coach comments</div>
                  <div className="text-xs text-muted-foreground">
                    When an issue stalls, an agent misses an ack, or an SLA
                    is breached, post a short diagnostic comment as the
                    Coach agent. Requires the Coach agent below.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={aiCoachEnabled}
                  onChange={(e) => setAiCoachEnabled(e.target.checked)}
                  disabled={!canEdit || !aiEnabled}
                  className="h-4 w-4"
                />
              </label>
              <Field
                label="Model"
                hint="Override the provider's default. Leave blank to use the provider default (Hermes resolves via your session model)."
              >
                <Input
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  placeholder={
                    aiStatus?.providers.find((p) => p.id === aiProvider)
                      ?.defaultModel ?? "(provider default)"
                  }
                  disabled={!canEdit || !aiEnabled}
                />
              </Field>

              <ModelCredentials canEdit={canEdit} />

              <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Coach agent</div>
                  <div className="text-xs text-muted-foreground">
                    {aiStatus?.coach
                      ? `Active — @${aiStatus.coach.profileKey} (${aiStatus.coach.name})`
                      : "Not yet set up. Coach is a non-claiming agent that posts diagnostic comments."}
                  </div>
                </div>
                {!aiStatus?.coach && canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => ensureCoach.mutate({})}
                    disabled={ensureCoach.isPending}
                  >
                    {ensureCoach.isPending ? "Creating…" : "Set up Coach"}
                  </Button>
                )}
              </div>
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
                    agentRunStaleMinutes,
                    autoRedispatchOnStall,
                    requiredAckSeconds,
                    autoRedispatchOnNoack,
                    slaEnforcementEnabled,
                    aiEnabled,
                    aiTriageOnCreate,
                    aiCoachEnabled,
                    aiProvider,
                    aiModel: aiModel.trim() ? aiModel.trim() : null,
                    startedStatusId,
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
      <div className="mb-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
      {hint && <div className="mt-1 text-[0.6875rem] text-muted-foreground">{hint}</div>}
    </div>
  );
}


/**
 * Per-workspace chat-model credentials (DB-backed, key encrypted). Lets the
 * Streaming (Completions) engine and Forge's internal AI features reach a
 * model with NO environment variables. Keys are write-only — the server
 * returns `hasKey`, never the secret.
 */
const CRED_PROVIDERS: Array<{ id: "openai" | "anthropic" | "custom"; label: string; hint: string; needsBase?: boolean }> = [
  { id: "openai", label: "OpenAI", hint: "Direct OpenAI API key (sk-…). Optional base URL for OpenRouter / LM Studio." },
  { id: "anthropic", label: "Anthropic", hint: "Anthropic API key — used via the OpenAI-compatible endpoint." },
  { id: "custom", label: "Custom (OpenAI-compatible)", hint: "Any OpenAI-compatible endpoint (vLLM, OpenRouter, …). Base URL required.", needsBase: true },
];

function ModelCredentials({ canEdit }: { canEdit: boolean }) {
  const utils = trpc.useUtils();
  const { data: creds } = trpc.ai.credentials.useQuery(undefined, { enabled: canEdit });
  const setM = trpc.ai.setCredential.useMutation({
    onSuccess: () => {
      void utils.ai.credentials.invalidate();
      void utils.ai.status.invalidate();
      toast.success("Model credential saved.");
    },
    onError: (e) => toast.error(e.message),
  });
  const rmM = trpc.ai.removeCredential.useMutation({
    onSuccess: () => {
      void utils.ai.credentials.invalidate();
      void utils.ai.status.invalidate();
      toast.success("Credential removed.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (!canEdit) return null;

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-background/40 p-3">
      <div>
        <div className="text-sm font-medium">Model credentials</div>
        <div className="text-xs text-muted-foreground">
          Store a chat-model key per provider so the Streaming engine and AI
          features work without environment variables. Keys are encrypted at
          rest and never shown again. A stored key overrides any env var.
        </div>
      </div>
      <div className="space-y-2">
        {CRED_PROVIDERS.map((p) => {
          const existing = creds?.find((c) => c.providerId === p.id);
          return (
            <CredentialRow
              key={p.id}
              meta={p}
              existing={existing}
              busy={setM.isPending || rmM.isPending}
              onSave={(vals) => setM.mutate({ providerId: p.id, ...vals })}
              onRemove={() => rmM.mutate({ providerId: p.id })}
            />
          );
        })}
      </div>
    </div>
  );
}

function CredentialRow({
  meta,
  existing,
  busy,
  onSave,
  onRemove,
}: {
  meta: { id: string; label: string; hint: string; needsBase?: boolean };
  existing?: { hasKey: boolean; baseUrl: string | null; defaultModel: string | null; enabled: boolean };
  busy: boolean;
  onSave: (vals: { apiKey?: string; baseUrl?: string; defaultModel?: string; enabled?: boolean }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [model, setModel] = useState(existing?.defaultModel ?? "");

  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5">
      <div className="flex items-center gap-2">
        <span
          className={
            "h-1.5 w-1.5 rounded-full " +
            (existing?.hasKey ? "bg-emerald-500" : "bg-muted-foreground/40")
          }
          title={existing?.hasKey ? "Key configured" : "No key stored"}
        />
        <span className="text-sm font-medium text-foreground">{meta.label}</span>
        {existing?.hasKey && (
          <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[0.5625rem] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
            configured
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[0.6875rem] text-muted-foreground hover:text-foreground"
        >
          {open ? "Close" : existing?.hasKey ? "Edit" : "Add key"}
        </button>
      </div>
      {!open && <div className="mt-1 text-[0.6875rem] text-muted-foreground">{meta.hint}</div>}
      {open && (
        <div className="mt-2 space-y-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing?.hasKey ? "•••••••• (blank keeps current)" : "API key"}
            className="font-mono"
          />
          {meta.needsBase && (
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL (https://…/v1)"
              className="font-mono"
            />
          )}
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Default model (optional)"
            className="font-mono"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ember"
              disabled={busy}
              onClick={() => {
                onSave({
                  apiKey: apiKey.trim() || undefined,
                  baseUrl: meta.needsBase ? baseUrl.trim() : undefined,
                  defaultModel: model.trim(),
                  enabled: true,
                });
                setApiKey("");
                setOpen(false);
              }}
            >
              Save
            </Button>
            {existing && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
