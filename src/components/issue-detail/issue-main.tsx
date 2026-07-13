"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageCircleReply, Sparkles, Target, Workflow } from "lucide-react";
import { useWorkspace } from "@/hooks/use-workspace";
import { Avatar } from "@/components/ui/avatar";
import { AgentAvatar, type AgentAvatarIdentity } from "@/components/agents/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MarkdownWithAttachments,
  RichContentRenderer,
} from "@/components/markdown/attachment-renderer";
import { DescriptionAiAssist } from "@/components/issue-detail/description-ai-assist";
import {
  PlanStepContextCards,
  type PlanStepIssueContext,
} from "@/components/issue-detail/plan-step-context-card";
import { SubIssuesPanel, ParentIssueBacklink } from "@/components/issue-detail/sub-issues-panel";
import { ActionRequestCard } from "@/components/action-requests/action-request-card";
import {
  CommentToolCallCard,
  splitToolDirectives,
} from "@/components/issue-detail/comment-tool-call-card";
import {
  CommentHistoryPopover,
  EditedFallbackLink,
} from "@/components/issue-detail/comment-history-popover";
import { ConfidenceChip, type ConfidenceLevel } from "@/components/issue-detail/confidence-chip";
import { usePasteUpload } from "@/components/attachments/use-paste-upload";
import { useDropUpload } from "@/components/attachments/use-drop-upload";
import { DropOverlay } from "@/components/attachments/drop-overlay";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { parseAgentRequestsFromBody, type ParsedAgentRequest } from "@/lib/agent-request-parser";
import { parseSlashCommands, SLASH_COMMAND_HINT, type SlashCommand } from "@/lib/slash-commands";
import { expandTemplatesInBody, type SlashTemplateSideEffect } from "@/lib/slash-templates";
import { SlashAutocomplete, useSlashAutocomplete } from "@/components/slash-autocomplete";
import { MentionInput } from "@/components/inputs/mention-input";
import { Kbd } from "@/components/ui/kbd";
import { Combobox } from "@/components/ui/combobox";
import { clearDraft, readDraft, saveDraft } from "@/components/ui/modal/draft";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { useRealtime } from "@/hooks/use-realtime";

// Live data for the slash-command VALUE autocomplete (projects / agents /
// labels), shared by the description + comment composers so `/project`,
// `/assign`, `/label` complete against real entities. React Query dedupes
// the underlying calls across the three composers.
function useSlashAttributes() {
  const { data: projects } = trpc.project.list.useQuery(
    { archived: false, limit: 100 },
    { staleTime: 60_000 },
  );
  const { data: agents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { staleTime: 60_000 },
  );
  const { data: labels } = trpc.label.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  return useMemo(() => ({ projects: projects?.items, agents, labels }), [projects, agents, labels]);
}

type AgentRequestMode = "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";

type ComposerAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
};

type AgentRequestDraft = ParsedAgentRequest & {
  agentId: string;
  agentName: string;
};

const AGENT_REQUEST_MODES: Array<{
  value: AgentRequestMode;
  label: string;
  hint: string;
}> = [
  { value: "DISCUSS", label: "Discuss", hint: "converse/clarify/advise" },
  { value: "RESEARCH", label: "Research", hint: "gather facts/options" },
  { value: "REVIEW", label: "Review", hint: "evaluate + verdict" },
  { value: "EXECUTE", label: "Execute", hint: "deliver the change/result" },
];

const MODE_LABEL: Record<AgentRequestMode, string> = {
  EXECUTE: "Execute",
  RESEARCH: "Research",
  REVIEW: "Review",
  DISCUSS: "Discuss",
};

function isAgentRequestMode(value: unknown): value is AgentRequestMode {
  return value === "EXECUTE" || value === "RESEARCH" || value === "REVIEW" || value === "DISCUSS";
}

function detectAgentRequests(
  body: string,
  agents: ComposerAgent[],
  overrides: Record<string, { mode: AgentRequestMode; assignIssue?: boolean }>,
): AgentRequestDraft[] {
  const parsed = parseAgentRequestsFromBody(body);
  const byKey = new Map(agents.map((agent) => [agent.profileKey.toLowerCase(), agent]));
  const out: AgentRequestDraft[] = [];
  const seen = new Set<string>();
  for (const req of parsed) {
    const agent = byKey.get(req.profileKey.toLowerCase());
    if (!agent || seen.has(agent.profileKey.toLowerCase())) continue;
    seen.add(agent.profileKey.toLowerCase());
    const override = overrides[agent.profileKey.toLowerCase()];
    const parsedMode = isAgentRequestMode(req.mode) ? req.mode : "DISCUSS";
    out.push({
      profileKey: agent.profileKey,
      mode: override?.mode ?? parsedMode,
      assignIssue: override?.assignIssue ?? req.assignIssue,
      agentId: agent.id,
      agentName: agent.name,
    });
  }
  return out;
}

function normalizeAgentRequestRows(value: unknown): Array<{
  profileKey: string;
  mode: AgentRequestMode;
  assignIssue?: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const profileKey = rec.profileKey;
    const mode = rec.mode;
    if (typeof profileKey !== "string" || !isAgentRequestMode(mode)) return [];
    return [{ profileKey, mode, assignIssue: rec.assignIssue === true }];
  });
}

/**
 * Main column of the issue detail page — description (inline-editable)
 * and the comment stream + composer. Separated from the page shell so
 * the sticky right rail can sit alongside without forcing a rerender of
 * the description when the rail's tab changes.
 */

type Comment = {
  id: string;
  body: string;
  createdAt: Date | string;
  /**
   * Comment kind. STATUS comments are rolling agent run updates (one per
   * run, upserted via `comments.upsertStatus`) and render in the regular
   * chronological list using `updatedAt` as their effective timestamp.
   * BODY comments sort by creation time. SYSTEM comments are server-authored
   * notices (assignment, dispatch provenance) with no author — rendered as
   * ambient narration.
   */
  kind?: "BODY" | "STATUS" | "SYSTEM";
  /** Last update time (server-side `updatedAt`). Drives STATUS timeline position. */
  updatedAt?: Date | string;
  /** Compact step label rendered next to STATUS rows. Always null on BODY. */
  currentStep?: string | null;
  /** SYSTEM rows have no author; renderer handles the null case. */
  author: { id: string; name: string | null; image: string | null } | null;
  /**
   * When set, the comment was authored via an API key linked to this agent
   * (e.g. Victor / Mizu). Overrides the human author in the byline.
   */
  authoringAgent?: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
  } | null;
  run?: {
    id: string;
    status: "ACTIVE" | "COMPLETED" | "ABANDONED" | "STALLED" | "WAITING";
    finishedAt: Date | string | null;
  } | null;
  /**
   * Structured Agent Requests created from @agent composer chips or typed
   * @agent /mode sugar. Rendering these keeps the timeline from relying on
   * raw prose for requested agent + mode intent.
   */
  agentRequests?: unknown;
  /**
   * Optional short reply suggestions an agent attached when posting.
   * Rendered as click-to-insert chips beneath the LATEST agent body
   * comment only — older chips hide so the thread doesn't accumulate
   * stale CTAs.
   */
  suggestedReplies?: string[];
  /**
   * Server-side `editedAt` timestamp — set when an operator (or the
   * authoring agent) edits a BODY comment after it was first posted.
   * Drives the "edited" link next to the timestamp; null/undefined
   * means the comment hasn't been changed since creation. Shipped by
   * the server-primitives slice alongside the `comment.history` query
   * that powers the popover.
   */
  editedAt?: Date | string | null;
  /**
   * Agent self-reported confidence on AGENT-authored comments. LOW
   * draws the operator's eye; HIGH reassures. Null on human comments
   * — even if a row carries the field, the chip is suppressed unless
   * `authoringAgent` is set, matching the rule documented in
   * `docs/concepts/comments.md`.
   */
  confidence?: ConfidenceLevel | null;
  /**
   * Optional one-line reason an agent attaches when self-reporting
   * confidence — surfaced inside the chip's tooltip so the operator
   * can scrub the rationale without expanding any extra UI.
   */
  confidenceReason?: string | null;
};

/**
 * Window event used to ferry a quick-reply chip click from inside a
 * `<TimelineCommentCard>` up to the `<Comments>` composer. Listening
 * is cheaper than threading a setter through every comment, and the
 * payload is tiny.
 */
const QUICK_REPLY_EVENT = "forge:quick-reply-insert";
interface QuickReplyEventDetail {
  issueId: string;
  text: string;
  agentProfileKey?: string | null;
}
function dispatchQuickReply(issueId: string, text: string, agentProfileKey?: string | null) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<QuickReplyEventDetail>(QUICK_REPLY_EVENT, {
      detail: { issueId, text, agentProfileKey },
    }),
  );
}

function quickReplyTextForComposer(text: string, agentProfileKey?: string | null) {
  const key = agentProfileKey?.trim().replace(/^@+/, "");
  if (!key) return text;

  const mention = `@${key}`;
  const trimmedStart = text.trimStart();
  const alreadyAddressed =
    trimmedStart.toLowerCase() === mention.toLowerCase() ||
    trimmedStart.toLowerCase().startsWith(`${mention.toLowerCase()} `);

  return alreadyAddressed ? text : `${mention} ${text}`;
}

function timestampMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Agent comments often start with a one-line provenance tag like
 *
 *   [forge-cli daemon on hostname] Picked up assignment…
 *   _(forge-cli daemon on hostname)_
 *
 * Extract that into a small metadata line above the body so the body
 * itself stays focused on the substance. We accept either a leading
 * `[…]` bracket prefix on the first non-empty line, an italic underscore
 * line `_(…)_`, or a literal `> _runtime: …_` blockquote — agents have
 * been writing all three flavours in the wild.
 *
 * Returns the (possibly empty) provenance string and the cleaned body.
 * Designed to be cheap: only runs the regex on the first ~120 characters.
 */
function splitProvenance(body: string): { provenance: string | null; rest: string } {
  if (!body) return { provenance: null, rest: body };
  // Skip leading blank lines.
  const trimmed = body.replace(/^\s+/, "");
  // [bracket] prefix on the first line
  const bracketMatch = trimmed.match(/^\[([^\]\n]{1,160})\]\s*(?:\.|\—|-)?\s*/);
  if (bracketMatch) {
    return {
      provenance: bracketMatch[1].trim(),
      rest: trimmed.slice(bracketMatch[0].length).trimStart(),
    };
  }
  // _(italic provenance)_ first line
  const italicMatch = trimmed.match(/^_\(([^\n)]{1,160})\)_\s*\n?/);
  if (italicMatch) {
    return {
      provenance: italicMatch[1].trim(),
      rest: trimmed.slice(italicMatch[0].length).trimStart(),
    };
  }
  return { provenance: null, rest: body };
}

export function IssueMain({
  issueId,
  description,
  comments,
  onDescriptionSave,
  /**
   * Caller-resolved signal used by `<ActionRequestCard>` to decide
   * whether to render Accept / Decline buttons. The page hands in
   * the union of "current user is on assignees" || "is a watcher" —
   * the component itself layers on the OWNER/ADMIN check via
   * `useWorkspace`. Default `false` so cards stay safely read-only
   * if the page hasn't migrated.
   */
  canResolveActions = false,
  kind,
  projectId,
  parent,
  executionSteps,
}: {
  issueId: string;
  description: string | null;
  comments: Comment[];
  onDescriptionSave: (next: string | null) => void;
  currentRunId?: string | null;
  canResolveActions?: boolean;
  kind: string;
  projectId: string | null;
  parent: { id: string; number: number; title: string; deletedAt: Date | string | null } | null;
  executionSteps: PlanStepIssueContext[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ParentIssueBacklink parent={parent} />
      <PlanStepContextCards contexts={executionSteps} />
      <IssueActionRequests issueId={issueId} canResolve={canResolveActions} />
      <IssueGoalsStrip issueId={issueId} />
      <IssuePlansStrip issueId={issueId} />
      <DescriptionBlock issueId={issueId} description={description} onSave={onDescriptionSave} />
      <SubIssuesPanel parentId={issueId} parentProjectId={projectId} parentKind={kind} />
      <Comments issueId={issueId} comments={comments} canResolveActions={canResolveActions} />
    </div>
  );
}

/**
 * Surface every open issue-bound ask even when the agent/runtime created it
 * outside the comment timeline. Comment-bound requests remain rendered beside
 * their source comment, so this panel only fills the visibility gap for other
 * sources (runs, automations, imports, and workspace decision flows).
 */
function IssueActionRequests({ issueId, canResolve }: { issueId: string; canResolve: boolean }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data } = trpc.actionRequest.list.useQuery(
    { issueId, status: "OPEN", limit: 20 },
    { staleTime: 15_000 },
  );
  useRealtime((event) => {
    if (event.subjectType !== "action-request") return;
    void utils.actionRequest.list.invalidate();
  });
  const requests = (data?.items ?? []).filter((request) => request.sourceType !== "comment");
  if (requests.length === 0) return null;
  return (
    <section className="space-y-2 rounded-lg border border-warning/30 bg-warning/[0.04] p-3">
      <div className="text-meta font-medium uppercase tracking-wide text-warning">
        Needs your decision · {requests.length}
      </div>
      {requests.map((request) =>
        request.kind === "FREE_FORM" ? (
          <div key={request.id} className="rounded-md border border-warning/30 bg-card/50 p-2">
            <div className="text-sm font-medium">{request.title}</div>
            {request.body ? (
              <p className="text-meta mt-1 whitespace-pre-wrap text-muted-foreground">
                {request.body}
              </p>
            ) : null}
            <Link
              href={`/w/${ws.slug}/command-center`}
              className="text-meta mt-2 inline-flex text-ember hover:underline"
            >
              Answer in Command Center
            </Link>
          </div>
        ) : (
          <ActionRequestCard
            key={request.id}
            requestId={request.id}
            issueId={issueId}
            canResolve={canResolve}
          />
        ),
      )}
    </section>
  );
}

/**
 * Backlink strip: goals spawned from this issue (via `/goal` or
 * goal.create with this issueId). Renders nothing when the issue has no
 * goals, so it's invisible on the common path. Closes the issue→goal
 * dead-end (the goal detail already links back to its source issue).
 */
function IssueGoalsStrip({ issueId }: { issueId: string }) {
  const ws = useWorkspace();
  const { data } = trpc.goal.list.useQuery(
    { issueId, includeArchived: false, limit: 10 },
    { staleTime: 30_000 },
  );
  const goals = data?.items ?? [];
  if (goals.length === 0) return null;
  return (
    <section className="flex flex-wrap items-center gap-1.5">
      <span className="text-meta flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
        <Target className="h-3 w-3" />
        {goals.length === 1 ? "Goal" : "Goals"}
      </span>
      {goals.map((g) => (
        <Link
          key={g.id}
          href={`/w/${ws.slug}/goals/${g.id}`}
          className="text-meta inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 transition hover:border-ember/40 hover:text-ember"
          title={g.title}
        >
          <span className="max-w-[18rem] truncate">{g.title}</span>
          <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
            {g.status.toLowerCase()}
          </span>
        </Link>
      ))}
    </section>
  );
}

/**
 * Backlink strip: execution plans this issue is the subject of (via
 * `ExecutionPlan.issueId`). Each chip shows the plan's step progress
 * (done / total) with a thin fill bar so "where is the agent in the
 * plan" reads at a glance. Renders nothing when the issue has no plans.
 */
function IssuePlansStrip({ issueId }: { issueId: string }) {
  const ws = useWorkspace();
  const { data } = trpc.executionPlan.list.useQuery({ issueId, limit: 10 }, { staleTime: 30_000 });
  const plans = data?.items ?? [];
  if (plans.length === 0) return null;
  return (
    <section className="flex flex-wrap items-center gap-1.5">
      <span className="text-meta flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
        <Workflow className="h-3 w-3" />
        {plans.length === 1 ? "Plan" : "Plans"}
      </span>
      {plans.map((p) => {
        const total = p._count.steps;
        const pct = total > 0 ? Math.round((p.doneSteps / total) * 100) : 0;
        return (
          <Link
            key={p.id}
            href={`/w/${ws.slug}/plans/${p.id}`}
            className="text-meta inline-flex items-center gap-2 rounded-md border border-border bg-card/40 px-2 py-1 transition hover:border-ember/40 hover:text-ember"
            title={`${p.title} · ${p.doneSteps}/${total} steps · ${p.status.toLowerCase()}`}
          >
            <span className="max-w-[16rem] truncate">{p.title}</span>
            {total > 0 && (
              <span className="flex items-center gap-1">
                <span className="h-1 w-10 overflow-hidden rounded-full bg-subtle">
                  <span
                    className="block h-full rounded-full bg-ember"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {p.doneSteps}/{total}
                </span>
              </span>
            )}
            <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
              {p.status.toLowerCase()}
            </span>
          </Link>
        );
      })}
    </section>
  );
}

function DescriptionBlock({
  issueId,
  description,
  onSave,
}: {
  issueId: string;
  description: string | null;
  onSave: (next: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(description ?? "");
  const [editing, setEditing] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // AI draft/enhance result, staged for review before it touches the issue.
  const [suggestion, setSuggestion] = useState<{
    markdown: string;
    original: string | null;
  } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep draft in sync when the server sends a fresh description and we're
  // not currently editing it. Avoids trampling in-flight edits.
  useEffect(() => {
    if (!editing) setDraft(description ?? "");
  }, [description, editing]);

  // Slash autocomplete on the description editor too — same coexistence
  // model as the comment composer (suppressed while the @-mention list
  // owns the caret). Templates are off: a description isn't a comment, so
  // `/status` etc. don't apply.
  const slashAttributes = useSlashAttributes();
  const slash = useSlashAutocomplete({
    value: draft,
    onChange: setDraft,
    textareaRef: editorRef,
    suppressed: mentionOpen,
    attributes: slashAttributes,
  });

  const applyCommandsM = trpc.issue.applyCommands.useMutation({
    onSuccess: ({ results }) => {
      const skipped = results.filter((r) => r.status === "skipped");
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} command${skipped.length === 1 ? "" : "s"} skipped: ${skipped
            .map((s) => `/${s.kind}${s.reason ? ` (${s.reason})` : ""}`)
            .join(", ")}`,
        );
      }
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.issue.watchers.invalidate({ issueId });
    },
    onError: (e) => toast.error(`Slash commands: ${e.message}`),
  });

  // Save: pull recognised slash-command lines out of the draft, apply
  // them via `issue.applyCommands`, and persist the remaining prose as
  // the description. Mirrors the comment composer so a `/assign @victor`
  // typed in the description also assigns.
  const commitDescription = useCallback(() => {
    const { strippedBody, commands } = parseSlashCommands(draft);
    if (commands.length > 0) {
      applyCommandsM.mutate({ issueId, commands });
    }
    onSave(strippedBody.trim() || null);
    setEditing(false);
  }, [draft, issueId, applyCommandsM, onSave]);

  const paste = usePasteUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });
  const drop = useDropUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Description</SectionLabel>
        <DescriptionAiAssist
          issueId={issueId}
          hasDescription={!!description?.trim()}
          onResult={setSuggestion}
        />
      </div>
      {suggestion && (
        <div className="mb-2 mt-1 space-y-2 rounded-md border border-amber-300/30 bg-amber-300/[0.04] p-3">
          <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-amber-200/80">
            <Sparkles className="h-3 w-3 text-amber-300" />
            {suggestion.original != null ? "Suggested rewrite" : "Drafted description"}
          </div>
          {suggestion.original != null && suggestion.original.trim() && (
            <div className="space-y-1">
              <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                Current
              </div>
              <div className="prose prose-sm max-w-none rounded bg-background/50 p-2 text-[0.8125rem] opacity-70">
                <MarkdownWithAttachments body={suggestion.original} />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">
              {suggestion.original != null ? "Suggested" : "Draft"}
            </div>
            <div className="prose prose-sm max-w-none rounded bg-background p-2 text-[0.8125rem]">
              <MarkdownWithAttachments body={suggestion.markdown} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="ember"
              onClick={() => {
                onSave(suggestion.markdown);
                setDraft(suggestion.markdown);
                setSuggestion(null);
                setEditing(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
      {editing ? (
        <div
          className="relative space-y-2"
          onDragEnter={drop.onDragEnter}
          onDragOver={drop.onDragOver}
          onDragLeave={drop.onDragLeave}
          onDrop={drop.onDrop}
        >
          <DropOverlay active={drop.isOver} label="Drop to attach to description" />
          <div className="relative">
            <MentionInput
              ref={(handle) => {
                editorRef.current = (handle?.textarea as HTMLTextAreaElement | null) ?? null;
              }}
              autoFocus
              multiline
              rows={8}
              highlightMentions
              highlightCommands
              value={draft}
              onChange={setDraft}
              onMentionOpenChange={setMentionOpen}
              onPaste={paste.onPaste}
              onSubmit={() => {
                // Cmd/Ctrl+Enter saves when the slash dropdown is closed;
                // when open, the slash hook consumes the key for command
                // insertion.
                if (!slash.visible) commitDescription();
              }}
              onKeyDown={(e) => {
                // Slash autocomplete owns nav / Enter / Tab / Escape when
                // its dropdown is open.
                if (slash.onKeyDown(e as React.KeyboardEvent)) return;
                // Esc reverts the in-progress edit and drops back to read
                // mode. Matches the title editor's cancel pattern at the
                // top of the issue page.
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(description ?? "");
                  setEditing(false);
                }
              }}
              onKeyUp={slash.bind.onKeyUp}
              onClick={slash.bind.onClick}
              onSelect={slash.bind.onSelect}
              onFocus={slash.bind.onFocus}
              placeholder="Description (Markdown-flavored). @ to mention · / for commands · paste or drop files to attach."
              className="focus-ring w-full rounded-md border border-input bg-background p-2 text-sm"
              ariaLabel="Issue description"
            />
            {slash.visible && <SlashAutocomplete {...slash.dropdownProps} />}
          </div>
          <div className="flex gap-2">
            <Button variant="ember" size="sm" onClick={commitDescription}>
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(description ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <article
          className="prose prose-sm max-w-none cursor-text rounded-md px-1 py-0.5 text-[0.8125rem] leading-relaxed text-foreground/90 hover:bg-subtle/40"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {description ? (
            <RichContentRenderer body={description} />
          ) : (
            <span className="text-muted-foreground">No description. Click to add.</span>
          )}
        </article>
      )}
    </section>
  );
}

function Comments({
  issueId,
  comments,
  canResolveActions,
}: {
  issueId: string;
  comments: Comment[];
  canResolveActions: boolean;
}) {
  const utils = trpc.useUtils();
  // Draft persists per-issue under `forge.draft.comment:<issueId>` so a
  // half-written comment survives accidental navigation. We hydrate from
  // localStorage on first mount; subsequent renders own `draft` in state
  // and write back debounced via the effect below. Successful submit
  // clears the row.
  const draftKey = `comment:${issueId}`;
  const [draft, setDraft] = useState("");
  const [draftHydrated, setDraftHydrated] = useState(false);
  // Synthetic textarea ref that mirrors MentionInput's underlying
  // textarea — kept in sync via the imperative-handle callback below
  // so the slash autocomplete hook can read / focus the real DOM node.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Pending commands are stashed here when we fire `createComment` so
  // the success callback can dispatch `applyCommands` once the
  // comment is persisted. `useState` keeps it in scope across renders
  // without re-fetching the form's draft.
  const [pendingCommands, setPendingCommands] = useState<SlashCommand[]>([]);
  // Pending template side-effects (e.g. `/blocked` → open an
  // action-request). Mirrors `pendingCommands` — fired in the
  // `createComment.onSuccess` callback so we don't open an unblock
  // request for a comment that never landed.
  const [pendingSideEffects, setPendingSideEffects] = useState<SlashTemplateSideEffect[]>([]);
  // True while MentionInput's @-dropdown is open. Used to suppress the
  // slash picker so the two autocompletes never coexist at the caret —
  // whichever is open owns Arrow/Enter/Tab/Esc.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [agentRequestOverrides, setAgentRequestOverrides] = useState<
    Record<string, { mode: AgentRequestMode; assignIssue?: boolean }>
  >({});
  const { data: agentRoster = [] } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { staleTime: 60_000 },
  );
  // Hydrate the draft from localStorage on mount (and when the issue
  // changes — guards against the page re-keying without remounting).
  useEffect(() => {
    const stored = readDraft<string>(draftKey);
    if (stored && typeof stored === "string") setDraft(stored);
    setDraftHydrated(true);
    // We deliberately re-run on issue change; the hydration flag resets
    // so the debounced writer below skips a stale "" save during the
    // tick before hydration completes.
    return () => setDraftHydrated(false);
  }, [draftKey]);

  // Persist the draft (debounced ~500ms) so quick edits don't thrash
  // localStorage. Empty strings clear the row outright.
  useEffect(() => {
    if (!draftHydrated) return;
    const t = setTimeout(() => {
      if (draft.length === 0) clearDraft(draftKey);
      else saveDraft<string>(draftKey, draft);
    }, 500);
    return () => clearTimeout(t);
  }, [draft, draftHydrated, draftKey]);

  // Quick-reply chips dispatched from anywhere in the tree route into
  // the composer via a window event. Filter by issueId so a stray
  // event from another issue page (rare, but possible during fast
  // navigation) doesn't write into the wrong draft.
  useEffect(() => {
    function onInsert(event: Event) {
      const detail = (event as CustomEvent<QuickReplyEventDetail>).detail;
      if (!detail || detail.issueId !== issueId) return;
      const text = quickReplyTextForComposer(detail.text, detail.agentProfileKey);
      setDraft((prev) => {
        // If the composer already has text, separate with a blank
        // line so the chip doesn't trample mid-sentence. Otherwise
        // just seed it.
        if (prev.trim().length === 0) return text;
        return `${prev.replace(/\s+$/, "")}\n\n${text}`;
      });
      // Focus + scroll the textarea into view so the user can edit
      // before submitting. Defer to next tick so the state update
      // commits before the focus call.
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        composerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
    window.addEventListener(QUICK_REPLY_EVENT, onInsert as EventListener);
    return () => window.removeEventListener(QUICK_REPLY_EVENT, onInsert as EventListener);
  }, [issueId]);

  // Autocomplete: fires on top-of-body slash lines, inserts stubs on
  // Enter / Tab / click. Includes templates (`/status`, `/blocked`,
  // `/approve`, `/handoff`) — quick-comment expanders. Picking a
  // template with a side-effect (e.g. `/blocked`) queues the
  // mutation; it fires when the comment lands.
  const slashAttributes = useSlashAttributes();
  const slash = useSlashAutocomplete({
    value: draft,
    onChange: (next) => setDraft(next),
    textareaRef: composerRef,
    includeTemplates: true,
    suppressed: mentionOpen,
    attributes: slashAttributes,
    onTemplateSideEffect: (eff) => {
      setPendingSideEffects((prev) => [...prev, eff]);
    },
  });

  // Action-request mutation for `/blocked` template side-effects.
  // Stays best-effort — if it fails, the comment is already
  // persisted, and we toast the error without rolling back.
  const createActionRequestM = trpc.actionRequest.create.useMutation({
    onError: (e) => toast.error(`Unblock request: ${e.message}`),
  });

  // `/goal` template side-effect → `goal.create({ title, issueId })`,
  // then `goal.decompose({ goalId })` when the orchestration backend is
  // available so the new goal immediately has live PLANNING status and
  // planner feedback instead of landing as a silent OPEN record.
  const router = useRouter();
  const ws = useMaybeWorkspace();
  const goalRouterAny = (trpc as unknown as Record<string, unknown>).goal as
    | Record<string, unknown>
    | undefined;
  const goalCreateAny = goalRouterAny?.create as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { title: string; issueId?: string }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const goalDecomposeAny = goalRouterAny?.decompose as
    | {
        useMutation: (opts?: unknown) => {
          mutate: (input: { goalId: string }) => void;
          isPending: boolean;
        };
      }
    | undefined;
  const pendingGoalNavRef = useRef<string | null>(null);
  const decomposeGoalMut = goalDecomposeAny?.useMutation({
    onSuccess: (result: { plannerAgentId?: string | null } | undefined) => {
      const goalId = pendingGoalNavRef.current;
      pendingGoalNavRef.current = null;
      toast.success(
        result?.plannerAgentId
          ? "Goal created — planner is drafting the plan."
          : "Goal created — plan draft is live; assign a planner to continue.",
      );
      if (goalId && ws) router.push(`/w/${ws.slug}/goals/${goalId}`);
    },
    onError: (e: { message: string }) => {
      const goalId = pendingGoalNavRef.current;
      pendingGoalNavRef.current = null;
      toast.warning(`Goal created, but planning did not start: ${e.message}`);
      if (goalId && ws) router.push(`/w/${ws.slug}/goals/${goalId}`);
    },
  }) as { mutate: (input: { goalId: string }) => void; isPending: boolean } | undefined;
  const createGoalMut = goalCreateAny?.useMutation({
    onSuccess: (result: { id?: string } | undefined) => {
      const goalId = result?.id;
      if (goalId && ws) {
        if (decomposeGoalMut) {
          pendingGoalNavRef.current = goalId;
          toast.success("Goal created — starting planner…");
          decomposeGoalMut.mutate({ goalId });
          return;
        }
        toast.success("Goal created.");
        router.push(`/w/${ws.slug}/goals/${goalId}`);
      } else {
        toast.success("Goal created.");
      }
    },
    onError: (e: { message: string }) => toast.error(`Goal: ${e.message}`),
  }) as
    | { mutate: (input: { title: string; issueId?: string }) => void; isPending: boolean }
    | undefined;

  const applyCommandsM = trpc.issue.applyCommands.useMutation({
    onSuccess: ({ results }) => {
      const skipped = results.filter((r) => r.status === "skipped");
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} command${skipped.length === 1 ? "" : "s"} skipped: ${skipped
            .map((s) => `/${s.kind}${s.reason ? ` (${s.reason})` : ""}`)
            .join(", ")}`,
        );
      } else if (results.length > 0) {
        toast.success(`Applied ${results.length} command${results.length === 1 ? "" : "s"}.`);
      }
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.issue.watchers.invalidate({ issueId });
    },
    onError: (e) => toast.error(`Slash commands: ${e.message}`),
  });

  const createComment = trpc.comment.create.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      // Immediate agent feedback: the server auto-resumes a WAITING run
      // to ACTIVE in the same transaction as the comment (openOrTouchRun),
      // and dispatches any @-mentioned agent. Reflect that instantly —
      // flip the cached run so the strip/cue stops saying "waiting on you"
      // the moment the operator replies — then invalidate so a freshly
      // spun-up run (or the real ACTIVE row) reconciles from the server.
      utils.agentRun.activeForIssue.setData({ issueId }, (old) =>
        old && old.status === "WAITING"
          ? { ...old, status: "ACTIVE", lastEventAt: new Date() }
          : old,
      );
      utils.agentRun.activeForIssue.invalidate({ issueId });
      if (pendingCommands.length > 0) {
        applyCommandsM.mutate({ issueId, commands: pendingCommands });
        setPendingCommands([]);
      }
      // Fire any queued template side-effects after the comment lands.
      // Today the only side-effect is `actionRequest` (`/blocked`); the
      // shape supports extension without touching the comment flow.
      if (pendingSideEffects.length > 0) {
        for (const eff of pendingSideEffects) {
          if (eff.kind === "actionRequest") {
            createActionRequestM.mutate({
              title: eff.title,
              kind: "FREE_FORM",
              issueId,
            });
          } else if (eff.kind === "goal") {
            if (createGoalMut) {
              createGoalMut.mutate({ title: eff.title, issueId });
            } else {
              toast.error("Goal orchestration isn't available yet in this workspace.");
            }
          }
        }
        setPendingSideEffects([]);
      }
      setDraft("");
      setAgentRequestOverrides({});
      clearDraft(draftKey);
    },
    onError: (e) => toast.error(e.message),
  });

  // Submit handler shared by the form's onSubmit and MentionInput's
  // Cmd/Ctrl+Enter handler. Returns void; treats empty/command-only
  // bodies the same as the form's existing submit logic does.
  //
  // Order: templates first (expanding `/blocked …` / `/handoff @x …`
  // into prose plus any injected `/assign` line), then the structured
  // slash-command parse over the expanded body. Side-effects detected
  // here merge with anything the autocomplete already queued.
  const submitDraft = useCallback(() => {
    if (!draft.trim()) return;
    if (createComment.isPending || applyCommandsM.isPending) return;
    const { expandedBody, sideEffects } = expandTemplatesInBody(draft);
    const { strippedBody, commands } = parseSlashCommands(expandedBody);
    const body = strippedBody.trim();
    if (!body && commands.length === 0 && sideEffects.length === 0) return;
    if (!body && commands.length > 0 && sideEffects.length === 0) {
      applyCommandsM.mutate({ issueId, commands });
      setDraft("");
      clearDraft(draftKey);
      return;
    }
    setPendingCommands(commands);
    if (sideEffects.length > 0) {
      setPendingSideEffects((prev) => [...prev, ...sideEffects]);
    }
    const finalAgentRequests = detectAgentRequests(
      body,
      agentRoster.map((agent) => ({
        id: agent.id,
        name: agent.name,
        profileKey: agent.profileKey,
        avatar: agent.avatar ?? null,
      })),
      agentRequestOverrides,
    ).map((request) => ({
      profileKey: request.profileKey,
      mode: request.mode,
      assignIssue: request.assignIssue === true,
    }));
    createComment.mutate({ issueId, body, agentRequests: finalAgentRequests });
  }, [draft, createComment, applyCommandsM, issueId, draftKey, agentRoster, agentRequestOverrides]);

  // Live preview: do we have any slash commands (on any line)? Drives
  // the hint chip below the textarea. We reuse the real parser so the
  // hint only shows for RECOGNISED commands — prose with a stray `/`
  // (URLs, "and/or") doesn't trip it.
  const hasCommands = useMemo(() => parseSlashCommands(draft).commands.length > 0, [draft]);

  const agentRequests = useMemo(
    () =>
      detectAgentRequests(
        draft,
        agentRoster.map((agent) => ({
          id: agent.id,
          name: agent.name,
          profileKey: agent.profileKey,
          avatar: agent.avatar ?? null,
        })),
        agentRequestOverrides,
      ),
    [draft, agentRoster, agentRequestOverrides],
  );

  const paste = usePasteUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });
  const drop = useDropUpload({
    targetType: "issue",
    targetId: issueId,
    value: draft,
    onChange: setDraft,
  });

  // The active rolling STATUS row is presented in Workstream, where its
  // revisions and live run trace belong. Conversation rows keep a stable
  // createdAt position; a status update can no longer jump through replies.
  // Finished status summaries remain available as historical context.
  const timelineComments = comments
    .filter(
      (comment) =>
        !(
          comment.kind === "STATUS" &&
          (comment.run?.status === "ACTIVE" || comment.run?.status === "WAITING")
        ),
    )
    .sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
  // Identify the most recent agent-authored BODY comment — only its
  // quick-reply chips render (older chips are stale CTAs). STATUS rows
  // never carry chips, so the BODY filter is sufficient.
  const latestAgentBodyId = useMemo(() => {
    for (let i = timelineComments.length - 1; i >= 0; i -= 1) {
      const c = timelineComments[i];
      if (c.authoringAgent && (!c.kind || c.kind === "BODY")) return c.id;
    }
    return null;
  }, [timelineComments]);
  return (
    <section>
      <SectionLabel>
        Comments {timelineComments.length > 0 && <Count>{timelineComments.length}</Count>}
      </SectionLabel>
      <div className="space-y-3">
        {timelineComments.length === 0 && (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        )}
        {timelineComments.map((c) => (
          <TimelineCommentCard
            key={c.id}
            comment={c}
            issueId={issueId}
            canResolveActions={canResolveActions}
            showQuickReplies={c.id === latestAgentBodyId}
          />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitDraft();
        }}
        className="relative mt-2 space-y-2"
        onDragEnter={drop.onDragEnter}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <DropOverlay active={drop.isOver} label="Drop to attach to comment" />
        <div className="relative">
          <MentionInput
            ref={(handle) => {
              // Mirror the underlying textarea node into `composerRef`
              // so the slash autocomplete hook can read it on every
              // tick. Cast: when multiline=true the imperative handle
              // exposes the textarea element.
              composerRef.current = (handle?.textarea as HTMLTextAreaElement | null) ?? null;
            }}
            multiline
            rows={2}
            highlightMentions
            highlightCommands
            value={draft}
            onChange={setDraft}
            onMentionOpenChange={setMentionOpen}
            onPaste={paste.onPaste}
            onSubmit={() => {
              // Cmd/Ctrl+Enter submits when the slash dropdown is closed.
              // When it's open, the slash hook's `onKeyDown` consumes
              // Enter for command insertion (and never sees Cmd+Enter
              // either way), so this stays as the canonical send path.
              if (!slash.visible) submitDraft();
            }}
            onKeyDown={(e) => {
              // Slash autocomplete owns nav / Enter / Tab / Escape
              // when its dropdown is open. The form's submit button
              // still drives explicit submission via click.
              slash.onKeyDown(e as React.KeyboardEvent);
            }}
            // Spread the slash hook's caret-tracking bindings onto the
            // textarea — onKeyUp / onClick / onSelect / onFocus.
            onKeyUp={slash.bind.onKeyUp}
            onClick={slash.bind.onClick}
            onSelect={slash.bind.onSelect}
            onFocus={slash.bind.onFocus}
            placeholder="Leave a comment…  @ to mention · / for commands · paste or drop to attach"
            className="focus-ring w-full rounded-md border border-input bg-background p-2 text-[0.8125rem]"
            ariaLabel="Comment composer"
          />
          {slash.visible && <SlashAutocomplete {...slash.dropdownProps} />}
        </div>
        {agentRequests.length > 0 && (
          <div className="text-meta flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card/30 px-2 py-1.5">
            <span className="text-muted-foreground">Agent request</span>
            {agentRequests.map((request) => {
              const key = request.profileKey.toLowerCase();
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-1.5 py-0.5"
                >
                  <span className="font-medium text-foreground">{request.agentName}</span>
                  <span className="font-mono text-[0.625rem] text-muted-foreground">
                    @{request.profileKey}
                  </span>
                  <Combobox
                    ariaLabel={`Mode for ${request.agentName}`}
                    value={request.mode}
                    onChange={(v) => {
                      const mode = (v ?? "DISCUSS") as AgentRequestMode;
                      setAgentRequestOverrides((prev) => ({
                        ...prev,
                        [key]: {
                          mode,
                          assignIssue:
                            mode === "EXECUTE"
                              ? (prev[key]?.assignIssue ?? request.assignIssue ?? false)
                              : false,
                        },
                      }));
                    }}
                    options={AGENT_REQUEST_MODES.map((mode) => ({
                      value: mode.value,
                      label: `${mode.label} — ${mode.hint}`,
                    }))}
                    className="text-[0.6875rem]"
                  />
                  {request.mode === "EXECUTE" && (
                    <label className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={request.assignIssue === true}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAgentRequestOverrides((prev) => ({
                            ...prev,
                            [key]: { mode: "EXECUTE", assignIssue: checked },
                          }));
                        }}
                      />
                      Assign issue
                    </label>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {hasCommands ? (
          <div className="text-meta text-muted-foreground">{SLASH_COMMAND_HINT}</div>
        ) : (
          <div className="text-meta flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <Kbd>@</Kbd>
            <span>mention</span>
            <span className="text-muted-foreground/40">·</span>
            <Kbd>/</Kbd>
            <span>commands</span>
            <span className="text-muted-foreground/40">·</span>
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
            <span>to send</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!draft.trim() || createComment.isPending || applyCommandsM.isPending}
          >
            Comment
            <Kbd className="ml-1.5">⌘⏎</Kbd>
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Regular timeline comment card. Distinguishes:
 *   - Human authors             — paper-toned card, monogram avatar.
 *   - Agent authors             — the agent's own profile icon (ember
 *                                  tint), indigo "agent" chip, optional `@profileKey`
 *                                  byline. Provenance (e.g. forge-cli
 *                                  daemon hostname) lifts out into a
 *                                  small italic subtitle line so the
 *                                  body stays clean.
 *   - Historical STATUS rows    — soft ember card with "ran status" chip
 *                                  and an `updated Ns ago` timestamp.
 */
function TimelineCommentCard({
  comment,
  issueId,
  canResolveActions,
  showQuickReplies,
}: {
  comment: Comment;
  issueId: string;
  canResolveActions: boolean;
  showQuickReplies: boolean;
}) {
  const isAgent = Boolean(comment.authoringAgent);
  const isStatus = comment.kind === "STATUS";
  const isLiveStatus =
    isStatus &&
    (comment.run?.status === "ACTIVE" ||
      comment.run?.status === "WAITING" ||
      comment.run?.status === "STALLED");
  const statusTime = comment.updatedAt ?? comment.createdAt;
  // BODY comments are editable inline (STATUS rows are agent-owned
  // rolling status, SYSTEM rows are server narration — neither edits).
  const isEditable = !isStatus && comment.kind !== "SYSTEM";
  const [editing, setEditing] = useState(false);
  const displayName = comment.authoringAgent?.name ?? comment.author?.name ?? "System";
  const { provenance, rest } = useMemo(
    () => (isAgent ? splitProvenance(comment.body) : { provenance: null, rest: comment.body }),
    [comment.body, isAgent],
  );
  // Lift any `:::tool` directives out of the body so each tool-call
  // summary renders as a collapsible card (visual parity with the
  // Mission Control chat surface) instead of an opaque code fence.
  // Plain markdown bodies fall through with a single `md` segment.
  const bodySegments = useMemo(() => splitToolDirectives(rest), [rest]);
  const quickReplies = isAgent && showQuickReplies ? (comment.suggestedReplies ?? []) : [];
  const structuredAgentRequests = useMemo(
    () => normalizeAgentRequestRows(comment.agentRequests),
    [comment.agentRequests],
  );
  // Confidence chip: AGENT-authored only, even if a stray human row
  // ever carries the field. Falsy levels short-circuit the render.
  const confidenceLevel: ConfidenceLevel | null =
    isAgent && comment.confidence ? comment.confidence : null;

  // SYSTEM rows are server-authored ambient narration (assignment
  // notices, dispatch provenance). They have no avatar, no card —
  // they render as a thin centered separator-style line so the eye
  // moves past them quickly. Conditional return lives AFTER the
  // useMemo above so hook order stays stable across render paths.
  if (comment.kind === "SYSTEM") {
    return (
      <div className="text-meta flex items-center gap-2 px-1 py-1.5 italic text-muted-foreground">
        <span className="h-px flex-1 bg-border/60" />
        <RichContentRenderer
          body={comment.body}
          className="text-meta italic text-muted-foreground"
        />
        <span className="h-px flex-1 bg-border/60" />
        <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
          {relativeTime(comment.createdAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <CommentAvatar
        name={displayName}
        image={isAgent ? null : (comment.author?.image ?? null)}
        agent={isAgent ? (comment.authoringAgent ?? null) : null}
      />
      <div className="min-w-0 flex-1 space-y-2">
        {/*
         * ActionRequest card rendered ABOVE the comment body — that
         * way the operator sees the recommendation first and the
         * supporting prose underneath. The card only renders if
         * `forComment(commentId)` resolves to a row, so cards never
         * leak onto plain comments.
         */}
        {isAgent && (
          <ActionRequestCard
            commentId={comment.id}
            issueId={issueId}
            canResolve={canResolveActions}
          />
        )}
        <div
          className={`rounded-md border p-2.5 ${
            isStatus
              ? "border-ember/40 bg-ember/[0.04]"
              : isAgent
                ? "border-border bg-card/50"
                : "border-border bg-card/40"
          }`}
        >
          <div className="text-meta flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{displayName}</span>
            {isAgent && comment.authoringAgent && (
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                @{comment.authoringAgent.profileKey}
              </span>
            )}
            {isStatus ? (
              <Badge
                color="#d97706"
                className="font-mono text-[0.6875rem] uppercase tracking-wider"
              >
                {isLiveStatus ? "live status" : "run status"}
              </Badge>
            ) : (
              isAgent && (
                // Indigo `agent` chip mirrors the `linkedAgent` badge on
                // the ApiKey row in settings/access so "this action was
                // an agent" stays visually consistent across the app.
                <Badge
                  color="#6366f1"
                  className="font-mono text-[0.6875rem] uppercase tracking-wider"
                >
                  agent
                </Badge>
              )
            )}
            {isStatus && comment.currentStep && (
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                · {comment.currentStep}
              </span>
            )}
            <span className="text-muted-foreground">
              {isStatus ? `updated ${relativeTime(statusTime)}` : relativeTime(comment.createdAt)}
            </span>
            {!isStatus && comment.editedAt && (
              <CommentEditedMarker commentId={comment.id} editedAt={comment.editedAt} />
            )}
            {confidenceLevel && (
              <ConfidenceChip level={confidenceLevel} reason={comment.confidenceReason ?? null} />
            )}
            {isEditable && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="focus-ring text-meta ml-auto rounded px-1 text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                Edit
              </button>
            )}
          </div>
          {provenance && (
            <div className="mt-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground/80">
              {provenance}
            </div>
          )}
          {structuredAgentRequests.length > 0 && (
            <div className="text-meta mt-1 flex flex-wrap items-center gap-1.5">
              {structuredAgentRequests.map((request) => {
                const mode = isAgentRequestMode(request.mode) ? request.mode : "DISCUSS";
                return (
                  <span
                    key={`${request.profileKey}:${mode}`}
                    className="inline-flex items-center gap-1 rounded-full border border-ember/25 bg-ember/[0.06] px-1.5 py-0.5 text-muted-foreground"
                  >
                    <span>requested</span>
                    <span className="font-medium text-foreground">@{request.profileKey}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="font-medium text-foreground">{MODE_LABEL[mode]}</span>
                    {request.assignIssue && mode === "EXECUTE" && (
                      <span className="text-muted-foreground/70">+ assign</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          {editing ? (
            <CommentEditor
              commentId={comment.id}
              issueId={issueId}
              initialBody={comment.body}
              onClose={() => setEditing(false)}
            />
          ) : (
            <CommentBodyWithTools
              segments={bodySegments}
              className="mt-1.5 text-[0.8125rem] text-foreground/90"
            />
          )}
          {quickReplies.length > 0 && !editing && (
            <QuickReplyChips
              replies={quickReplies}
              onPick={(text) =>
                dispatchQuickReply(issueId, text, comment.authoringAgent?.profileKey)
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline editor for an existing BODY comment. Mirrors the comment
 * composer's mechanics so editing has feature parity with creating:
 * shared `MentionInput` (so @mentions work), the slash autocomplete
 * picker (so `/` commands work), and the same mutual-exclusion guard so
 * the two dropdowns never coexist at the caret.
 *
 * On save:
 *   1. Slash command LINES are parsed out of the body via
 *      `parseSlashCommands` and applied through `issue.applyCommands`
 *      (so `/assign @victor` typed while editing actually assigns).
 *   2. The remaining prose is persisted via `comment.update`, which
 *      diffs old→new @-mentions server-side and dispatches the newly
 *      added agent mentions — the agent-triggering the operator asked
 *      for. Re-saving without new mentions triggers nobody.
 *
 * Templates are intentionally NOT expanded here (no `includeTemplates`):
 * an edit shouldn't silently rewrite a comment into a `/status` block.
 * Structured field commands are enough for the edit surface.
 */
function CommentEditor({
  commentId,
  issueId,
  initialBody,
  onClose,
}: {
  commentId: string;
  issueId: string;
  initialBody: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [body, setBody] = useState(initialBody);
  const [mentionOpen, setMentionOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const slashAttributes = useSlashAttributes();
  const slash = useSlashAutocomplete({
    value: body,
    onChange: setBody,
    textareaRef: editorRef,
    suppressed: mentionOpen,
    attributes: slashAttributes,
  });

  const applyCommandsM = trpc.issue.applyCommands.useMutation({
    onSuccess: ({ results }) => {
      const skipped = results.filter((r) => r.status === "skipped");
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} command${skipped.length === 1 ? "" : "s"} skipped: ${skipped
            .map((s) => `/${s.kind}${s.reason ? ` (${s.reason})` : ""}`)
            .join(", ")}`,
        );
      }
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      utils.issue.watchers.invalidate({ issueId });
    },
    onError: (e) => toast.error(`Slash commands: ${e.message}`),
  });

  const updateM = trpc.comment.update.useMutation({
    onSuccess: () => {
      utils.issue.byId.invalidate({ id: issueId });
      utils.issue.activity.invalidate({ issueId });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = updateM.isPending || applyCommandsM.isPending;

  const save = useCallback(() => {
    if (pending) return;
    const { strippedBody, commands } = parseSlashCommands(body);
    const next = strippedBody.trim();
    if (commands.length > 0) {
      applyCommandsM.mutate({ issueId, commands });
    }
    if (!next) {
      // Editing a comment down to nothing-but-commands: apply the
      // commands (above) and leave the body untouched rather than
      // persisting an empty comment (the router rejects empty bodies).
      if (commands.length > 0) onClose();
      else toast.error("Comment can't be empty.");
      return;
    }
    updateM.mutate({ id: commentId, body: next });
  }, [pending, body, issueId, commentId, applyCommandsM, updateM, onClose]);

  return (
    <div className="relative mt-1.5 space-y-2">
      <div className="relative">
        <MentionInput
          ref={(handle) => {
            editorRef.current = (handle?.textarea as HTMLTextAreaElement | null) ?? null;
          }}
          autoFocus
          multiline
          rows={3}
          highlightMentions
          highlightCommands
          value={body}
          onChange={setBody}
          onMentionOpenChange={setMentionOpen}
          onSubmit={() => {
            if (!slash.visible) save();
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e as React.KeyboardEvent)) return;
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          onKeyUp={slash.bind.onKeyUp}
          onClick={slash.bind.onClick}
          onSelect={slash.bind.onSelect}
          onFocus={slash.bind.onFocus}
          placeholder="Edit comment…  @ to mention · / for commands"
          className="focus-ring w-full rounded-md border border-input bg-background p-2 text-[0.8125rem]"
          ariaLabel="Edit comment"
        />
        {slash.visible && <SlashAutocomplete {...slash.dropdownProps} />}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ember" size="sm" onClick={save} disabled={pending}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Renders a comment body as an ordered run of markdown segments and
 * inline tool-call cards. The split happens upstream
 * (`splitToolDirectives`) so this component is intentionally dumb —
 * just walks the segments and picks the right renderer per kind.
 * Empty markdown segments (a tool directive flanked by blank lines)
 * are skipped so the spacing between cards stays tight.
 */
function CommentBodyWithTools({
  segments,
  className,
}: {
  segments: ReturnType<typeof splitToolDirectives>;
  className?: string;
}) {
  // Fast path for the common case — a body with no tool directives —
  // avoids wrapping a single RichContentRenderer in an extra div.
  if (segments.length === 1 && segments[0].kind === "md") {
    return <RichContentRenderer body={segments[0].text} className={className} />;
  }
  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === "tool") {
          return <CommentToolCallCard key={`tool-${i}`} call={seg.call} />;
        }
        if (!seg.text.trim()) return null;
        return <RichContentRenderer key={`md-${i}`} body={seg.text} />;
      })}
    </div>
  );
}

/**
 * Thin wrapper that swaps between the popover-equipped trigger (when
 * the server-primitives slice has shipped `comment.history`) and the
 * read-only fallback. We don't try to probe the tRPC proxy here — the
 * popover does its own feature-detect and renders a graceful error if
 * the route hasn't shipped yet. This wrapper exists mostly to keep the
 * `TimelineCommentCard` body skinny.
 */
function CommentEditedMarker({
  commentId,
  editedAt,
}: {
  commentId: string;
  editedAt: Date | string;
}) {
  // Defaults to the interactive popover. The fallback is plugged in
  // automatically when the tRPC `comment.history` query surfaces an
  // error inside the popover panel (e.g. route not yet shipped).
  // Toggle this constant if a workspace flag ever needs to gate the
  // popover entirely.
  const FORCE_FALLBACK = false;
  if (FORCE_FALLBACK) {
    return <EditedFallbackLink editedAt={editedAt} />;
  }
  return <CommentHistoryPopover commentId={commentId} editedAt={editedAt} />;
}

/**
 * Quick-reply chip row rendered beneath the latest agent comment.
 * Each chip is a click target that inserts its text into the comment
 * composer (via the `forge:quick-reply-insert` window event). Style
 * follows the warm-earthy guidance — paper background, subtle ember
 * hover so it reads as actionable without competing with the comment
 * body for attention.
 */
function QuickReplyChips({
  replies,
  onPick,
}: {
  replies: string[];
  onPick: (text: string) => void;
}) {
  return (
    <div role="group" aria-label="Quick reply suggestions" className="mt-2 flex flex-wrap gap-1.5">
      {replies.map((text, i) => (
        <button
          key={`${i}-${text}`}
          type="button"
          onClick={() => onPick(text)}
          className="focus-ring text-meta inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-left text-muted-foreground transition-colors hover:border-ember/40 hover:text-foreground"
        >
          <MessageCircleReply className="h-3 w-3" />
          <span className="min-w-0 break-words">{text}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Avatar component for comment cards. Agent comments render the agent's
 * own profile icon via `AgentAvatar` (the same emoji / image / monogram
 * shown in Mission Control and the agent picker), so a reply reads as
 * coming from *that* agent rather than a generic bot. Humans get the
 * standard monogram avatar. Keeps the byline consistent across both
 * surfaces (timeline comments and status pins).
 */
function CommentAvatar({
  name,
  image,
  agent,
}: {
  name: string | null;
  image: string | null;
  agent: AgentAvatarIdentity | null;
}) {
  if (agent) {
    return (
      <AgentAvatar agent={agent} size="xs" shape="circle" active className="h-[22px] w-[22px]" />
    );
  }
  return <Avatar name={name} image={image} size={22} />;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h2>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.6875rem] text-muted-foreground">{children}</span>;
}
