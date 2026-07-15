"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { CoachStatusPanel } from "@/components/settings/coach-status-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Kbd } from "@/components/ui/kbd";
import { Confirm } from "@/components/ui/modal";
import { Section } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";
import { workspaceColor } from "@/lib/workspace-color";

type DefaultIssueAssigneeMode = "NONE" | "CREATOR" | "USER";
type CompletionAutomation = "OFF" | "RECOMMEND" | "AUTO_WHEN_SAFE";
type DeliveryTimelinePolicy = "OFF" | "RECOMMEND" | "REQUIRE_ON_PR" | "AUTO_ON_PR";

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: current, refetch } = trpc.workspace.current.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();

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
  const [agentProgressUpdateMinutes, setAgentProgressUpdateMinutes] = useState(5);
  const [agentRunQuietMinutes, setAgentRunQuietMinutes] = useState(5);
  const [reviewStartTimeoutMinutes, setReviewStartTimeoutMinutes] = useState(5);
  const [workSessionStaleMinutes, setWorkSessionStaleMinutes] = useState(120);
  // Per-run safety budgets. 0 = unlimited (opt-in). See run-budget.ts.
  const [runTokenBudget, setRunTokenBudget] = useState(0);
  const [runCostBudgetUsd, setRunCostBudgetUsd] = useState(0);
  const [runMaxMinutes, setRunMaxMinutes] = useState(0);
  const [runBudgetWarnPct, setRunBudgetWarnPct] = useState(80);
  const [runBudgetAction, setRunBudgetAction] = useState<"PAUSE" | "STOP">("PAUSE");
  const [autoRedispatchOnStall, setAutoRedispatchOnStall] = useState(false);
  const [requiredAckSeconds, setRequiredAckSeconds] = useState(0);
  const [autoRedispatchOnNoack, setAutoRedispatchOnNoack] = useState(false);
  const [slaEnforcementEnabled, setSlaEnforcementEnabled] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiTriageOnCreate, setAiTriageOnCreate] = useState(true);
  const [aiCoachEnabled, setAiCoachEnabled] = useState(true);
  const [aiProvider, setAiProvider] = useState<"hermes" | "openai" | "anthropic" | "custom">(
    "hermes",
  );
  const [aiModel, setAiModel] = useState("");
  const [startedStatusId, setStartedStatusId] = useState<string | null>(null);
  const [reviewStatusId, setReviewStatusId] = useState<string | null>(null);
  const [completionAutomation, setCompletionAutomation] =
    useState<CompletionAutomation>("RECOMMEND");
  const [completionStatusId, setCompletionStatusId] = useState<string | null>(null);
  const [deliveryTimelinePolicy, setDeliveryTimelinePolicy] =
    useState<DeliveryTimelinePolicy>("RECOMMEND");
  const [defaultIssueAssigneeMode, setDefaultIssueAssigneeMode] =
    useState<DefaultIssueAssigneeMode>("NONE");
  const [defaultIssueAssigneeUserId, setDefaultIssueAssigneeUserId] = useState<string | null>(null);

  const { data: aiStatus, refetch: refetchAi } = trpc.ai.status.useQuery();
  const ensureCoach = trpc.ai.ensureCoach.useMutation({
    onSuccess: () => {
      toast.success("Coach agent ready.");
      refetchAi();
    },
    onError: (e) => toast.error(e.message),
  });

  // Reset all local form state from the server snapshot. Used on load and
  // when the operator discards pending edits.
  const resetFromCurrent = useCallback(() => {
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
    setAgentProgressUpdateMinutes(current.agentProgressUpdateMinutes);
    setAgentRunQuietMinutes(current.agentRunQuietMinutes);
    setReviewStartTimeoutMinutes(current.reviewStartTimeoutMinutes);
    setWorkSessionStaleMinutes(current.workSessionStaleMinutes ?? 120);
    setRunTokenBudget(current.runTokenBudget ?? 0);
    setRunCostBudgetUsd(Number(current.runCostBudgetUsd ?? 0));
    setRunMaxMinutes(current.runMaxMinutes ?? 0);
    setRunBudgetWarnPct(current.runBudgetWarnPct ?? 80);
    setRunBudgetAction((current.runBudgetAction as "PAUSE" | "STOP") ?? "PAUSE");
    setAutoRedispatchOnStall(current.autoRedispatchOnStall);
    setRequiredAckSeconds(current.requiredAckSeconds);
    setAutoRedispatchOnNoack(current.autoRedispatchOnNoack);
    setSlaEnforcementEnabled(current.slaEnforcementEnabled);
    setAiEnabled(current.aiEnabled);
    setAiTriageOnCreate(current.aiTriageOnCreate);
    setAiCoachEnabled(current.aiCoachEnabled);
    setAiProvider((current.aiProvider as "hermes" | "openai" | "anthropic" | "custom") ?? "hermes");
    setAiModel(current.aiModel ?? "");
    setStartedStatusId(current.startedStatusId ?? null);
    setReviewStatusId(current.reviewStatusId ?? null);
    setCompletionAutomation(current.completionAutomation ?? "RECOMMEND");
    setCompletionStatusId(current.completionStatusId ?? null);
    setDeliveryTimelinePolicy(current.deliveryTimelinePolicy ?? "RECOMMEND");
    setDefaultIssueAssigneeMode(
      (current.defaultIssueAssigneeMode ?? "NONE") as DefaultIssueAssigneeMode,
    );
    setDefaultIssueAssigneeUserId(current.defaultIssueAssigneeUserId ?? null);
  }, [current]);

  useEffect(() => {
    resetFromCurrent();
  }, [resetFromCurrent]);

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
  const normalizedDefaultIssueAssigneeUserId =
    defaultIssueAssigneeMode === "USER" ? defaultIssueAssigneeUserId : null;

  // Field-by-field diff against the server snapshot. Drives the save bar's
  // pending count and the dirty gate, so we only push when something moved.
  const dirtyFields = useMemo(() => {
    if (!current) return [] as string[];
    const fields: Array<[string, boolean]> = [
      ["name", name.trim() !== current.name],
      ["avatarUrl", (avatarUrl.trim() || "") !== (current.avatarUrl ?? "")],
      ["cycleLengthDays", cycleLengthDays !== current.cycleLengthDays],
      ["cycleCooldownDays", cycleCooldownDays !== current.cycleCooldownDays],
      ["timeTrackingEnabled", timeTrackingEnabled !== current.timeTrackingEnabled],
      ["attachmentQuotaMb", attachmentQuotaMb !== current.attachmentQuotaMb],
      ["agentIdleTimeoutMinutes", agentIdleTimeoutMinutes !== current.agentIdleTimeoutMinutes],
      ["assignmentSlaMinutes", assignmentSlaMinutes !== current.assignmentSlaMinutes],
      ["agentRunStaleMinutes", agentRunStaleMinutes !== current.agentRunStaleMinutes],
      [
        "agentProgressUpdateMinutes",
        agentProgressUpdateMinutes !== current.agentProgressUpdateMinutes,
      ],
      ["agentRunQuietMinutes", agentRunQuietMinutes !== current.agentRunQuietMinutes],
      [
        "reviewStartTimeoutMinutes",
        reviewStartTimeoutMinutes !== current.reviewStartTimeoutMinutes,
      ],
      [
        "workSessionStaleMinutes",
        workSessionStaleMinutes !== (current.workSessionStaleMinutes ?? 120),
      ],
      ["runTokenBudget", runTokenBudget !== (current.runTokenBudget ?? 0)],
      ["runCostBudgetUsd", runCostBudgetUsd !== Number(current.runCostBudgetUsd ?? 0)],
      ["runMaxMinutes", runMaxMinutes !== (current.runMaxMinutes ?? 0)],
      ["runBudgetWarnPct", runBudgetWarnPct !== (current.runBudgetWarnPct ?? 80)],
      [
        "runBudgetAction",
        runBudgetAction !== ((current.runBudgetAction as "PAUSE" | "STOP") ?? "PAUSE"),
      ],
      ["autoRedispatchOnStall", autoRedispatchOnStall !== current.autoRedispatchOnStall],
      ["requiredAckSeconds", requiredAckSeconds !== current.requiredAckSeconds],
      ["autoRedispatchOnNoack", autoRedispatchOnNoack !== current.autoRedispatchOnNoack],
      ["slaEnforcementEnabled", slaEnforcementEnabled !== current.slaEnforcementEnabled],
      ["aiEnabled", aiEnabled !== current.aiEnabled],
      ["aiTriageOnCreate", aiTriageOnCreate !== current.aiTriageOnCreate],
      ["aiCoachEnabled", aiCoachEnabled !== current.aiCoachEnabled],
      ["aiProvider", aiProvider !== (current.aiProvider ?? "hermes")],
      ["aiModel", (aiModel.trim() || "") !== (current.aiModel ?? "")],
      ["startedStatusId", (startedStatusId ?? null) !== (current.startedStatusId ?? null)],
      ["reviewStatusId", (reviewStatusId ?? null) !== (current.reviewStatusId ?? null)],
      [
        "completionAutomation",
        completionAutomation !== (current.completionAutomation ?? "RECOMMEND"),
      ],
      ["completionStatusId", (completionStatusId ?? null) !== (current.completionStatusId ?? null)],
      [
        "deliveryTimelinePolicy",
        deliveryTimelinePolicy !== (current.deliveryTimelinePolicy ?? "RECOMMEND"),
      ],
      [
        "defaultIssueAssigneeMode",
        defaultIssueAssigneeMode !==
          ((current.defaultIssueAssigneeMode ?? "NONE") as DefaultIssueAssigneeMode),
      ],
      [
        "defaultIssueAssigneeUserId",
        normalizedDefaultIssueAssigneeUserId !==
          (current.defaultIssueAssigneeMode === "USER"
            ? (current.defaultIssueAssigneeUserId ?? null)
            : null),
      ],
    ];
    return fields.filter(([, changed]) => changed).map(([k]) => k);
  }, [
    current,
    name,
    avatarUrl,
    cycleLengthDays,
    cycleCooldownDays,
    timeTrackingEnabled,
    attachmentQuotaMb,
    agentIdleTimeoutMinutes,
    assignmentSlaMinutes,
    agentRunStaleMinutes,
    agentProgressUpdateMinutes,
    agentRunQuietMinutes,
    reviewStartTimeoutMinutes,
    workSessionStaleMinutes,
    runTokenBudget,
    runCostBudgetUsd,
    runMaxMinutes,
    runBudgetWarnPct,
    runBudgetAction,
    autoRedispatchOnStall,
    requiredAckSeconds,
    autoRedispatchOnNoack,
    slaEnforcementEnabled,
    aiEnabled,
    aiTriageOnCreate,
    aiCoachEnabled,
    aiProvider,
    aiModel,
    startedStatusId,
    reviewStatusId,
    completionAutomation,
    completionStatusId,
    deliveryTimelinePolicy,
    defaultIssueAssigneeMode,
    normalizedDefaultIssueAssigneeUserId,
  ]);

  const pending = dirtyFields.length;
  const dirty = pending > 0;

  const save = useCallback(() => {
    if (!canEdit || !dirty || update.isPending) return;
    if (defaultIssueAssigneeMode === "USER" && !defaultIssueAssigneeUserId) {
      toast.error("Choose a workspace member for the default issue assignee.");
      return;
    }
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
      agentProgressUpdateMinutes,
      agentRunQuietMinutes,
      reviewStartTimeoutMinutes,
      workSessionStaleMinutes,
      // Persist unlimited as NULL (not 0) so the column matches its documented
      // null = unlimited semantics; the form treats both as "no cap".
      runTokenBudget: runTokenBudget > 0 ? runTokenBudget : null,
      runCostBudgetUsd: runCostBudgetUsd > 0 ? runCostBudgetUsd : null,
      runMaxMinutes: runMaxMinutes > 0 ? runMaxMinutes : null,
      runBudgetWarnPct,
      runBudgetAction,
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
      reviewStatusId,
      completionAutomation,
      completionStatusId,
      deliveryTimelinePolicy,
      defaultIssueAssigneeMode,
      defaultIssueAssigneeUserId: normalizedDefaultIssueAssigneeUserId,
    });
  }, [
    canEdit,
    dirty,
    update,
    name,
    avatarUrl,
    cycleLengthDays,
    cycleCooldownDays,
    timeTrackingEnabled,
    attachmentQuotaMb,
    agentIdleTimeoutMinutes,
    assignmentSlaMinutes,
    agentRunStaleMinutes,
    agentProgressUpdateMinutes,
    agentRunQuietMinutes,
    reviewStartTimeoutMinutes,
    workSessionStaleMinutes,
    runTokenBudget,
    runCostBudgetUsd,
    runMaxMinutes,
    runBudgetWarnPct,
    runBudgetAction,
    autoRedispatchOnStall,
    requiredAckSeconds,
    autoRedispatchOnNoack,
    slaEnforcementEnabled,
    aiEnabled,
    aiTriageOnCreate,
    aiCoachEnabled,
    aiProvider,
    aiModel,
    startedStatusId,
    reviewStatusId,
    completionAutomation,
    completionStatusId,
    deliveryTimelinePolicy,
    defaultIssueAssigneeMode,
    defaultIssueAssigneeUserId,
    normalizedDefaultIssueAssigneeUserId,
  ]);

  // ⌘S / Ctrl+S saves when there are pending changes.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, save]);

  return (
    <>
      <Topbar title="Workspace" subtitle={ws.name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-10 p-4 pb-24 sm:p-6">
          <Section
            title="Identity"
            hint="Visible to everyone in this workspace. The key is immutable once set."
          >
            <FormCard className="p-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-[64px_1fr]">
                <span
                  className="grid h-16 w-16 shrink-0 place-items-center rounded-md font-mono text-xl font-semibold"
                  style={{
                    backgroundColor: badge.bg,
                    color: badge.fg,
                    boxShadow: `inset 0 0 0 1px ${badge.ring}`,
                  }}
                >
                  {ws.key.slice(0, 3)}
                </span>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Name" hint="Shown in the workspace switcher.">
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={!canEdit}
                      maxLength={80}
                    />
                  </Field>
                  <Field label="Avatar URL" optional hint="Leave empty for the auto color badge.">
                    <Input
                      value={avatarUrl}
                      onChange={(e) => setAvatarUrl(e.target.value)}
                      placeholder="https://example.com/avatar.png"
                      disabled={!canEdit}
                    />
                  </Field>
                  <Field label="Key" hint="Used in issue ids like FRG-42. Can't be changed.">
                    <Input value={ws.key} className="font-mono" disabled readOnly />
                  </Field>
                  <Field label="Slug" hint="Appears in URLs.">
                    <Input value={ws.slug} className="font-mono" disabled readOnly />
                  </Field>
                </div>
              </div>
            </FormCard>
          </Section>

          <Section
            title="Sprint cadence"
            hint="Default iteration cadence. Each sprint can still override on create; rollover uses these."
          >
            <FormCard className="grid grid-cols-1 gap-5 p-4 sm:grid-cols-2 sm:p-5">
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
            </FormCard>
          </Section>

          <Section
            title="Tracking & storage"
            hint="Settings-driven toggles and quotas. No magic numbers baked into handlers."
          >
            <FormCard className="space-y-5 p-5">
              <FormToggle
                checked={timeTrackingEnabled}
                onChange={setTimeTrackingEnabled}
                disabled={!canEdit}
                label="Enable time tracking"
                hint="Exposes per-issue start/stop timers in the issue rail and the aggregated time-entry report."
              />
              <div className="grid grid-cols-1 gap-5 border-t border-border/60 pt-5 sm:grid-cols-2">
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
                  hint="Flip an agent to OFFLINE when no signal arrives for this long. Signals = delivered webhooks (AGENT_ASSIGNED / COMMENT_CREATED) plus any agents.heartbeat call. 0 disables the sweep; 15 is a good default."
                >
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={agentIdleTimeoutMinutes}
                    onChange={(e) => setAgentIdleTimeoutMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
              </div>
            </FormCard>
          </Section>

          <Section
            title="Issue defaults"
            hint="Defaults are applied only when the create caller did not choose any human assignees."
          >
            <FormCard className="space-y-5 p-5">
              <Field
                label="Default human assignee"
                hint="Controls new issues only. Agent assignment and auto-dispatch remain separate."
              >
                <select
                  value={defaultIssueAssigneeMode}
                  onChange={(e) => {
                    const mode = e.target.value as DefaultIssueAssigneeMode;
                    setDefaultIssueAssigneeMode(mode);
                    if (mode !== "USER") setDefaultIssueAssigneeUserId(null);
                  }}
                  disabled={!canEdit}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                >
                  <option value="NONE">No default</option>
                  <option value="CREATOR">Issue creator</option>
                  <option value="USER">Specific member</option>
                </select>
              </Field>

              {defaultIssueAssigneeMode === "USER" && (
                <Field
                  label="Member"
                  hint="Must be an active workspace member. Removing the member clears this default."
                >
                  <select
                    value={defaultIssueAssigneeUserId ?? ""}
                    onChange={(e) => setDefaultIssueAssigneeUserId(e.target.value || null)}
                    disabled={!canEdit}
                    className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="">Choose a member...</option>
                    {(members ?? []).map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.name ?? m.user.email}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <div className="text-meta rounded-md border border-border/60 bg-background/40 px-3 py-2 text-muted-foreground">
                Existing issues are unchanged. New issues with an explicit assignee keep that
                explicit choice.
              </div>
            </FormCard>
          </Section>

          <Section
            title="Agent SLA"
            hint="Watchdog for assignments where the agent woke up but never moved the issue. Pure follow-through reliability — no priority changes. Lower = louder."
          >
            <FormCard className="space-y-5 p-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                  label="Stalled SLA (minutes)"
                  hint="Flip an issue to STALLED when an assigned agent hasn't moved it out of BACKLOG/TODO within this window. 0 disables. 30 is a reasonable start."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10080}
                    value={assignmentSlaMinutes}
                    onChange={(e) => setAssignmentSlaMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Run stale timeout (minutes)"
                  hint="Canonically close ACTIVE agent runs as STALLED when their last run event is older than this. 0 disables auto-close."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10080}
                    value={agentRunStaleMinutes}
                    onChange={(e) => setAgentRunStaleMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Progress update cadence (minutes)"
                  hint="Ask agents to refresh their rolling status during long phases at this cadence. 0 disables the reminder; meaningful phase changes should still be reported."
                >
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={agentProgressUpdateMinutes}
                    onChange={(e) => setAgentProgressUpdateMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Run quiet threshold (minutes)"
                  hint="Show an ACTIVE run as Quiet / needing attention after this long without a run event. This is an early visual signal, not a state transition. 0 disables."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10080}
                    value={agentRunQuietMinutes}
                    onChange={(e) => setAgentRunQuietMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Review start timeout (minutes)"
                  hint="Open a human fallback when an agent reviewer was dispatched but never acknowledged. 0 disables."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10080}
                    value={reviewStartTimeoutMinutes}
                    onChange={(e) => setReviewStartTimeoutMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Work session stale timeout (minutes)"
                  hint="Flag an active branch/worktree lease when its owner stops checking in. Stale sessions continue blocking duplicate work until resumed or abandoned. 0 disables."
                >
                  <Input
                    type="number"
                    min={0}
                    max={43200}
                    value={workSessionStaleMinutes}
                    onChange={(e) => setWorkSessionStaleMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
              </div>
              <Field
                label="Required ack (seconds)"
                hint="How long an agent has to comment or transition an issue after assignment before AGENT_NOACK fires. 0 disables. 60–180s is typical."
              >
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={requiredAckSeconds}
                  onChange={(e) => setRequiredAckSeconds(Number(e.target.value) || 0)}
                  disabled={!canEdit}
                />
              </Field>
              <div className="space-y-4 border-t border-border/60 pt-5">
                <FormToggle
                  checked={autoRedispatchOnStall}
                  onChange={setAutoRedispatchOnStall}
                  disabled={!canEdit}
                  label="Auto-redispatch on stall"
                  hint="When on, a stall also clears assignedAgentId so the auto-dispatcher re-picks. Off = event-only (operator-driven)."
                />
                <FormToggle
                  checked={autoRedispatchOnNoack}
                  onChange={setAutoRedispatchOnNoack}
                  disabled={!canEdit}
                  label="Auto-redispatch on no-ack"
                  hint="When on, AGENT_NOACK also clears assignedAgentId so the auto-dispatcher re-picks. Mirrors the stall toggle."
                />
                <FormToggle
                  checked={slaEnforcementEnabled}
                  onChange={setSlaEnforcementEnabled}
                  disabled={!canEdit}
                  label="Enforce per-issue SLA"
                  hint="When on, scans for issues past their SLA target and emits ISSUE_SLA_BREACH (which also fires the Coach). Set a target per issue from the “SLA target” field in the issue rail — issues with no target are never breached."
                />
              </div>
            </FormCard>
          </Section>

          <Section
            title="Run safety budgets"
            hint="Hard caps per agent run. The idle watchdog above only catches quiet runs — these catch a busy-but-looping one before it burns unbounded tokens, cost, or time. 0 = no cap (opt-in)."
          >
            <FormCard className="space-y-5 p-5">
              {runTokenBudget === 0 && runCostBudgetUsd === 0 && runMaxMinutes === 0 && (
                <div className="text-meta rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-foreground/80">
                  No per-run budget set — agent runs are uncapped. A single runaway run has burned
                  21M+ tokens here before. Set a token, cost, or time cap below to auto-
                  {runBudgetAction === "STOP" ? "stop" : "pause"} a run that exceeds it.
                </div>
              )}
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
                <Field
                  label="Token budget"
                  hint="Cumulative tokensIn + tokensOut per run. 0 = unlimited."
                >
                  <Input
                    type="number"
                    min={0}
                    max={1_000_000_000}
                    value={runTokenBudget}
                    onChange={(e) => setRunTokenBudget(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Cost budget (USD)"
                  hint="Per-run cost cap, matched against the run's reported costUsd. 0 = unlimited."
                >
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    max={100000}
                    value={runCostBudgetUsd}
                    onChange={(e) => setRunCostBudgetUsd(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="Max minutes"
                  hint="Wall-clock cap since the run started. 0 = unlimited."
                >
                  <Input
                    type="number"
                    min={0}
                    max={10080}
                    value={runMaxMinutes}
                    onChange={(e) => setRunMaxMinutes(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                  label="Warn at (% of budget)"
                  hint="Emit a one-time advisory warning when a run crosses this share of any cap. 0 disables the early warning."
                >
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={runBudgetWarnPct}
                    onChange={(e) => setRunBudgetWarnPct(Number(e.target.value) || 0)}
                    disabled={!canEdit}
                  />
                </Field>
                <Field
                  label="On breach"
                  hint="Pause stops the provider run and parks it WAITING with a 'raise budget & resume / abandon' notification — no dangling state. Stop closes it as abandoned."
                >
                  <select
                    value={runBudgetAction}
                    onChange={(e) => setRunBudgetAction(e.target.value as "PAUSE" | "STOP")}
                    disabled={!canEdit}
                    className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="PAUSE">Pause &amp; notify (recommended)</option>
                    <option value="STOP">Stop (abandon the run)</option>
                  </select>
                </Field>
              </div>
            </FormCard>
          </Section>

          <Section
            title="Auto-transition on assignment"
            hint="When an agent is assigned a queued/backlog issue, the server can flip it into a chosen IN_PROGRESS status atomically with AGENT_ASSIGNED — letting agents skip the statuses.list + issues.transition round-trip on every dispatch."
          >
            <FormCard className="space-y-4 p-5">
              <Field
                label="Started status"
                hint="The IN_PROGRESS-category status to transition into. Off = no auto-transition (agents handle it client-side). Skipped when the issue is already IN_PROGRESS / IN_REVIEW or in DONE / CANCELED."
              >
                <select
                  value={startedStatusId ?? ""}
                  onChange={(e) =>
                    setStartedStatusId(e.target.value === "" ? null : e.target.value)
                  }
                  disabled={!canEdit}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
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
                <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
                  When AGENT_ASSIGNED fires, the issue auto-transitions to this status. The event
                  payload gains an <code>autoTransitionedTo</code> field so receivers can
                  distinguish a server-driven transition from a pre-existing status.
                </div>
              )}
            </FormCard>
          </Section>

          <Section
            title="Auto-transition on completion"
            hint="When an agent finishes EXECUTE work via runs.complete, the server can flip the issue into a chosen IN_REVIEW status — a finished EXECUTE run is a signal to review, not a signal to mark done. Done stays a human call."
          >
            <FormCard className="space-y-4 p-5">
              <Field
                label="Review status"
                hint="The IN_REVIEW-category status to transition into. Off = no auto-transition. Skipped when the issue is already IN_REVIEW or in DONE / CANCELED. Never applies to Research/Review/Discuss runs — those never move the issue."
              >
                <Combobox
                  ariaLabel="Review status"
                  value={reviewStatusId}
                  onChange={setReviewStatusId}
                  disabled={!canEdit}
                  allowNone
                  noneLabel="Off — no auto-transition on completion"
                  placeholder="Off — no auto-transition on completion"
                  options={(current?.statuses ?? [])
                    .filter((s) => s.category === "IN_REVIEW")
                    .map((s) => ({ value: s.id, label: s.name, color: s.color }))}
                />
              </Field>
              {reviewStatusId && (
                <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
                  When an EXECUTE run completes successfully, the issue auto-transitions to this
                  status for human review.
                </div>
              )}
            </FormCard>
          </Section>

          <Section
            title="Completion recommendations"
            hint="Turn verified agent results and merged implementation PRs into one shared, actionable close-out card. Forge can either recommend the transition or apply it only when every central safety check passes."
          >
            <FormCard className="space-y-5 p-5">
              <Field
                label="Completion policy"
                hint="Recommend is the safe default. Automatic completion is held while runs, review gates, decisions, blockers, unmerged PRs, or unconfirmed checks remain."
              >
                <Combobox
                  ariaLabel="Completion policy"
                  value={completionAutomation}
                  onChange={(value) =>
                    setCompletionAutomation((value ?? "RECOMMEND") as CompletionAutomation)
                  }
                  disabled={!canEdit}
                  options={[
                    { value: "OFF", label: "Off" },
                    { value: "RECOMMEND", label: "Recommend — ask a person to mark done" },
                    { value: "AUTO_WHEN_SAFE", label: "Automatic when safe" },
                  ]}
                />
              </Field>
              <Field
                label="Done status"
                hint="The DONE-category status used by the recommendation action and safe automatic transition."
              >
                <Combobox
                  ariaLabel="Completion status"
                  value={completionStatusId}
                  onChange={setCompletionStatusId}
                  disabled={!canEdit}
                  allowNone
                  noneLabel="Off — choose no completion status"
                  placeholder="Choose a done status"
                  options={(current?.statuses ?? [])
                    .filter((s) => s.category === "DONE")
                    .map((s) => ({ value: s.id, label: s.name, color: s.color }))}
                />
              </Field>
              {completionAutomation === "AUTO_WHEN_SAFE" && completionStatusId && (
                <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
                  Forge marks the issue done only after the shared safety gate passes. If anything
                  is unresolved, the same close-out card appears with the held reasons and evidence
                  instead.
                </div>
              )}
            </FormCard>
          </Section>

          <Section
            title="Code delivery timeline"
            hint="Keep issue timelines understandable when agents and contributors open implementation pull requests. Mechanical heartbeats stay in the delivery record instead of becoming comments."
          >
            <FormCard className="space-y-4 p-5">
              <Field
                label="PR handoff comment"
                hint="Agents can include a concise implementation, validation, and caveat summary while attaching the pull request."
              >
                <Combobox
                  ariaLabel="PR handoff comment policy"
                  value={deliveryTimelinePolicy}
                  onChange={(value) =>
                    setDeliveryTimelinePolicy((value ?? "RECOMMEND") as DeliveryTimelinePolicy)
                  }
                  disabled={!canEdit}
                  options={[
                    { value: "OFF", label: "Off — no delivery prompt" },
                    { value: "RECOMMEND", label: "Recommend a handoff comment" },
                    { value: "REQUIRE_ON_PR", label: "Require a comment when attaching a PR" },
                    { value: "AUTO_ON_PR", label: "Automatically post a concise PR comment" },
                  ]}
                />
              </Field>
              <div className="text-meta rounded-md border border-border bg-background/40 px-3 py-2 text-muted-foreground">
                {deliveryTimelinePolicy === "OFF" &&
                  "Forge records the PR and delivery state without prompting for an issue comment."}
                {deliveryTimelinePolicy === "RECOMMEND" &&
                  "Forge returns a suggested next action and comment template after the PR is attached."}
                {deliveryTimelinePolicy === "REQUIRE_ON_PR" &&
                  "PR attachment is rejected unless the caller supplies a human-readable timeline update in the same request."}
                {deliveryTimelinePolicy === "AUTO_ON_PR" &&
                  "Forge posts one agent-authored PR handoff automatically when the caller does not provide a richer update."}
              </div>
            </FormCard>
          </Section>

          <Section
            title="AI provider"
            hint="Forge-internal AI features. Calls the chosen provider directly; no cross-system data sharing. Off by default."
          >
            <FormCard className="space-y-5 p-5">
              <Field
                label="Provider"
                hint="Hermes is the default — it routes through your model-router plugin so you don't need a direct API key. Switch to another provider for direct calls."
              >
                <select
                  value={aiProvider}
                  onChange={(e) =>
                    setAiProvider(e.target.value as "hermes" | "openai" | "anthropic" | "custom")
                  }
                  disabled={!canEdit}
                  className="focus-ring w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                >
                  {(aiStatus?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {!p.available ? " (env not configured)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {aiStatus && !aiStatus.activeProviderAvailable && aiStatus.activeProviderReason && (
                <div className="text-meta rounded-md border border-amber-300/30 bg-amber-300/[0.05] px-3 py-2 text-amber-200/90">
                  <span className="font-medium">Provider unavailable.</span>{" "}
                  {aiStatus.activeProviderReason} — calls will be skipped until env is set.
                </div>
              )}
              <Field
                label="Model"
                optional
                hint="Override the provider's default. Leave blank to use the provider default (Hermes resolves via your session model)."
              >
                <Input
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  placeholder={
                    aiStatus?.providers.find((p) => p.id === aiProvider)?.defaultModel ??
                    "(provider default)"
                  }
                  className="font-mono"
                  disabled={!canEdit || !aiEnabled}
                />
              </Field>

              <div className="space-y-4 border-t border-border/60 pt-5">
                <FormToggle
                  checked={aiEnabled}
                  onChange={setAiEnabled}
                  disabled={!canEdit}
                  label="Enable AI features"
                  hint="Master toggle. When off, no AI calls are made regardless of the sub-toggles below."
                />
                <FormToggle
                  checked={aiTriageOnCreate}
                  onChange={setAiTriageOnCreate}
                  disabled={!canEdit || !aiEnabled}
                  label="Triage on create"
                  hint="When a human creates an issue, run a one-shot AI classification (priority, labels, agent) and surface it as an apply/dismiss chip on the issue page."
                />
                <FormToggle
                  checked={aiCoachEnabled}
                  onChange={setAiCoachEnabled}
                  disabled={!canEdit || !aiEnabled}
                  label="Coach comments"
                  hint="When an issue stalls, an agent misses an ack, or an SLA is breached, post a short diagnostic comment as the Coach agent. Requires the Coach agent below."
                />
                <CoachStatusPanel />
              </div>

              <div className="border-t border-border/60 pt-5">
                <ModelCredentials canEdit={canEdit} />
              </div>

              <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Coach agent</div>
                  <div className="text-meta text-muted-foreground">
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
            </FormCard>
          </Section>

          {canDelete && (
            <DangerZone>
              <DangerRow
                title="Archive workspace"
                blurb="Members lose access until restored. Data is retained — you can reactivate later from Settings → Workspaces."
                ctaLabel="Archive"
                onClick={() => setArchiveOpen(true)}
              />
              <DangerRow
                title="Delete workspace"
                blurb="Permanently removes all issues, projects, sprints, attachments, and events. Cannot be undone."
                ctaLabel="Delete…"
                confirmHint={`Type ${ws.name}`}
                onClick={() => setDeleteOpen(true)}
              />
            </DangerZone>
          )}
        </div>
      </div>

      {canEdit && (
        <SaveBar
          pending={pending}
          saving={update.isPending}
          onSave={save}
          onDiscard={resetFromCurrent}
        />
      )}

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

/* ────────────────────────── Local layout helpers ────────────────────────── */

/** Sectioned card surface — bg-card/40 with a hairline border. */
function FormCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-card/40 ${className}`}>{children}</div>
  );
}

/** Labeled field with inline help text under the label (no tooltips). */
function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[0.8125rem] font-medium tracking-tight text-foreground">{label}</span>
        {optional && <span className="text-meta text-muted-foreground/70">optional</span>}
      </div>
      {hint && <p className="text-meta mt-0.5 max-w-[480px] text-muted-foreground">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** Pill toggle with a label + inline help, matching the design vocabulary. */
function FormToggle({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`focus-ring mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-ember" : "bg-subtle"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-background transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[0.8125rem] font-medium">{label}</span>
        {hint && (
          <span className="text-meta mt-0.5 block max-w-[460px] text-muted-foreground">{hint}</span>
        )}
      </span>
    </label>
  );
}

/** Red-washed danger zone container. */
function DangerZone({ children }: { children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-danger/30 bg-danger/[0.03]">
      <header className="flex flex-wrap items-center gap-2 border-b border-danger/20 bg-danger/5 px-4 py-2.5">
        <AlertTriangle size={13} className="text-danger" />
        <h2 className="text-sm font-semibold text-danger">Danger zone</h2>
        <span className="text-meta text-danger/80">Irreversible. Confirm before continuing.</span>
      </header>
      <div className="divide-y divide-danger/15">{children}</div>
    </section>
  );
}

function DangerRow({
  title,
  blurb,
  ctaLabel,
  confirmHint,
  onClick,
}: {
  title: string;
  blurb: string;
  ctaLabel: string;
  confirmHint?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-meta mt-0.5 max-w-[520px] text-muted-foreground">{blurb}</div>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {confirmHint && (
          <span className="hidden h-7 items-center rounded-md border border-danger/40 bg-background px-2 font-mono text-xs text-muted-foreground/70 sm:flex">
            {confirmHint}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onClick}
          className="w-full border-danger/40 text-danger hover:bg-danger/10 sm:w-auto"
        >
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}

/** Sticky save bar — appears only when the form is dirty. */
function SaveBar({
  pending,
  saving,
  onSave,
  onDiscard,
}: {
  pending: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!pending) return null;
  return (
    <div className="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:px-6">
      <div className="text-meta flex items-center gap-2 text-muted-foreground">
        <span className="forge-breath inline-block h-1.5 w-1.5 rounded-full bg-ember" />
        <span>
          {pending} pending change{pending === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button
          variant="ember"
          size="sm"
          onClick={onSave}
          disabled={saving}
          className="flex-1 sm:flex-none"
        >
          {saving ? "Saving…" : "Save changes"}
          <Kbd className="ml-1.5 hidden sm:inline-flex">⌘S</Kbd>
        </Button>
      </div>
    </div>
  );
}

/**
 * Per-workspace chat-model credentials (DB-backed, key encrypted). Lets the
 * Streaming (Completions) engine and Forge's internal AI features reach a
 * model with NO environment variables. Keys are write-only — the server
 * returns `hasKey`, never the secret.
 */
const CRED_PROVIDERS: Array<{
  id: "openai" | "anthropic" | "custom";
  label: string;
  hint: string;
  needsBase?: boolean;
}> = [
  {
    id: "openai",
    label: "OpenAI",
    hint: "Direct OpenAI API key (sk-…). Optional base URL for OpenRouter / LM Studio.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "Anthropic API key — used via the OpenAI-compatible endpoint.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    hint: "Any OpenAI-compatible endpoint (vLLM, OpenRouter, …). Base URL required.",
    needsBase: true,
  },
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
        <div className="text-meta text-muted-foreground">
          Store a chat-model key per provider so the Streaming engine and AI features work without
          environment variables. Keys are encrypted at rest and never shown again. A stored key
          overrides any env var.
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
  existing?: {
    hasKey: boolean;
    baseUrl: string | null;
    defaultModel: string | null;
    enabled: boolean;
  };
  busy: boolean;
  onSave: (vals: {
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    enabled?: boolean;
  }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
  const [model, setModel] = useState(existing?.defaultModel ?? "");

  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex flex-wrap items-center gap-2">
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
