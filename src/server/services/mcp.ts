import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  AgentProvider,
  AgentRunStatus,
  AgentStatus,
  ApiKeyKind,
  ArtifactType,
  CommentKind,
  CycleStatus,
  EventKind,
  ExecutionPlanStatus,
  InitiativeStatus,
  NoteStatus,
  PluginScope,
  Prisma,
  Priority,
  RelationKind,
  RuntimeKind,
  StatusCategory,
  type CanvasStyleKind,
  type EngagementMode,
} from "@prisma/client";
import { nanoid } from "nanoid";
import { db } from "@/server/db";
import { decryptSecret } from "@/server/crypto";
import { getInstallationTokenForApp } from "@/server/services/github-app";
import { deriveRepoPath } from "@/server/services/repo-path";
import { recordChange, maybeAutoTransitionOnComplete } from "@/server/audit";
import { publish } from "@/server/realtime";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import {
  createIssueWithSideEffects,
  resolveDefaultIssueAssigneeIds,
} from "@/server/services/issue-create";
import {
  autoWatchAgent,
  autoWatchUser,
  setIssueAgentWakeTarget,
} from "@/server/services/issue-watchers";
import { extractMentions } from "@/server/services/mentions";
import {
  abandonRunsForAgentReassignment,
  openOrTouchRun,
  appendRunEvent,
  finishRun,
  finishRunsForIssue,
} from "@/server/services/agent-run";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import { getRunsConnectorForAgent } from "@/server/services/dispatch/registry";
import {
  clearBudgetMarkers,
  enforceRunBudget,
  hasAnyBudget,
  RUN_BUDGET_WORKSPACE_SELECT,
} from "@/server/services/run-budget";
import { logger } from "@/server/logger";
import { handoffCompletedRunToStep, maybeAutoJudge } from "@/server/services/orchestration-service";
import { deliverWebhook } from "@/server/services/plugin-runtime";
import { buildChatContextBundle } from "@/server/services/chat-context";
import { agentIdSchema } from "@/server/validators";
import { TERMINAL_STATUS_CATEGORIES, hasTerminalStatusCategory } from "@/lib/saved-view-filters";
import {
  assertKeyScope,
  buildKeyScopeWhere,
  type ApiKeyContext,
} from "@/server/services/api-key-auth";
import {
  ALLOWED_MIME_TYPES,
  ALLOWED_TARGET_TYPES,
  MAX_FILE_SIZE_BYTES,
  createLinkAttachment,
  deleteAttachment,
  fetchLinkMetadata,
  finalizeAttachment,
  getAttachmentInline,
  presignDownloadUrl,
  presignUploadUrl,
} from "@/server/services/storage";
import { forgeEntityTypeSchema, type ForgeEntityType } from "@/lib/entity-ref";
import { assertSafeExternalUrl, isSafeExternalUrl, safeExternalUrlMessage } from "@/lib/url-safety";
import { hydrateEntityRefs } from "@/server/services/entity-hydration";
import { computeAlignment, type AlignItem } from "@/server/services/canvas-alignment";
import { validateRuntimeConfig } from "@/server/services/runtime-config";
import {
  runtimeInfoCreateData,
  runtimeInfoUpdateData,
  sanitizeRuntimeInfo,
  summarizeRuntimeInfo,
} from "@/server/services/runtime-info";
import { mcpServerInfo } from "@/server/build-info";
import {
  engagementInstruction,
  FORGE_RUN_CONTRACT_VERSION,
  forgeRunProtocolInstruction,
  modeMayExecute,
} from "@/server/services/engagement-mode";
import {
  assertMcpIssueMutationPolicy,
  assertMcpIssueMutationsPolicy,
  assertMcpWorkspaceMutationPolicy,
  mcpToolPolicy,
  type ExplicitMcpPolicyToolName,
} from "@/server/services/mcp-policy";
import {
  RUN_COMPLETION_CONFIDENCE_VALUES,
  RUN_REVIEW_VERDICT_VALUES,
  runCompletionMeta,
  validateRunCompletion,
  type RunCompletionConfidence,
  type RunReviewVerdict,
} from "@/server/services/run-completion-contract";
import {
  importGitHubIssue,
  linkGitHubUrlToIssue,
  listLinkedGitHubResources,
  resolveGitHubRepoMapping,
  syncGitHubExternalResource,
} from "@/server/services/github/resource-sync";
import { searchGitHubIssuesAndPulls } from "@/server/services/github/client";
import { listGitHubRepoMappings } from "@/server/services/github/linkability";
import { githubInstallationId } from "@/server/services/github/mapping-policy";
import { parseGitHubUrl } from "@/server/services/github/url";
import {
  EXTERNAL_LINK_KINDS,
  GITHUB_RESOURCE_TYPES,
  type GitHubResourceType,
} from "@/server/services/github/types";

/**
 * Forge's MCP (Model Context Protocol) surface — the stable set of tools any
 * agent runtime (Hermes, Claude, Codex, custom) can call to read/write
 * Forge data.
 *
 * Each tool is auth-gated by scope. Route handlers at `/api/mcp/rpc` (real
 * MCP) and `/api/mcp/:tool` (REST alias) authenticate the API key and then
 * dispatch here. Tools honor granular `ApiKey` narrowing (projectIds,
 * labelIds, initiativeIds) so a per-initiative bot only sees its lane.
 *
 * Tools intentionally mirror the tRPC router surface without depending on
 * the routers themselves — the routers require a full session, which MCP
 * callers don't have. Where possible the zod input schemas are shared with
 * the underlying routers so validation stays consistent.
 */

// ---------------------------------------------------------------------------
// Context + helpers
// ---------------------------------------------------------------------------

export interface McpContext {
  workspaceId: string;
  userId: string | null;
  pluginId: string | null;
  /**
   * Full API key context when the caller came in via a `forge_sk_…` bearer.
   * Null for session-authenticated callers (admin UIs etc.). Carries the
   * narrowing arrays (projectIds / labelIds / initiativeIds) so tools can
   * apply `buildKeyScopeWhere` + `assertKeyScope`.
   */
  apiKey: ApiKeyContext | null;
}

/**
 * Shim to satisfy `assertKeyScope`/`buildKeyScopeWhere` which both expect a
 * tRPC-ish ctx shape (`{ apiKey, db }`). We wrap `McpContext` here so the
 * tRPC helpers work unchanged.
 */
function scopeCtx(ctx: McpContext): { apiKey: ApiKeyContext | null; db: typeof db } {
  return { apiKey: ctx.apiKey, db };
}

const MCP_BODY_REVISION_CAP = 20;

type McpCommentWithDates = {
  kind: CommentKind;
  createdAt: Date;
  updatedAt: Date;
};

function effectiveCommentTime(comment: McpCommentWithDates): number {
  // Rolling STATUS comments represent the latest run update, so expose them
  // at updatedAt in agent-facing bundles. BODY comments keep their original
  // position even if edited later.
  return (comment.kind === CommentKind.STATUS ? comment.updatedAt : comment.createdAt).getTime();
}

function sortCommentsChronologically<T extends McpCommentWithDates>(comments: T[]): T[] {
  return [...comments].sort((a, b) => effectiveCommentTime(a) - effectiveCommentTime(b));
}

async function assertAgentIssueMutationAllowed(
  ctx: McpContext,
  issueId: string,
  action: ExplicitMcpPolicyToolName,
): Promise<void> {
  await assertMcpIssueMutationPolicy(ctx, action, issueId);
}

async function assertAgentIssueMutationsAllowed(
  ctx: McpContext,
  issueIds: Iterable<string>,
  action: ExplicitMcpPolicyToolName,
): Promise<void> {
  await assertMcpIssueMutationsPolicy(ctx, action, issueIds);
}

const mcpIssueDtoSelect = Prisma.validator<Prisma.IssueSelect>()({
  id: true,
  number: true,
  title: true,
  description: true,
  priority: true,
  statusId: true,
  projectId: true,
  assignedAgentId: true,
  createdAt: true,
  updatedAt: true,
  dueDate: true,
  workspace: { select: { key: true, slug: true } },
  status: { select: { id: true, name: true, category: true, color: true } },
  project: { select: { id: true, key: true, name: true } },
  assignedAgent: { select: { id: true, name: true } },
  labels: {
    orderBy: { label: { name: "asc" } },
    select: { label: { select: { name: true } } },
  },
});

type McpIssueDtoRow = Prisma.IssueGetPayload<{ select: typeof mcpIssueDtoSelect }>;

type McpIssueSortField = "updatedAt" | "createdAt" | "priority" | "identifier" | "title";

type McpIssueDto = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  status: {
    id: string;
    name: string;
    category: StatusCategory;
    color: string;
  };
  priority: Priority;
  project: { id: string; key: string; name: string } | null;
  assignedAgent: { id: string; name: string } | null;
  labels: Array<{ name: string }>;
  createdAt: Date;
  updatedAt: Date;
  dueDate: Date | null;
  // Legacy scalar ids retained so existing MCP clients do not have to
  // migrate atomically while new clients can rely on the nested DTO above.
  number: number;
  statusId: string;
  projectId: string | null;
  assignedAgentId: string | null;
};

function mcpListEnvelope<T>(data: T[], nextCursor?: string): { data: T[]; nextCursor?: string } {
  return nextCursor ? { data, nextCursor } : { data };
}

function mcpIssueUrl(slug: string, identifier: string): string {
  return `/w/${slug}/i/${identifier}`;
}

function mcpIssueOrderBy(
  field: McpIssueSortField | undefined,
  order: Prisma.SortOrder,
): Prisma.IssueOrderByWithRelationInput[] {
  if (!field) return [{ priority: "desc" }, { createdAt: "desc" }, { id: "asc" }];
  if (field === "identifier") return [{ number: order }, { id: "asc" }];
  if (field === "priority") return [{ priority: order }, { createdAt: "desc" }, { id: "asc" }];
  return [{ [field]: order }, { id: "asc" }];
}

function toMcpIssueDto(issue: McpIssueDtoRow): McpIssueDto {
  const identifier = `${issue.workspace.key}-${issue.number}`;
  return {
    id: issue.id,
    identifier,
    title: issue.title,
    description: issue.description,
    url: mcpIssueUrl(issue.workspace.slug, identifier),
    status: issue.status,
    priority: issue.priority,
    project: issue.project,
    assignedAgent: issue.assignedAgent,
    labels: issue.labels.map((row) => ({ name: row.label.name })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    number: issue.number,
    statusId: issue.statusId,
    projectId: issue.projectId,
    assignedAgentId: issue.assignedAgentId,
  };
}

async function mcpIssueDtoById(id: string): Promise<McpIssueDto> {
  const issue = await db.issue.findUniqueOrThrow({
    where: { id },
    select: mcpIssueDtoSelect,
  });
  return toMcpIssueDto(issue);
}

/**
 * Resolve the acting user id. MCP keys often belong to a plugin (no userId);
 * fall back to any workspace member so rows that require an author /
 * assignee still have a valid FK target. Matches the existing `issues.create`
 * behavior so plugins don't need a linked user.
 */
async function resolveActorId(ctx: McpContext): Promise<string> {
  if (ctx.userId) return ctx.userId;
  const m = await db.membership.findFirstOrThrow({
    where: { workspaceId: ctx.workspaceId },
    select: { userId: true },
  });
  return m.userId;
}

type McpCommentAuthRow = {
  id: string;
  authorId: string | null;
  authoringAgentId: string | null;
};

async function isMcpWorkspaceAdmin(ctx: McpContext): Promise<boolean> {
  if (ctx.apiKey?.scopes.includes(PluginScope.ADMIN)) return true;
  if (!ctx.userId) return false;
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    select: { role: true },
  });
  return membership?.role === "OWNER" || membership?.role === "ADMIN";
}

async function assertMcpCommentWriteAllowed(
  ctx: McpContext,
  comment: McpCommentAuthRow,
): Promise<void> {
  const linkedAgentId = ctx.apiKey?.linkedAgentId ?? null;
  const isAgentAuthor = !!linkedAgentId && comment.authoringAgentId === linkedAgentId;
  const isHumanAuthor = !linkedAgentId && !!ctx.userId && comment.authorId === ctx.userId;
  if (isAgentAuthor || isHumanAuthor || (await isMcpWorkspaceAdmin(ctx))) return;
  throw new Error("Only the comment author or a workspace admin can modify this comment.");
}

async function assertMcpActiveIssue(ctx: McpContext, issueId: string): Promise<void> {
  const issue = await db.issue.findFirst({
    where: { id: issueId, workspaceId: ctx.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!issue) throw new Error("Issue not found or archived in this workspace.");
}

type McpCommentMutationRow = Prisma.CommentGetPayload<{
  include: {
    author: { select: { id: true; name: true; image: true } };
    authoringAgent: { select: { id: true; name: true; profileKey: true; avatar: true } };
  };
}>;

type WorkspaceSelectorInput = {
  workspaceId?: string;
  workspaceKey?: string;
  workspaceSlug?: string;
};

const workspaceSelectorShape = {
  workspaceId: z.string().cuid().optional(),
  workspaceKey: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[A-Z0-9]+$/)
    .optional(),
  workspaceSlug: z.string().min(1).max(80).optional(),
};

function assertSingleWorkspaceSelector(input: WorkspaceSelectorInput): void {
  const provided = [input.workspaceId, input.workspaceKey, input.workspaceSlug].filter(Boolean);
  if (provided.length > 1) {
    throw new Error("Provide only one of workspaceId, workspaceKey, or workspaceSlug.");
  }
}

async function resolveTargetWorkspace(
  ctx: McpContext,
  input: WorkspaceSelectorInput = {},
): Promise<{ id: string; key: string; slug: string; name: string }> {
  assertSingleWorkspaceSelector(input);
  const selector = input.workspaceId
    ? { id: input.workspaceId }
    : input.workspaceKey
      ? { key: input.workspaceKey }
      : input.workspaceSlug
        ? { slug: input.workspaceSlug }
        : { id: ctx.workspaceId };

  const workspace = await db.workspace.findFirst({
    where: { ...selector, deletedAt: null },
    select: { id: true, key: true, slug: true, name: true },
  });
  if (!workspace) throw new Error("Workspace not found.");
  if (workspace.id === ctx.workspaceId) return workspace;

  if (ctx.apiKey && !ctx.apiKey.scopes.includes(PluginScope.ADMIN)) {
    throw new Error("Selecting another workspace requires ADMIN scope.");
  }
  if (!ctx.userId) {
    throw new Error("Selecting another workspace requires a user-backed principal.");
  }
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: workspace.id } },
    select: { id: true },
  });
  if (!membership) throw new Error("Principal is not a member of the selected workspace.");
  return workspace;
}

type AccessNarrowingInput = {
  projectIds?: string[];
  labelIds?: string[];
  initiativeIds?: string[];
};

const accessNarrowingShape = {
  projectIds: z.array(z.string().cuid()).default([]),
  labelIds: z.array(z.string().cuid()).default([]),
  initiativeIds: z.array(z.string().cuid()).default([]),
};

async function assertMcpIdsInWorkspace(
  workspaceId: string,
  ids: AccessNarrowingInput,
): Promise<void> {
  const checks: Array<Promise<void>> = [];
  if (ids.projectIds?.length) {
    const unique = Array.from(new Set(ids.projectIds));
    checks.push(
      db.project.count({ where: { id: { in: unique }, workspaceId } }).then((count) => {
        if (count !== unique.length)
          throw new Error("One or more projectIds not in this workspace.");
      }),
    );
  }
  if (ids.labelIds?.length) {
    const unique = Array.from(new Set(ids.labelIds));
    checks.push(
      db.label.count({ where: { id: { in: unique }, workspaceId } }).then((count) => {
        if (count !== unique.length) throw new Error("One or more labelIds not in this workspace.");
      }),
    );
  }
  if (ids.initiativeIds?.length) {
    const unique = Array.from(new Set(ids.initiativeIds));
    checks.push(
      db.initiative.count({ where: { id: { in: unique }, workspaceId } }).then((count) => {
        if (count !== unique.length)
          throw new Error("One or more initiativeIds not in this workspace.");
      }),
    );
  }
  await Promise.all(checks);
}

function generateMcpApiKey(prefix = "forge_sk"): { raw: string; hashed: string; prefix: string } {
  const rawBytes = randomBytes(32).toString("base64url");
  const raw = `${prefix}_${rawBytes}`;
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed, prefix: raw.slice(0, prefix.length + 9) };
}

const allPluginScopes = Object.values(PluginScope);

// Promote helpers — duplicated lightly from `note.ts` so the MCP layer
// stays self-contained. Both fall back to a numeric suffix on collision
// rather than throwing.
function mcpGenerateProjectKey(title: string): string {
  const words = title
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "PRJ";
  let key =
    words.length === 1
      ? words[0].slice(0, 4)
      : words
          .slice(0, 4)
          .map((w) => w[0])
          .join("");
  key = key.replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (key.length < 2) key = (key + "PRJ").slice(0, 4);
  return key;
}

async function mcpEnsureUniqueProjectKey(
  tx: {
    project: {
      findFirst: (args: {
        where: { workspaceId: string; key: string };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  workspaceId: string,
  baseKey: string,
): Promise<string> {
  let candidate = baseKey;
  let suffix = 2;
  for (let i = 0; i < 100; i++) {
    const existing = await tx.project.findFirst({
      where: { workspaceId, key: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${baseKey.slice(0, 6)}${suffix}`;
    suffix += 1;
  }
  throw new Error("Could not generate a unique project key.");
}

function mcpSlugifyInitiative(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "initiative"
  );
}

async function mcpEnsureUniqueInitiativeSlug(
  tx: {
    initiative: {
      findUnique: (args: {
        where: { workspaceId_slug: { workspaceId: string; slug: string } };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  for (let i = 0; i < 100; i++) {
    const existing = await tx.initiative.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: candidate } },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${baseSlug.slice(0, 44)}-${suffix}`;
    suffix += 1;
  }
  throw new Error("Could not generate a unique initiative slug.");
}

/**
 * Stamp / clear `lockedAt` or `hiddenAt` on one of the five canvas layer
 * tables. Idempotent — reads the row and short-circuits if the requested
 * state is already in place. Workspace-scoped (will throw if the row
 * belongs to a different tenant).
 */
async function mcpSetLayerFlag(
  ctx: McpContext,
  col: "lockedAt" | "hiddenAt",
  kind: "node" | "shape" | "frame" | "group" | "instance",
  id: string,
  setBool: boolean,
): Promise<void> {
  const value = setBool ? new Date() : null;
  const data: Record<string, Date | null> = { [col]: value };
  let canvasId: string | null = null;
  if (kind === "node") {
    const row = await db.workspaceCanvasNode.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new Error("Canvas node not found.");
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await db.workspaceCanvasNode.update({ where: { id }, data });
  } else if (kind === "shape") {
    const row = await db.canvasShape.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new Error("Canvas shape not found.");
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await db.canvasShape.update({ where: { id }, data });
  } else if (kind === "frame") {
    const row = await db.canvasFrame.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new Error("Canvas frame not found.");
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await db.canvasFrame.update({ where: { id }, data });
  } else if (kind === "group") {
    const row = await db.canvasGroup.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new Error("Canvas group not found.");
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await db.canvasGroup.update({ where: { id }, data });
  } else if (kind === "instance") {
    const row = await db.canvasComponentInstance.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { id: true, canvasId: true, lockedAt: true, hiddenAt: true },
    });
    if (!row) throw new Error("Component instance not found.");
    canvasId = row.canvasId;
    if ((row[col] !== null) === setBool) return;
    await db.canvasComponentInstance.update({ where: { id }, data });
  }
  if (canvasId) {
    await db.workspaceCanvas.update({
      where: { id: canvasId },
      data: { updatedAt: new Date() },
    });
  }
}

async function assertMcpCanvasRef(
  ctx: McpContext,
  type: ForgeEntityType,
  id: string,
): Promise<void> {
  if (type === "issue") {
    await assertKeyScope(scopeCtx(ctx), { entity: "issue", id });
  } else if (type === "project") {
    await assertKeyScope(scopeCtx(ctx), { entity: "project", id });
  } else if (type === "initiative") {
    await assertKeyScope(scopeCtx(ctx), { entity: "initiative", id });
  }
  const [hydrated] = await hydrateEntityRefs({ db, workspaceId: ctx.workspaceId }, [{ type, id }]);
  if (!hydrated || hydrated.missing) {
    throw new Error(`${type} target not found in this workspace.`);
  }
}

const chatAttachmentSelect = {
  id: true,
  filename: true,
  mimeType: true,
  size: true,
  kind: true,
  externalUrl: true,
  targetType: true,
  targetId: true,
  createdAt: true,
} as const;

async function assertMcpChatMessageTarget(ctx: McpContext, messageId: string): Promise<void> {
  const message = await db.chatMessage.findFirst({
    where: { id: messageId, workspaceId: ctx.workspaceId },
    select: { id: true, thread: { select: { userId: true, agentId: true } } },
  });
  if (!message) throw new Error("chat-message target not found in this workspace.");
  const linkedAgentId = ctx.apiKey?.linkedAgentId ?? null;
  const userId = ctx.userId ?? null;
  if (userId === message.thread.userId) return;
  if (linkedAgentId && linkedAgentId === message.thread.agentId) return;
  throw new Error(
    "Only the chat thread owner or linked agent may access this chat-message attachment target.",
  );
}

async function loadChatAttachmentMap(workspaceId: string, messageIds: string[]) {
  const rows = messageIds.length
    ? await db.attachment.findMany({
        where: {
          workspaceId,
          targetType: "chat-message",
          targetId: { in: messageIds },
          NOT: { url: { startsWith: "pending:" } },
        },
        orderBy: { createdAt: "asc" },
        select: chatAttachmentSelect,
      })
    : [];
  const byMessage = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.targetId) continue;
    const bucket = byMessage.get(row.targetId) ?? [];
    bucket.push(row);
    byMessage.set(row.targetId, bucket);
  }
  return byMessage;
}

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const MS_PER_DAY = 86_400_000;

const daysBetween = (start: Date, end: Date): number =>
  Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));

async function assertNoOtherMcpActiveCycle(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  currentCycleId?: string,
): Promise<void> {
  const existing = await tx.cycle.findFirst({
    where: {
      workspaceId,
      status: CycleStatus.ACTIVE,
      ...(currentCycleId ? { id: { not: currentCycleId } } : {}),
    },
    select: { name: true },
  });
  if (existing) {
    throw new Error(
      `Sprint "${existing.name}" is already active. Complete it before starting another sprint.`,
    );
  }
}

const projectKey = z
  .string()
  .min(2)
  .max(8)
  .regex(/^[A-Z0-9]+$/);

/**
 * Compute the set of issue ids in a workspace blocked by at least one
 * non-completed dependency. Mirrors the router helper in `issue.ts` so the
 * MCP `issues.claim` path can exclude blocked candidates when an agent asks
 * "what should I work on next."
 */
async function findBlockedIssueIds(workspaceId: string): Promise<Set<string>> {
  // BLOCKS     : from = blocker, to = blocked.
  // BLOCKED_BY : from = blocked, to = blocker.
  // Blocked iff any blocker is still open (not DONE/CANCELED).
  const blockers = await db.issueRelation.findMany({
    where: {
      workspaceId,
      OR: [
        {
          kind: RelationKind.BLOCKS,
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: RelationKind.BLOCKED_BY,
          toIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
      ],
    },
    select: { fromIssueId: true, toIssueId: true, kind: true },
  });
  const ids = new Set<string>();
  for (const r of blockers) {
    if (r.kind === RelationKind.BLOCKS) ids.add(r.toIssueId);
    if (r.kind === RelationKind.BLOCKED_BY) ids.add(r.fromIssueId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Canvas templates + layout helpers (used by canvases.applyTemplate /
// canvases.layout). Kept in-file rather than importing from the client
// `canvas-templates.tsx` because that module is "use client" + pulls in
// Lucide icons. The shapes intentionally mirror the client copy.
// ---------------------------------------------------------------------------

type McpTemplateNode = {
  key: string;
  noteBody?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  lane?: string;
};
type McpTemplateEdge = { from: string; to: string; label?: string; kind?: string };
type McpCanvasTemplate = { nodes: McpTemplateNode[]; edges?: McpTemplateEdge[] };

const MCP_NOTE_W = 220;
const MCP_COL = 280;
const MCP_ROW = 200;

const MCP_CANVAS_TEMPLATES: Record<string, McpCanvasTemplate> = {
  empty: { nodes: [] },
  decision_matrix: {
    nodes: [
      { key: "axis-x", noteBody: "**Effort →**", x: 200, y: -80, width: 200, height: 60 },
      { key: "axis-y", noteBody: "**Impact ↑**", x: -200, y: 200, width: 200, height: 60 },
      {
        key: "q1",
        noteBody: "**High impact · Low effort**\nQuick wins",
        x: 60,
        y: 60,
        lane: "Top-right",
      },
      {
        key: "q2",
        noteBody: "**High impact · High effort**\nBig bets",
        x: 320,
        y: 60,
        lane: "Top-right",
      },
      {
        key: "q3",
        noteBody: "**Low impact · Low effort**\nFill-in",
        x: 60,
        y: 320,
        lane: "Bottom",
      },
      {
        key: "q4",
        noteBody: "**Low impact · High effort**\nAvoid",
        x: 320,
        y: 320,
        lane: "Bottom",
      },
    ],
  },
  architecture: {
    nodes: [
      {
        key: "system",
        noteBody: "**System**\nName + one-line purpose.",
        x: 120,
        y: -40,
        width: 320,
        lane: "System",
      },
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
  standup: {
    nodes: [
      {
        key: "y-h",
        noteBody: "**Yesterday**",
        x: 0,
        y: -60,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Yesterday",
      },
      { key: "y1", noteBody: "Wrapped: …", x: 0, y: 40, lane: "Yesterday" },
      { key: "y2", noteBody: "Shipped: …", x: 0, y: 40 + MCP_ROW, lane: "Yesterday" },
      {
        key: "t-h",
        noteBody: "**Today**",
        x: MCP_COL,
        y: -60,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Today",
      },
      { key: "t1", noteBody: "Focus: …", x: MCP_COL, y: 40, lane: "Today" },
      { key: "t2", noteBody: "Stretch: …", x: MCP_COL, y: 40 + MCP_ROW, lane: "Today" },
      {
        key: "b-h",
        noteBody: "**Blockers**",
        x: MCP_COL * 2,
        y: -60,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Blockers",
      },
      { key: "b1", noteBody: "Waiting on: …", x: MCP_COL * 2, y: 40, lane: "Blockers" },
    ],
  },
  retro: {
    nodes: [
      {
        key: "ww-h",
        noteBody: "**Went well**",
        x: 0,
        y: -60,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Went well",
      },
      { key: "ww1", noteBody: "Win: …", x: 0, y: 40, lane: "Went well" },
      {
        key: "dd-h",
        noteBody: "**Didn't go well**",
        x: MCP_COL,
        y: -60,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Didn't",
      },
      { key: "dd1", noteBody: "Friction: …", x: MCP_COL, y: 40, lane: "Didn't" },
      {
        key: "cb-h",
        noteBody: "**Confused by**",
        x: 0,
        y: 40 + MCP_ROW,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Confused by",
      },
      { key: "cb1", noteBody: "Unclear: …", x: 0, y: 40 + MCP_ROW + 100, lane: "Confused by" },
      {
        key: "ai-h",
        noteBody: "**Action items**",
        x: MCP_COL,
        y: 40 + MCP_ROW,
        width: MCP_NOTE_W,
        height: 50,
        lane: "Action items",
      },
      {
        key: "ai1",
        noteBody: "[ ] Owner — task",
        x: MCP_COL,
        y: 40 + MCP_ROW + 100,
        lane: "Action items",
      },
    ],
  },
  okr_tree: {
    nodes: [
      {
        key: "obj",
        noteBody: "**Objective**\nThe outcome we want.",
        x: 200,
        y: -40,
        width: 320,
        lane: "Objective",
      },
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
};

interface McpLayoutNode {
  id: string;
  x: number;
  y: number;
  targetType: string;
  targetId: string;
}
interface McpLayoutEdge {
  fromNodeId: string;
  toNodeId: string;
}
type McpLayoutPositions = Map<string, { x: number; y: number }>;

const MCP_LAYOUT_LAYER_X = 280;
const MCP_LAYOUT_ROW_Y = 160;
const MCP_LAYOUT_GRID_X = 240;
const MCP_LAYOUT_GRID_Y = 180;
const MCP_LAYOUT_FORCE_BOX = 4000;

function mcpTopologicalLayout(nodes: McpLayoutNode[], edges: McpLayoutEdge[]): McpLayoutPositions {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    inDeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!adj.has(e.fromNodeId) || !adj.has(e.toNodeId)) continue;
    adj.get(e.fromNodeId)!.push(e.toNodeId);
    inDeg.set(e.toNodeId, (inDeg.get(e.toNodeId) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      const nextD = depth.get(next);
      if (nextD === undefined || d + 1 > nextD) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const list = byLayer.get(d) ?? [];
    list.push(n.id);
    byLayer.set(d, list);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  for (const list of byLayer.values()) {
    list.sort((a, b) => {
      const A = nodeById.get(a)!;
      const B = nodeById.get(b)!;
      if (A.y !== B.y) return A.y - B.y;
      return a.localeCompare(b);
    });
  }
  const positions: McpLayoutPositions = new Map();
  for (const [d, list] of byLayer.entries()) {
    list.forEach((id, idx) => {
      positions.set(id, { x: d * MCP_LAYOUT_LAYER_X, y: idx * MCP_LAYOUT_ROW_Y });
    });
  }
  return positions;
}

function mcpGridLayout(nodes: McpLayoutNode[]): McpLayoutPositions {
  const sorted = [...nodes].sort((a, b) => {
    if (a.targetType !== b.targetType) return a.targetType.localeCompare(b.targetType);
    return a.targetId.localeCompare(b.targetId);
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const positions: McpLayoutPositions = new Map();
  sorted.forEach((n, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    positions.set(n.id, { x: col * MCP_LAYOUT_GRID_X, y: row * MCP_LAYOUT_GRID_Y });
  });
  return positions;
}

function mcpForceLayout(nodes: McpLayoutNode[], edges: McpLayoutEdge[]): McpLayoutPositions {
  const ITER = 50;
  const EDGE_LEN = 240;
  const W = MCP_LAYOUT_FORCE_BOX;
  const H = MCP_LAYOUT_FORCE_BOX;
  const k = Math.sqrt((W * H) / Math.max(1, nodes.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });
  const cooled = (t: number) => Math.max(0.1, 1 - t / ITER) * (W / 10);
  for (let iter = 0; iter < ITER; iter++) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const n of nodes) disp.set(n.id, { x: 0, y: 0 });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const dist = Math.max(0.01, Math.hypot(dx, dy));
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const da = disp.get(a.id)!;
        const db = disp.get(b.id)!;
        da.x += fx;
        da.y += fy;
        db.x -= fx;
        db.y -= fy;
      }
    }
    for (const e of edges) {
      const pa = pos.get(e.fromNodeId);
      const pb = pos.get(e.toNodeId);
      if (!pa || !pb) continue;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const force = (dist * dist) / EDGE_LEN;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const da = disp.get(e.fromNodeId)!;
      const db = disp.get(e.toNodeId)!;
      da.x -= fx;
      da.y -= fy;
      db.x += fx;
      db.y += fy;
    }
    const temp = cooled(iter);
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      const d = disp.get(n.id)!;
      const mag = Math.max(0.01, Math.hypot(d.x, d.y));
      p.x += (d.x / mag) * Math.min(mag, temp);
      p.y += (d.y / mag) * Math.min(mag, temp);
      p.x = Math.min(W / 2, Math.max(-W / 2, p.x));
      p.y = Math.min(H / 2, Math.max(-H / 2, p.y));
    }
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const mcpTools = {
  // --------------------------------------------------------------------- Issues
  "issues.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      query: z
        .string()
        .max(200)
        .optional()
        .describe("Fulltext search on title + description (case-insensitive)"),
      // Singleton filters
      projectId: z.string().cuid().optional(),
      statusId: z.string().cuid().optional(),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
      cycleId: z
        .string()
        .cuid()
        .nullable()
        .optional()
        .describe("CUID to pin, null for backlog (no cycle)"),
      initiativeId: z
        .string()
        .cuid()
        .nullable()
        .optional()
        .describe("CUID to pin, null for issues whose project has no initiative or no project"),
      assigneeId: z.string().cuid().optional(),
      assignedAgentId: z
        .string()
        .cuid()
        .nullable()
        .optional()
        .describe("Agent CUID to pin, null for issues with no agent assigned"),
      // Array filters (any-of). AND'd with singleton equivalents above.
      projectIds: z.array(z.string().cuid()).max(100).optional(),
      withoutProject: z.boolean().optional(),
      labelIds: z.array(z.string().cuid()).max(100).optional(),
      statusCategories: z.array(z.nativeEnum(StatusCategory)).max(8).optional(),
      priorities: z
        .array(z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]))
        .max(8)
        .optional(),
      cycleIds: z.array(z.string().cuid()).max(100).optional(),
      initiativeIds: z.array(z.string().cuid()).max(100).optional(),
      // Boolean predicates — convenience selectors. Compose under AND with
      // explicit ids above. Mirrors the tRPC `filterSchema` semantics so
      // agents calling the MCP can express the same shapes the web app uses.
      unassigned: z.boolean().optional().describe("No human assignees AND no agent assigned."),
      withoutCycle: z.boolean().optional(),
      withoutInitiative: z.boolean().optional(),
      createdByViewer: z
        .boolean()
        .default(false)
        .describe("Only issues authored by the authenticated principal."),
      includeDone: z.boolean().default(false).describe("Include DONE issues"),
      orderBy: z.enum(["updatedAt", "createdAt", "priority", "identifier", "title"]).optional(),
      order: z.enum(["asc", "desc"]).default("desc"),
      cursor: z.string().cuid().optional().describe("Issue id cursor from the prior page."),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async run(
      input: {
        query?: string;
        projectId?: string;
        statusId?: string;
        priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
        cycleId?: string | null;
        initiativeId?: string | null;
        assigneeId?: string;
        assignedAgentId?: string | null;
        projectIds?: string[];
        withoutProject?: boolean;
        labelIds?: string[];
        statusCategories?: StatusCategory[];
        priorities?: ("NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT")[];
        cycleIds?: string[];
        initiativeIds?: string[];
        unassigned?: boolean;
        withoutCycle?: boolean;
        withoutInitiative?: boolean;
        createdByViewer: boolean;
        includeDone: boolean;
        orderBy?: McpIssueSortField;
        order: "asc" | "desc";
        cursor?: string;
        limit: number;
      },
      ctx: McpContext,
    ) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const createdByViewerId = input.createdByViewer ? await resolveActorId(ctx) : null;

      // Mirrors the tRPC `issue.list` where-construction (issue.ts:294-428).
      // Kept inline rather than DRY'd because the tRPC procedure consumes
      // the full session context (cursor, blocked-set helper bound to
      // `ctx.db`) and the MCP path only needs the simpler subset. Future
      // refactor: extract a shared `buildIssueListWhere(filter, scope)`.
      const andClauses: Array<Record<string, unknown>> = [];

      if (input.initiativeId === null || input.withoutInitiative === true) {
        andClauses.push({
          OR: [{ projectId: null }, { project: { initiativeId: null } }],
        });
      }
      if (input.query) {
        andClauses.push({
          OR: [
            { title: { contains: input.query, mode: "insensitive" as const } },
            { description: { contains: input.query, mode: "insensitive" as const } },
          ],
        });
      }
      if (input.unassigned === true) {
        andClauses.push({
          AND: [{ assignees: { none: {} } }, { assignedAgentId: null }],
        });
      }
      if (input.projectIds?.length || input.withoutProject === true) {
        const ors: Array<Record<string, unknown>> = [];
        if (input.projectIds?.length) ors.push({ projectId: { in: input.projectIds } });
        if (input.withoutProject === true) ors.push({ projectId: null });
        andClauses.push({ OR: ors });
      }
      if (input.statusCategories?.length) {
        andClauses.push({
          status: { category: { in: input.statusCategories } },
        });
      }
      if (input.cycleIds?.length || input.withoutCycle === true) {
        const ors: Array<Record<string, unknown>> = [];
        if (input.cycleIds?.length) ors.push({ cycleId: { in: input.cycleIds } });
        if (input.withoutCycle === true) ors.push({ cycleId: null });
        andClauses.push({ OR: ors });
      }
      if (input.initiativeIds?.length) {
        andClauses.push({
          project: { initiativeId: { in: input.initiativeIds } },
        });
      }

      const explicitTerminalStatusFilter =
        hasTerminalStatusCategory(input.statusCategories) ||
        (input.statusId
          ? (await db.status.count({
              where: {
                workspaceId: ctx.workspaceId,
                id: input.statusId,
                category: { in: [...TERMINAL_STATUS_CATEGORIES] },
              },
            })) > 0
          : false);
      const includeTerminalStatuses = input.includeDone || explicitTerminalStatusFilter;

      const rows = await db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.statusId ? { statusId: input.statusId } : {}),
          ...(input.assigneeId ? { assignees: { some: { userId: input.assigneeId } } } : {}),
          ...(input.labelIds?.length
            ? { labels: { some: { labelId: { in: input.labelIds } } } }
            : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.priorities?.length ? { priority: { in: input.priorities } } : {}),
          ...(input.cycleId === null
            ? { cycleId: null }
            : input.cycleId
              ? { cycleId: input.cycleId }
              : {}),
          ...(typeof input.initiativeId === "string"
            ? { project: { initiativeId: input.initiativeId } }
            : {}),
          ...(input.createdByViewer ? { authorId: createdByViewerId! } : {}),
          ...(input.assignedAgentId === null
            ? { assignedAgentId: null }
            : input.assignedAgentId
              ? { assignedAgentId: input.assignedAgentId }
              : {}),
          ...(includeTerminalStatuses
            ? {}
            : { status: { category: { notIn: [...TERMINAL_STATUS_CATEGORIES] } } }),
          ...(andClauses.length ? { AND: andClauses } : {}),
        },
        take: input.limit + 1,
        skip: input.cursor ? 1 : 0,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: mcpIssueOrderBy(input.orderBy, input.order),
        select: mcpIssueDtoSelect,
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) {
        rows.pop();
        nextCursor = rows.at(-1)?.id;
      }
      return mcpListEnvelope(rows.map(toMcpIssueDto), nextCursor);
    },
  },

  "issues.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Issue id (cuid)"),
      include: z
        .object({
          description: z
            .boolean()
            .optional()
            .describe("Include the full Issue.description body (already on the row)."),
          comments: z
            .union([
              z.boolean(),
              z.object({
                limit: z.number().int().min(1).max(100).default(20),
              }),
            ])
            .optional()
            .describe(
              "Include recent BODY/STATUS comments. Pass true for default (limit 20) or { limit }.",
            ),
          attachments: z
            .boolean()
            .optional()
            .describe("Include all finalized attachments on the issue."),
          relations: z
            .boolean()
            .optional()
            .describe("Include outbound IssueRelation rows (matches relations.listForIssue)."),
          currentRun: z
            .boolean()
            .optional()
            .describe("Include the most recent non-terminal AgentRun for this issue."),
          labels: z.boolean().optional().describe("Include labels via the IssueLabel join."),
        })
        .optional()
        .describe(
          "Optional hydration. Default behavior (no include) returns the legacy lean shape: status + project + assignees only.",
        ),
    }),
    async run(
      input: {
        id: string;
        include?: {
          description?: boolean;
          comments?: boolean | { limit: number };
          attachments?: boolean;
          relations?: boolean;
          currentRun?: boolean;
          labels?: boolean;
        };
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });

      // Default (legacy) shape: status + project + assignees only.
      const include = input.include;
      if (!include) {
        return db.issue.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
          include: {
            status: true,
            project: true,
            assignees: { include: { user: true } },
          },
        });
      }

      // Hydrated shape — base row always carries the legacy fields, then
      // we attach optional sections so callers get a single round-trip.
      const issue = await db.issue.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        include: {
          status: true,
          project: true,
          assignees: { include: { user: true } },
          ...(include.labels ? { labels: { include: { label: true } } } : {}),
          ...(include.attachments
            ? {
                attachments: {
                  where: { NOT: { url: { startsWith: "pending:" } } },
                },
              }
            : {}),
        },
      });
      if (!issue) return null;

      const out: Record<string, unknown> = { ...issue };
      // description column is already on the row; the boolean is purely a
      // hint that callers care about it (no extra query).
      if (include.description) {
        out.description = issue.description;
      }

      if (include.comments) {
        const limit = typeof include.comments === "object" ? include.comments.limit : 20;
        const comments = await db.comment.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            issueId: input.id,
            deletedAt: null,
          },
          orderBy: { updatedAt: "desc" },
          take: limit,
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, profileKey: true, name: true },
            },
            run: { select: { id: true, status: true, finishedAt: true } },
          },
        });
        out.comments = sortCommentsChronologically(comments);
      }

      if (include.relations) {
        out.relations = await db.issueRelation.findMany({
          where: { workspaceId: ctx.workspaceId, fromIssueId: input.id },
          include: {
            toIssue: {
              select: {
                id: true,
                number: true,
                title: true,
                statusId: true,
                status: { select: { category: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });
      }

      if (include.currentRun) {
        out.currentRun = await db.agentRun.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            issueId: input.id,
            status: { in: ["ACTIVE", "WAITING"] },
            ...(ctx.apiKey?.linkedAgentId ? { agentId: ctx.apiKey.linkedAgentId } : {}),
          },
          orderBy: { startedAt: "desc" },
        });
      }

      return out;
    },
  },

  "issues.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(50_000).optional(),
      projectId: z.string().optional(),
      statusId: z.string().cuid().optional(),
      labelIds: z.array(z.string().cuid()).max(100).optional(),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    }),
    async run(
      input: {
        title: string;
        description?: string;
        projectId?: string;
        statusId?: string;
        labelIds?: string[];
        priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      },
      ctx: McpContext,
    ) {
      await assertMcpWorkspaceMutationPolicy(ctx, "issues.create");
      if (input.projectId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.projectId,
        });
      }
      const key = ctx.apiKey;
      if (
        key &&
        (key.projectIds.length > 0 || key.labelIds.length > 0 || key.initiativeIds.length > 0)
      ) {
        const projectScopeMatch = input.projectId
          ? key.projectIds.includes(input.projectId)
          : false;
        const labelScopeMatch = (input.labelIds ?? []).some((id) => key.labelIds.includes(id));
        const initiativeScopeMatch =
          input.projectId && key.initiativeIds.length > 0
            ? Boolean(
                await db.project.findFirst({
                  where: {
                    id: input.projectId,
                    workspaceId: ctx.workspaceId,
                    initiativeId: { in: key.initiativeIds },
                  },
                  select: { id: true },
                }),
              )
            : false;
        if (!projectScopeMatch && !labelScopeMatch && !initiativeScopeMatch) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "API key scope does not include the new issue's project or labels.",
          });
        }
      }
      const authorId = await resolveActorId(ctx);
      const issue = await createIssueWithSideEffects({
        db,
        workspaceId: ctx.workspaceId,
        actorId: authorId,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        input: {
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          statusId: input.statusId,
          labelIds: input.labelIds,
          priority: (input.priority ?? Priority.NONE) as Priority,
        },
      });
      return mcpIssueDtoById(issue.id);
    },
  },

  /**
   * Generic field-patch update for an issue. Intentionally narrow:
   * `statusId` belongs on `issues.transition` (which also touches the
   * agent-run timeline) and `assignedAgentId` belongs on
   * `issues.assign` / `reassign` / `release` (which stamp
   * `dispatchReason` and emit `AGENT_ASSIGNED`). Everything else —
   * title, description, priority, project, cycle, parent, dueDate,
   * estimate — lives here. Mirrors the audit + event semantics of the
   * tRPC `issue.update` proc (issue.ts:703-) so subscribers can't tell
   * the two paths apart.
   */
  "issues.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Issue id (cuid)"),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(50_000).nullable().optional(),
      priority: z.enum(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
      projectId: z
        .string()
        .cuid()
        .nullable()
        .optional()
        .describe("Pass null to remove from project."),
      cycleId: z.string().cuid().nullable().optional().describe("Pass null to remove from cycle."),
      parentId: z
        .string()
        .cuid()
        .nullable()
        .optional()
        .describe("Pass null to clear the parent (un-nest)."),
      dueDate: z.coerce.date().nullable().optional(),
      estimate: z.number().min(0).nullable().optional(),
      /** Wave 5: completion contract — see runs.complete docstring. */
      expectedOutput: z.string().max(50_000).nullable().optional(),
      verificationChecklist: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            label: z.string().min(1).max(500),
            kind: z.enum(["manual", "command", "artifact"]).optional(),
            value: z.string().max(2_000).optional(),
            done: z.boolean().optional(),
          }),
        )
        .max(50)
        .nullable()
        .optional(),
      artifactRequired: z.boolean().optional(),
    }),
    async run(
      input: {
        id: string;
        title?: string;
        description?: string | null;
        priority?: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";
        projectId?: string | null;
        cycleId?: string | null;
        parentId?: string | null;
        dueDate?: Date | null;
        estimate?: number | null;
        expectedOutput?: string | null;
        verificationChecklist?: Array<{
          id?: string;
          label: string;
          kind?: "manual" | "command" | "artifact";
          value?: string;
          done?: boolean;
        }> | null;
        artifactRequired?: boolean;
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      await assertAgentIssueMutationAllowed(ctx, input.id, "issues.update");
      const actorId = await resolveActorId(ctx);
      const { id, ...patch } = input;

      const updatedId = await db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
        });

        // Cross-tenant guards on referenced ids. Skip the `null` branch
        // (caller is clearing the field — no FK to validate).
        if (typeof patch.projectId === "string") {
          await assertKeyScope(scopeCtx(ctx), { entity: "project", id: patch.projectId });
          const proj = await tx.project.findFirst({
            where: { id: patch.projectId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!proj) throw new Error("Project not found in this workspace.");
        }
        if (typeof patch.cycleId === "string") {
          const cyc = await tx.cycle.findFirst({
            where: { id: patch.cycleId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!cyc) throw new Error("Cycle not found in this workspace.");
        }
        if (typeof patch.parentId === "string") {
          if (patch.parentId === id) {
            throw new Error("Issue cannot be its own parent.");
          }
          const parent = await tx.issue.findFirst({
            where: { id: patch.parentId, workspaceId: ctx.workspaceId, deletedAt: null },
            select: { id: true },
          });
          if (!parent) throw new Error("Parent issue not found in this workspace.");
        }

        const { verificationChecklist, ...patchRest } = patch;
        const checklistData =
          verificationChecklist === undefined
            ? {}
            : verificationChecklist === null
              ? { verificationChecklist: Prisma.JsonNull }
              : { verificationChecklist: verificationChecklist as Prisma.InputJsonValue };
        const updateRes = await tx.issue.updateMany({
          where: { id, workspaceId: ctx.workspaceId },
          data: { ...patchRest, ...checklistData },
        });
        if (updateRes.count === 0) {
          throw new Error("Issue not found in this workspace.");
        }
        const after = await tx.issue.findUniqueOrThrow({
          where: { id },
          include: { status: true, project: true },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: id,
          action: "update",
          before,
          after,
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "issue",
          subjectId: id,
          payload: patch,
        });

        // Priority changes get a dedicated event so the dispatch
        // escalation path (HIGH/URGENT) can route precisely without
        // walking the generic ISSUE_UPDATED payload. Matches issue.ts:818-836.
        if (patch.priority && patch.priority !== before.priority) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: id,
            action: "change-priority",
            before: { priority: before.priority },
            after: { priority: patch.priority },
            eventKind: EventKind.ISSUE_PRIORITY_CHANGED,
            subjectType: "issue",
            subjectId: id,
            payload: { from: before.priority, to: patch.priority },
          });
        }

        return after.id;
      });
      return mcpIssueDtoById(updatedId);
    },
  },

  /**
   * Bulk status transition — wraps the tRPC `issue.bulkTransition`
   * semantics so a grooming agent can move many issues into Done /
   * Canceled in one call. Honors lifecycle timestamps (`startedAt`,
   * `completedAt`, `canceledAt`) and emits ISSUE_STATUS_CHANGED per
   * row so downstream subscribers behave identically to single
   * transitions.
   */
  "issues.bulkTransition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      ids: z.array(z.string().cuid()).min(1).max(200),
      statusId: z.string().cuid(),
    }),
    async run(input: { ids: string[]; statusId: string }, ctx: McpContext) {
      // Per-id scope check so a narrowed key can't transition issues
      // outside its lane in bulk.
      for (const id of input.ids) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id });
      }
      await assertAgentIssueMutationsAllowed(ctx, input.ids, "issues.bulkTransition");
      const actorId = await resolveActorId(ctx);

      const status = await db.status.findFirst({
        where: { id: input.statusId, workspaceId: ctx.workspaceId },
      });
      if (!status) throw new Error("Status not found in this workspace.");

      const rows = await db.issue.findMany({
        where: {
          id: { in: input.ids },
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        include: { status: true },
      });

      let changed = 0;
      for (const before of rows) {
        if (before.statusId === status.id) continue;
        const extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
        if (status.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
        if (status.category === "DONE") extra.completedAt = new Date();
        if (status.category === "CANCELED") extra.canceledAt = new Date();
        if (status.category !== "DONE") extra.completedAt = null;
        if (status.category !== "CANCELED") extra.canceledAt = null;

        await db.$transaction(async (tx) => {
          const after = await tx.issue.update({
            where: { id: before.id },
            data: { statusId: status.id, ...extra },
            include: { status: true },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: before.id,
            action: "update",
            before,
            after,
            eventKind: EventKind.ISSUE_STATUS_CHANGED,
            subjectType: "issue",
            subjectId: before.id,
            payload: { statusId: status.id, from: before.statusId },
          });
        });
        changed += 1;
      }
      return { count: changed, statusId: status.id };
    },
  },

  "issues.transition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Issue id (cuid)"),
      statusId: z.string().describe("Target status id"),
    }),
    async run(input: { id: string; statusId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      await assertAgentIssueMutationAllowed(ctx, input.id, "issues.transition");
      const actorId = await resolveActorId(ctx);
      const agentId = ctx.apiKey?.linkedAgentId ?? null;

      // Validate both rows live in this workspace before opening a tx, so
      // we can fail fast with a meaningful message.
      const [before, status] = await Promise.all([
        db.issue.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
          include: { status: true },
        }),
        db.status.findFirst({
          where: { id: input.statusId, workspaceId: ctx.workspaceId },
        }),
      ]);
      if (!before) throw new Error("Issue not found in this workspace.");
      if (!status) throw new Error("Status not found in this workspace.");

      // No-op path: caller asked for the status the issue already has.
      // Return the DTO without writing audit / touching the run so we don't
      // emit a phantom ISSUE_STATUS_CHANGED. Matches the tRPC `issue.update`
      // semantics where `patch.statusId === before.statusId` skips the
      // status-change branch.
      if (before.statusId === status.id) return mcpIssueDtoById(before.id);

      // Lifecycle timestamps based on the target category — mirrors
      // issue.ts:765-778 and the bulkTransition path below.
      const extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
      if (status.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
      if (status.category === "DONE") extra.completedAt = new Date();
      if (status.category === "CANCELED") extra.canceledAt = new Date();
      if (status.category !== "DONE") extra.completedAt = null;
      if (status.category !== "CANCELED") extra.canceledAt = null;

      const updatedId = await db.$transaction(async (tx) => {
        const after = await tx.issue.update({
          where: { id: before.id },
          data: { statusId: status.id, ...extra },
          include: { status: true },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId: agentId,
          entity: "Issue",
          entityId: before.id,
          action: "update",
          before,
          after,
          eventKind: EventKind.ISSUE_STATUS_CHANGED,
          subjectType: "issue",
          subjectId: before.id,
          payload: { statusId: status.id, from: before.statusId },
        });

        // Terminal status: close any ACTIVE runs (matches issue.ts:898-904).
        // Otherwise touch/open the calling agent's run so the live pulse
        // strip + watchdog see the transition.
        if (status.category === "DONE" || status.category === "CANCELED") {
          await finishRunsForIssue(tx, {
            workspaceId: ctx.workspaceId,
            issueId: before.id,
            status: status.category === "DONE" ? "COMPLETED" : "ABANDONED",
            actorId,
            actorAgentId: agentId,
          });
        } else if (agentId) {
          const { run, isNew } = await openOrTouchRun(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.id,
            agentId,
            actorId,
            actorAgentId: agentId,
            currentStep: `→ ${status.name}`,
          });
          if (!isNew) {
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: ctx.workspaceId,
              issueId: input.id,
              agentId,
              kind: "TRANSITION",
              payload: { statusId: status.id, category: status.category },
            });
          }
        }

        return after.id;
      });
      return mcpIssueDtoById(updatedId);
    },
  },

  "issues.claim": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z
        .string()
        .optional()
        .describe("Specific issue to claim; omit to auto-pick the next unblocked"),
      claimTtlMinutes: z.number().int().min(1).max(1440).default(60),
    }),
    async run(input: { issueId?: string; claimTtlMinutes: number }, ctx: McpContext) {
      if (input.issueId) {
        await assertAgentIssueMutationAllowed(ctx, input.issueId, "issues.claim");
      } else {
        await assertMcpWorkspaceMutationPolicy(ctx, "issues.claim");
      }
      const agentUserId = await resolveActorId(ctx);
      // Attribute the claim to the agent behind the key (not just its owner
      // user) so the UI can show the agent. Null if the key isn't agent-linked.
      const claimedByAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const expiresAt = new Date(Date.now() + input.claimTtlMinutes * 60_000);

      if (input.issueId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
        const issue = await db.issue.findFirstOrThrow({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
        });
        if (issue.claimedAt && issue.claimedById !== agentUserId) {
          return { claimed: null, reason: "already-claimed" as const };
        }
        const updated = await db.issue.update({
          where: { id: issue.id },
          data: {
            claimedById: agentUserId,
            claimedByAgentId,
            claimedAt: new Date(),
            claimExpiresAt: expiresAt,
            assignees: {
              upsert: {
                where: {
                  issueId_userId: { issueId: issue.id, userId: agentUserId },
                },
                create: { userId: agentUserId },
                update: {},
              },
            },
          },
          include: { status: true, project: true },
        });
        return { claimed: updated };
      }

      // "Give me something to work on" — skip blocked issues + narrowing.
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const blockedIds = await findBlockedIssueIds(ctx.workspaceId);
      const candidate = await db.issue.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          claimedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...keyWhere,
          ...(blockedIds.size ? { id: { notIn: [...blockedIds] } } : {}),
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      if (!candidate) return { claimed: null };
      const updated = await db.issue.update({
        where: { id: candidate.id },
        data: {
          claimedById: agentUserId,
          claimedByAgentId,
          claimedAt: new Date(),
          claimExpiresAt: expiresAt,
          assignees: {
            upsert: {
              where: {
                issueId_userId: { issueId: candidate.id, userId: agentUserId },
              },
              create: { userId: agentUserId },
              update: {},
            },
          },
        },
        include: { status: true, project: true },
      });
      return { claimed: updated };
    },
  },

  "issues.release": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().describe("Issue id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertAgentIssueMutationAllowed(ctx, input.id, "issues.release");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      const issue = await db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.issue.update({
        where: { id: issue.id },
        data: { claimedAt: null, claimedById: null, claimedByAgentId: null, claimExpiresAt: null },
      });
    },
  },

  "issues.setQueued": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Issue id (cuid)"),
      queued: z.boolean().describe("Whether the issue should be in the agent queue"),
    }),
    async run(input: { id: string; queued: boolean }, ctx: McpContext) {
      await assertAgentIssueMutationAllowed(ctx, input.id, "issues.setQueued");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.id });
      const actorId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        });
        const updated = await tx.issue.update({
          where: { id: issue.id },
          data: {
            queued: input.queued,
            // Mirrors issue.setQueued: unqueue does not steal/release an active claim.
            ...(!input.queued && issue.claimedAt == null
              ? { claimedAt: null, claimedById: null, claimedByAgentId: null, claimExpiresAt: null }
              : {}),
          },
        });

        // Emit ISSUE_QUEUED only on off -> on, matching the app mutation and
        // avoiding repeated webhook spam from idempotent queue calls.
        if (input.queued && !issue.queued) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "queue",
            before: { queued: issue.queued },
            after: { queued: true },
            eventKind: EventKind.ISSUE_QUEUED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              number: issue.number,
              assignedAgentId: issue.assignedAgentId,
            },
          });
        }

        await maybeAutoDispatch(tx, issue.id);
        return updated;
      });
    },
  },

  "issues.queue": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      includeClaimed: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    async run(input: { includeClaimed: boolean; limit: number }, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      return db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...keyWhere,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        take: input.limit,
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        include: { status: true, project: true },
      });
    },
  },

  /**
   * Assign (or unassign) an agent to an issue. Agents are identified by id
   * or by `profileKey` (stable cross-system handle). Pass `agentId: null`
   * to clear the current assignment. Emits AGENT_ASSIGNED on assignment
   * transitions and on same-agent explicit mode updates.
   */
  "issues.assign": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z
      .object({
        issueId: z.string().describe("Issue id (cuid)"),
        agentId: z
          .string()
          .nullable()
          .optional()
          .describe("Agent id (cuid). Pass null to unassign. Optional if profileKey given."),
        profileKey: z.string().optional().describe("Resolve agent by profileKey instead of id."),
        mode: z
          .enum(["EXECUTE", "RESEARCH", "REVIEW", "DISCUSS"])
          .optional()
          .describe(
            "Engagement mode (work intent). EXECUTE=do it to completion; RESEARCH=investigate+report; REVIEW=critique; DISCUSS=weigh in. Defaults to the workspace assignment default (usually EXECUTE).",
          ),
      })
      .refine((v) => v.agentId !== undefined || v.profileKey !== undefined, {
        message: "Provide agentId (or null) or profileKey.",
      }),
    async run(
      input: {
        issueId: string;
        agentId?: string | null;
        profileKey?: string;
        mode?: "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      await assertAgentIssueMutationAllowed(ctx, input.issueId, "issues.assign");

      // Resolve target agent id:
      //   agentId === null           → unassign
      //   agentId === string         → direct
      //   profileKey === string      → lookup in this workspace
      let targetAgentId: string | null = null;
      if (input.agentId === null) {
        targetAgentId = null;
      } else if (typeof input.agentId === "string") {
        targetAgentId = input.agentId;
      } else if (input.profileKey) {
        const agent = await db.agent.findUnique({
          where: {
            workspaceId_profileKey: {
              workspaceId: ctx.workspaceId,
              profileKey: input.profileKey,
            },
          },
          select: { id: true },
        });
        if (!agent) throw new Error("Agent not found in this workspace.");
        targetAgentId = agent.id;
      }

      const updatedId = await db.$transaction(async (tx) => {
        const before = await tx.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, assignedAgentId: true },
        });
        if (!before) throw new Error("Issue not found in this workspace.");

        let targetAgent: { id: string; engagementMode: EngagementMode | null } | null = null;
        if (targetAgentId) {
          const agent = await tx.agent.findFirst({
            where: { id: targetAgentId, workspaceId: ctx.workspaceId },
            select: { id: true, engagementMode: true },
          });
          if (!agent) throw new Error("Agent not found in this workspace.");
          targetAgent = agent;
        }

        const updated = await tx.issue.update({
          where: { id: before.id },
          data: { assignedAgentId: targetAgentId },
          include: {
            status: true,
            assignedAgent: {
              select: {
                id: true,
                name: true,
                profileKey: true,
                avatar: true,
                status: true,
              },
            },
          },
        });

        const assignmentChanged = (before.assignedAgentId ?? null) !== (targetAgentId ?? null);
        const explicitModeProvided = input.mode !== undefined;
        if (!assignmentChanged && targetAgentId && explicitModeProvided) {
          const activeRun = await tx.agentRun.findFirst({
            where: {
              workspaceId: ctx.workspaceId,
              issueId: before.id,
              agentId: targetAgentId,
              status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
            },
            select: { id: true },
          });
          if (activeRun) {
            throw new Error(
              "Stop or complete the current run before changing this agent's engagement mode.",
            );
          }
        }
        if (assignmentChanged || (!!targetAgentId && explicitModeProvided)) {
          // Resolve the engagement mode for this assignment (AXI-53). Only set
          // on assign (not unassign). Precedence: explicit override > agent
          // binding override > workspace default. Stamped on the payload so
          // the auto-transition gate + the opened run pick it up.
          let engagementMode: string | undefined;
          let engagementSource: string | undefined;
          if (targetAgentId && targetAgent) {
            const { resolveEngagementMode } = await import("@/server/services/engagement-mode");
            const ws = await tx.workspace.findUniqueOrThrow({
              where: { id: ctx.workspaceId },
              select: {
                assignmentEngagementMode: true,
                mentionEngagementPolicy: true,
                mentionDefaultMode: true,
              },
            });
            const resolved = resolveEngagementMode({
              surface: "assignment",
              explicit: (input.mode as EngagementMode | undefined) ?? null,
              workspace: {
                ...ws,
                assignmentAgentEngagementMode: targetAgent.engagementMode,
              },
            });
            engagementMode = resolved.mode;
            engagementSource = resolved.source;
          }
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: before.id,
            action: assignmentChanged ? "assign-agent" : "update-agent-engagement-mode",
            before: { assignedAgentId: before.assignedAgentId },
            after: { assignedAgentId: targetAgentId },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: before.id,
            payload: {
              agentId: targetAgentId,
              previousAgentId: before.assignedAgentId,
              ...(assignmentChanged ? {} : { modeUpdated: true }),
              ...(engagementMode ? { engagementMode } : {}),
              ...(engagementSource ? { engagementSource } : {}),
            },
          });
          if (assignmentChanged && before.assignedAgentId) {
            await abandonRunsForAgentReassignment(tx, {
              workspaceId: ctx.workspaceId,
              issueId: before.id,
              agentId: before.assignedAgentId,
              actorId: ctx.userId,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              summary: targetAgentId
                ? "Abandoned because the issue was reassigned to another agent."
                : "Abandoned because the agent assignment was cleared.",
            });
          }
          if (assignmentChanged) {
            await setIssueAgentWakeTarget(tx, {
              workspaceId: ctx.workspaceId,
              issueId: before.id,
              agentId: targetAgentId,
            });
          }
          // Apply the new agent's template if the description is empty.
          // No-op on unassign (targetAgentId === null) and on non-empty
          // descriptions — including re-assignment to a different agent
          // on an issue whose description was templated by the previous
          // agent.
          if (assignmentChanged && targetAgentId) {
            await maybeApplyAgentTemplate(tx, before.id, targetAgentId);
          }
        }
        return updated.id;
      });
      return mcpIssueDtoById(updatedId);
    },
  },

  /**
   * Handoff an issue from its current agent to a new one in a single
   * transaction. Posts a rationale comment, swaps `assignedAgentId`, and
   * emits AGENT_ASSIGNED with handoff context so downstream listeners
   * (dashboards, webhooks) can distinguish a deliberate handoff from
   * raw reassignment.
   *
   * Rejects when the target agent is missing, archived, or identical to
   * the current assignee — same-agent "handoffs" would create noise
   * (comment + event) without changing ownership; callers should use
   * `comments.create` instead. Rationale is required (>=10 chars) to
   * enforce that this tool's output is actually informative.
   */
  "issues.reassign": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid)"),
      toProfileKey: z.string().min(1).describe("profileKey of the agent receiving the handoff."),
      rationale: z
        .string()
        .min(10, "Rationale must be at least 10 characters.")
        .describe("Why the work is changing hands; surfaced in the handoff comment."),
    }),
    async run(
      input: { issueId: string; toProfileKey: string; rationale: string },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      await assertAgentIssueMutationAllowed(ctx, input.issueId, "issues.reassign");
      const authorId = await resolveActorId(ctx);

      return db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, assignedAgentId: true },
        });
        if (!issue) throw new Error("Issue not found in this workspace.");

        const newAgent = await tx.agent.findUnique({
          where: {
            workspaceId_profileKey: {
              workspaceId: ctx.workspaceId,
              profileKey: input.toProfileKey,
            },
          },
          select: { id: true, profileKey: true, archivedAt: true },
        });
        if (!newAgent) throw new Error("Agent not found in this workspace.");
        if (newAgent.archivedAt) {
          throw new Error("Agent is archived; cannot receive handoff.");
        }

        const fromAgentId = issue.assignedAgentId;
        if (fromAgentId === newAgent.id) {
          // Rejecting same-agent handoff: a handoff implies a transition.
          // Callers wanting to leave a note should use `comments.create`.
          throw new Error("Issue is already assigned to that agent.");
        }

        let fromProfileKey: string | null = null;
        if (fromAgentId) {
          const fromAgent = await tx.agent.findUnique({
            where: { id: fromAgentId },
            select: { profileKey: true },
          });
          fromProfileKey = fromAgent?.profileKey ?? null;
        }

        // Note: Comment has no `authoringAgentId` column in this worktree's
        // schema, so we skip that field. If a sibling branch lands the
        // column, wire it up from `ctx.apiKey?.linkedAgentId`.
        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            authorId,
            body: `Handoff → @${newAgent.profileKey}: ${input.rationale}`,
          },
          select: { id: true },
        });

        await tx.issue.update({
          where: { id: issue.id },
          data: { assignedAgentId: newAgent.id },
        });
        await setIssueAgentWakeTarget(tx, {
          workspaceId: ctx.workspaceId,
          issueId: issue.id,
          agentId: newAgent.id,
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Issue",
          entityId: issue.id,
          action: "assign-agent",
          before: { assignedAgentId: fromAgentId },
          after: { assignedAgentId: newAgent.id },
          eventKind: EventKind.AGENT_ASSIGNED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            auto: false,
            from: fromAgentId,
            to: newAgent.id,
            reason: "handoff",
            rationale: input.rationale,
            commentId: comment.id,
          },
        });
        if (fromAgentId) {
          await abandonRunsForAgentReassignment(tx, {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            agentId: fromAgentId,
            actorId: ctx.userId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            summary: "Abandoned because the issue was handed off to another agent.",
          });
        }

        // Apply the receiving agent's template if the description is
        // empty — in practice this rarely fires on a handoff (an issue
        // mid-flight almost always has content), but it keeps parity
        // with `issues.assign` and covers the "empty stub handed off
        // immediately" edge.
        await maybeApplyAgentTemplate(tx, issue.id, newAgent.id);

        return {
          issueId: issue.id,
          from: fromProfileKey,
          to: newAgent.profileKey,
          commentId: comment.id,
        };
      });
    },
  },

  /**
   * List issues assigned to a specific agent.
   *
   * Resolution order:
   *   1. Explicit `profileKey` → look up `{workspaceId, profileKey}`.
   *   2. Otherwise, fall back to `ctx.apiKey.linkedAgentId` — the common
   *      case for agent-scoped API keys that don't want to repeat their
   *      handle on every call.
   */
  "issues.assigned": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      limit: z.number().int().min(1).max(100).default(50),
      includeDone: z.boolean().default(false),
      projectId: z.string().cuid().optional(),
      profileKey: z
        .string()
        .optional()
        .describe(
          "Agent profileKey to filter by. Optional when the calling API key has a linkedAgentId.",
        ),
    }),
    async run(
      input: { limit: number; includeDone: boolean; projectId?: string; profileKey?: string },
      ctx: McpContext,
    ) {
      let agentId: string | null = null;
      if (input.profileKey) {
        const agent = await db.agent.findUnique({
          where: {
            workspaceId_profileKey: {
              workspaceId: ctx.workspaceId,
              profileKey: input.profileKey,
            },
          },
          select: { id: true },
        });
        if (!agent) throw new Error("Agent not found in this workspace.");
        agentId = agent.id;
      } else if (ctx.apiKey?.linkedAgentId) {
        const agent = await db.agent.findUnique({
          where: { id: ctx.apiKey.linkedAgentId },
          select: { id: true, workspaceId: true },
        });
        // Defensive cross-tenant check — linkedAgentId is scoped by SetNull
        // on Agent delete, but the Agent itself must belong to this key's
        // workspace.
        if (!agent || agent.workspaceId !== ctx.workspaceId) {
          throw new Error(
            "No agent inferred; supply profileKey or use an API key with linkedAgentId set.",
          );
        }
        agentId = agent.id;
      }

      if (!agentId) {
        throw new Error(
          "No agent inferred; supply profileKey or use an API key with linkedAgentId set.",
        );
      }

      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const rows = await db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          assignedAgentId: agentId,
          ...keyWhere,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.includeDone ? {} : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
        },
        take: input.limit,
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        select: mcpIssueDtoSelect,
      });
      return mcpListEnvelope(rows.map(toMcpIssueDto));
    },
  },

  // -------------------------------------------------------------------- Watching
  // Per-(issue, user OR agent) subscriptions. Watch and Pin are
  // orthogonal: pin is a UI shortcut, watch is event subscription.
  // When the calling key has `linkedAgentId`, the row is agent-scoped;
  // otherwise it's user-scoped (resolved via `resolveActorId`).
  //
  // Use case: an agent watches an issue it has stake in but isn't
  // assigned to (`issues.assigned` is for ownership). Comment
  // @-mentions, status transitions, and SLA breaches will fan out to
  // the watcher's webhook in addition to the assignee's.

  /**
   * Watch an issue. Idempotent — calling twice is a no-op. Returns the
   * IssueWatcher row.
   */
  "issues.watch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid) to watch."),
    }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const issue = await db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) throw new Error("Issue not found in this workspace.");
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      if (callerAgentId) {
        return db.issueWatcher.upsert({
          where: { issueId_agentId: { issueId: input.issueId, agentId: callerAgentId } },
          create: {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: callerAgentId,
          },
          update: {},
        });
      }
      const userId = await resolveActorId(ctx);
      return db.issueWatcher.upsert({
        where: { issueId_userId: { issueId: input.issueId, userId } },
        create: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          userId,
        },
        update: {},
      });
    },
  },

  /**
   * Unwatch an issue. No-op if the caller wasn't watching. Returns
   * `{ ok: true }`.
   */
  "issues.unwatch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid) to unwatch."),
    }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      if (callerAgentId) {
        await db.issueWatcher.deleteMany({
          where: { issueId: input.issueId, agentId: callerAgentId },
        });
      } else {
        const userId = await resolveActorId(ctx);
        await db.issueWatcher.deleteMany({
          where: { issueId: input.issueId, userId },
        });
      }
      return { ok: true as const };
    },
  },

  /**
   * List watchers of an issue. Returns user + agent identity fields so
   * a caller can render a tooltip without an extra round-trip.
   */
  "issues.listWatchers": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid)."),
    }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      return db.issueWatcher.findMany({
        where: { issueId: input.issueId, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { id: true, name: true, handle: true } },
          agent: { select: { id: true, profileKey: true, name: true } },
        },
      });
    },
  },

  /**
   * Issues the caller is watching. Mirrors `issue.watching` tRPC. When
   * the API key has `linkedAgentId`, returns agent-watched issues;
   * otherwise the human caller's user-watches.
   */
  "issues.listWatching": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(input: { limit: number }, ctx: McpContext) {
      const callerAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const where: Prisma.IssueWatcherWhereInput = callerAgentId
        ? { workspaceId: ctx.workspaceId, agentId: callerAgentId }
        : { workspaceId: ctx.workspaceId, userId: await resolveActorId(ctx) };
      const rows = await db.issueWatcher.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit,
        include: {
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              updatedAt: true,
              status: { select: { id: true, name: true, category: true } },
              project: { select: { id: true, name: true, key: true } },
            },
          },
        },
      });
      return rows
        .filter((r) => r.issue !== null)
        .map((r) => ({ watchId: r.id, createdAt: r.createdAt, issue: r.issue! }));
    },
  },

  /**
   * Add and/or remove labels on one issue. Convenience around
   * `issues.bulkSetLabels` for the single-issue grooming case (the
   * most common shape). The composite `@@id([issueId, labelId])`
   * lets us re-add an existing pair safely (skipDuplicates).
   */
  "issues.setLabels": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().cuid(),
      add: z.array(z.string().cuid()).max(50).default([]),
      remove: z.array(z.string().cuid()).max(50).default([]),
    }),
    async run(input: { issueId: string; add: string[]; remove: string[] }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      await assertAgentIssueMutationAllowed(ctx, input.issueId, "issues.setLabels");
      const actorId = await resolveActorId(ctx);
      const labelIds = Array.from(new Set([...input.add, ...input.remove]));
      if (labelIds.length > 0) {
        const found = await db.label.findMany({
          where: { id: { in: labelIds }, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (found.length !== labelIds.length) {
          throw new Error("One or more labels do not belong to this workspace.");
        }
      }
      return db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirst({
          where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!issue) throw new Error("Issue not found in this workspace.");

        let added = 0;
        let removed = 0;
        if (input.remove.length > 0) {
          const res = await tx.issueLabel.deleteMany({
            where: { issueId: issue.id, labelId: { in: input.remove } },
          });
          removed = res.count;
        }
        if (input.add.length > 0) {
          const res = await tx.issueLabel.createMany({
            data: input.add.map((labelId) => ({ issueId: issue.id, labelId })),
            skipDuplicates: true,
          });
          added = res.count;
        }
        if (added > 0 || removed > 0) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "set-labels",
            after: { add: input.add, remove: input.remove },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: { add: input.add, remove: input.remove },
          });
        }
        const after = await tx.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: mcpIssueDtoSelect,
        });
        return { issue: toMcpIssueDto(after), added, removed };
      });
    },
  },

  /**
   * Bulk label add/remove across many issues. Wraps the tRPC
   * `issue.bulkSetLabels` semantics (issue.ts:987-) — one audit row
   * per affected issue, chunked, with workspace-scoped validation.
   * Grooming agents tagging large selections should prefer this over
   * N round-trips to `issues.setLabels`.
   */
  "issues.bulkSetLabels": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueIds: z.array(z.string().cuid()).min(1).max(500),
      add: z.array(z.string().cuid()).max(50).default([]),
      remove: z.array(z.string().cuid()).max(50).default([]),
    }),
    async run(input: { issueIds: string[]; add: string[]; remove: string[] }, ctx: McpContext) {
      if (input.add.length === 0 && input.remove.length === 0) {
        return { updated: 0, added: 0, removed: 0 };
      }
      // Per-id scope check so a narrowed key can't tag issues outside its lane.
      for (const id of input.issueIds) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id });
      }
      await assertAgentIssueMutationsAllowed(ctx, input.issueIds, "issues.bulkSetLabels");
      const actorId = await resolveActorId(ctx);
      const labelIds = Array.from(new Set([...input.add, ...input.remove]));
      const found = await db.label.findMany({
        where: { id: { in: labelIds }, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (found.length !== labelIds.length) {
        throw new Error("One or more labels do not belong to this workspace.");
      }

      return db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) {
          return { updated: 0, added: 0, removed: 0 };
        }

        let added = 0;
        let removed = 0;
        if (input.remove.length > 0) {
          const res = await tx.issueLabel.deleteMany({
            where: { issueId: { in: validIds }, labelId: { in: input.remove } },
          });
          removed = res.count;
        }
        if (input.add.length > 0) {
          const data = validIds.flatMap((issueId) =>
            input.add.map((labelId) => ({ issueId, labelId })),
          );
          const res = await tx.issueLabel.createMany({ data, skipDuplicates: true });
          added = res.count;
        }

        // Same 50-row audit chunking as the tRPC proc.
        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId,
              actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-set-labels",
              after: { add: input.add, remove: input.remove },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { add: input.add, remove: input.remove },
            });
          }
        }
        return { updated: validIds.length, added, removed };
      });
    },
  },

  // --------------------------------------------------------------------- Labels
  "labels.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}),
    async run(_input: Record<string, never>, ctx: McpContext) {
      return db.label.findMany({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { name: "asc" },
        include: { _count: { select: { issues: true } } },
      });
    },
  },

  "labels.create": {
    // ADMIN-gated to mirror the tRPC `label.create` adminProcedure.
    // Narrowed agent keys without ADMIN can still tag/untag issues
    // via `issues.setLabels`; only workspace mutation of the label
    // catalog itself requires admin.
    scopes: ["ADMIN"] as const,
    input: z.object({
      name: z.string().min(1).max(40),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }),
    async run(input: { name: string; color: string }, ctx: McpContext) {
      const existing = await db.label.findUnique({
        where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: input.name } },
      });
      if (existing) throw new Error("Label name already used.");
      return db.label.create({
        data: { ...input, workspaceId: ctx.workspaceId },
      });
    },
  },

  "labels.update": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      id: z.string().cuid(),
      name: z.string().min(1).max(40).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    }),
    async run(input: { id: string; name?: string; color?: string }, ctx: McpContext) {
      const { id, ...patch } = input;
      const row = await db.label.findFirst({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new Error("Label not found in this workspace.");
      return db.label.update({ where: { id: row.id }, data: patch });
    },
  },

  "labels.delete": {
    scopes: ["ADMIN"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const row = await db.label.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!row) throw new Error("Label not found in this workspace.");
      await db.label.delete({ where: { id: row.id } });
      return { id: row.id, deleted: true };
    },
  },

  // ------------------------------------------------------------------- Comments
  "comments.create": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      issueId: z.string(),
      body: z.string().min(1).max(50_000),
      /**
       * Quick-reply chip strings the operator can click to seed the
       * composer with a canned response. Capped at 4 × 80 chars by
       * the row-level Zod schema; an empty / omitted array means no
       * chips render. Agent-authored use case — humans can pass them
       * but the renderer hides chips on human-authored comments.
       */
      suggestedReplies: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
      /**
       * Optional confidence flag (LOW / MEDIUM / HIGH). Only rendered
       * as a chip on agent-authored comments — humans can pass it
       * but the UI suppresses the chip. Let operators decide how
       * much to scrutinize an agent's claim before acting on it.
       */
      confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable().optional(),
      /**
       * Optional ActionRequest bundle. When present, a matching row
       * is created in the same flow with `sourceType="comment"` +
       * `sourceId=<commentId>` so `actionRequest.forComment` resolves
       * it back. Use this to post a recommendation card alongside an
       * explanatory comment in one round-trip.
       */
      actionRequest: z
        .object({
          title: z.string().min(1).max(300),
          body: z.string().max(10_000).nullable().optional(),
          severity: z.enum(["INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"]).default("INFO"),
          kind: z
            .enum([
              "FREE_FORM",
              "TRANSITION",
              "SET_LABELS",
              "ASSIGN",
              "ASSIGN_AGENT",
              "ARCHIVE",
              "CLOSE_AS_DUPLICATE",
              "RUNTIME_TOOL_GRANT",
            ])
            .default("FREE_FORM"),
          payload: z.unknown().optional(),
          /**
           * Inline poll options. Same shape as the top-level
           * `actionRequests.create` tool. Most useful when an agent
           * posts a comment AND an attached poll in one round-trip
           * ("here are three approaches — which one?").
           */
          options: z
            .array(
              z.object({
                key: z.string().trim().min(1).max(80),
                label: z.string().trim().min(1).max(200),
                description: z.string().trim().max(2_000).optional(),
              }),
            )
            .min(2)
            .max(8)
            .optional(),
          assignedUserId: z.string().cuid().nullable().optional(),
          assignedAgentId: agentIdSchema.nullable().optional(),
          dueAt: z.coerce.date().nullable().optional(),
        })
        .optional(),
    }),
    async run(
      input: {
        issueId: string;
        body: string;
        suggestedReplies?: string[];
        confidence?: "LOW" | "MEDIUM" | "HIGH" | null;
        actionRequest?: {
          title: string;
          body?: string | null;
          severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";
          kind:
            | "FREE_FORM"
            | "TRANSITION"
            | "SET_LABELS"
            | "ASSIGN"
            | "ASSIGN_AGENT"
            | "ARCHIVE"
            | "CLOSE_AS_DUPLICATE"
            | "RUNTIME_TOOL_GRANT";
          payload?: unknown;
          options?: Array<{ key: string; label: string; description?: string }>;
          assignedUserId?: string | null;
          assignedAgentId?: string | null;
          dueAt?: Date | null;
        };
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      await assertMcpActiveIssue(ctx, input.issueId);
      const authorId = await resolveActorId(ctx);
      // When the API key is linked to an Agent, record it on the comment so
      // the issue detail UI can render it as agent-authored instead of
      // attributing the write to the human key owner.
      const authoringAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const comment = await db.comment.create({
        data: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          authorId,
          body: input.body,
          authoringAgentId,
          suggestedReplies: input.suggestedReplies ?? [],
          confidence: input.confidence ?? null,
        },
      });
      // Touch the agent run on every agent-authored comment so the live
      // pulse strip stays warm. Comments are usually big-picture turn
      // markers, so we keep the kind as COMMENT (not STATUS — that's a
      // separate dedicated tool).
      if (authoringAgentId) {
        await db.$transaction(async (tx) => {
          const { run, isNew } = await openOrTouchRun(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: authoringAgentId,
            actorId: authorId,
            actorAgentId: authoringAgentId,
          });
          if (isNew) {
            await tx.agentRun.updateMany({
              where: { id: run.id, outputStartedAt: null },
              data: { outputStartedAt: new Date() },
            });
          } else {
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: ctx.workspaceId,
              issueId: input.issueId,
              agentId: authoringAgentId,
              kind: "COMMENT",
              payload: { commentId: comment.id, preview: input.body.slice(0, 120) },
            });
          }
        });
      }
      // Optional inline ActionRequest — created after the comment is
      // persisted so we have a stable id to bind via sourceType/sourceId.
      let actionRequestId: string | null = null;
      if (input.actionRequest) {
        const { createActionRequest } = await import("@/server/services/action-request-service");
        const created = await createActionRequest(db, {
          workspaceId: ctx.workspaceId,
          actorId: authorId,
          actorAgentId: authoringAgentId,
          title: input.actionRequest.title,
          body: input.actionRequest.body ?? null,
          severity: input.actionRequest.severity as never,
          kind: input.actionRequest.kind as never,
          payload: input.actionRequest.payload,
          options: input.actionRequest.options ?? null,
          assignedUserId: input.actionRequest.assignedUserId ?? null,
          assignedAgentId: input.actionRequest.assignedAgentId ?? null,
          sourceType: "comment",
          sourceId: comment.id,
          issueId: input.issueId,
          dueAt: input.actionRequest.dueAt ?? null,
        });
        actionRequestId = created.id;
      }
      return { ...comment, actionRequestId };
    },
  },

  /**
   * Edit a comment body through MCP using the same persisted revision fields
   * as the app comment editor: push the previous body into `revisions`, set
   * `editedAt`, and emit a COMMENT_UPDATED audit/activity event. The author
   * may edit their own comment; workspace OWNER/ADMIN or ADMIN-scoped keys
   * may override.
   */
  "comments.update": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      id: z.string().cuid().describe("Comment id (cuid)."),
      body: z.string().min(1).max(50_000),
    }),
    async run(input: { id: string; body: string }, ctx: McpContext) {
      const existing = await db.comment.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          id: true,
          body: true,
          issueId: true,
          kind: true,
          authorId: true,
          authoringAgentId: true,
          updatedAt: true,
          revisions: true,
        },
      });
      if (!existing) throw new Error("Comment not found in this workspace.");
      if (!existing.issueId)
        throw new Error("MCP comment updates currently require an issue comment.");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: existing.issueId });
      await assertMcpActiveIssue(ctx, existing.issueId);
      await assertMcpCommentWriteAllowed(ctx, existing);

      if (existing.body === input.body) {
        return db.comment.findUniqueOrThrow({
          where: { id: input.id },
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        });
      }

      const oldTokens = new Set(extractMentions(existing.body));
      const addedTokens = extractMentions(input.body).filter((token) => !oldTokens.has(token));
      const priorRevisions = Array.isArray(existing.revisions)
        ? (existing.revisions as Prisma.JsonArray)
        : [];
      const nextRevisions: Prisma.JsonArray = [
        ...priorRevisions,
        { body: existing.body, editedAt: existing.updatedAt.toISOString() },
      ].slice(-MCP_BODY_REVISION_CAP);
      const actorId = await resolveActorId(ctx);
      const actorAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const now = new Date();

      return db.$transaction(async (tx) => {
        const newlyMentionedAgents: Array<{ agentId: string; profileKey: string }> = [];
        const newlyMentionedUsers: Array<{ userId: string; handle: string }> = [];
        if (addedTokens.length) {
          const [agentMatches, userMatches] = await Promise.all([
            tx.agent.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                profileKey: { in: addedTokens },
                archivedAt: null,
              },
              select: { id: true, profileKey: true },
            }),
            tx.user.findMany({
              where: {
                handle: { in: addedTokens },
                memberships: { some: { workspaceId: ctx.workspaceId } },
              },
              select: { id: true, handle: true },
            }),
          ]);
          for (const agent of agentMatches) {
            newlyMentionedAgents.push({ agentId: agent.id, profileKey: agent.profileKey });
          }
          for (const user of userMatches) {
            if (user.handle) newlyMentionedUsers.push({ userId: user.id, handle: user.handle });
          }
          for (const mentioned of newlyMentionedAgents) {
            await autoWatchAgent(tx, {
              workspaceId: ctx.workspaceId,
              issueId: existing.issueId!,
              agentId: mentioned.agentId,
            });
          }
          for (const mentioned of newlyMentionedUsers) {
            await autoWatchUser(tx, {
              workspaceId: ctx.workspaceId,
              issueId: existing.issueId!,
              userId: mentioned.userId,
            });
          }
        }

        const updated = (await tx.comment.update({
          where: { id: input.id },
          data: { body: input.body, revisions: nextRevisions, editedAt: now, updatedAt: now },
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        })) as McpCommentMutationRow;

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId,
          entity: "Comment",
          entityId: updated.id,
          action: "update",
          before: { body: existing.body },
          after: updated,
          eventKind: EventKind.COMMENT_UPDATED,
          subjectType: "issue",
          subjectId: existing.issueId!,
          payload: {
            commentId: updated.id,
            issueId: existing.issueId,
            edited: true,
            preview: input.body.slice(0, 120),
            mentions: {
              agentIds: newlyMentionedAgents.map((m) => m.agentId),
              userIds: newlyMentionedUsers.map((m) => m.userId),
              agents: newlyMentionedAgents,
            },
          },
        });

        return updated;
      });
    },
  },

  /**
   * Soft-delete/archive a comment through MCP. The row stays in the database
   * with `deletedAt` set and is hidden from `comments.list`, `issues.get`
   * comment hydration, and `agent.context.bundle` because those read paths
   * already filter deleted comments.
   */
  "comments.delete": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({ id: z.string().cuid().describe("Comment id (cuid).") }),
    async run(input: { id: string }, ctx: McpContext) {
      const existing = await db.comment.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          id: true,
          body: true,
          issueId: true,
          authorId: true,
          authoringAgentId: true,
          deletedAt: true,
        },
      });
      if (!existing) throw new Error("Comment not found in this workspace.");
      if (!existing.issueId)
        throw new Error("MCP comment deletion currently requires an issue comment.");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: existing.issueId });
      await assertMcpActiveIssue(ctx, existing.issueId);
      await assertMcpCommentWriteAllowed(ctx, existing);

      const actorId = await resolveActorId(ctx);
      const actorAgentId = ctx.apiKey?.linkedAgentId ?? null;
      return db.$transaction(async (tx) => {
        const deleted = await tx.comment.update({
          where: { id: input.id },
          data: { deletedAt: new Date() },
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        });

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId,
          entity: "Comment",
          entityId: deleted.id,
          action: "delete",
          before: { body: existing.body, deletedAt: existing.deletedAt },
          after: deleted,
          eventKind: EventKind.COMMENT_UPDATED,
          subjectType: "issue",
          subjectId: existing.issueId!,
          payload: {
            commentId: deleted.id,
            issueId: existing.issueId,
            deleted: true,
          },
        });

        return { ...deleted, deleted: true };
      });
    },
  },

  /**
   * Rolling live status comment. Idempotent — agents call it on every
   * loop turn with the current step + body, and Forge upserts a single
   * STATUS-kind Comment per AgentRun (rolling history kept in
   * `revisions`). Implicitly opens an AgentRun if one isn't active for
   * (issueId, callingAgent), giving the issue page a live pulse strip
   * to render. Only callable by agent-linked API keys.
   *
   * Best practice: call this *before* you start a turn ("Reading…",
   * "Running tests…") so the live strip reflects what's happening right
   * now. The body itself can be markdown — including
   * `forge-attachment:` references, `@profileKey` mentions, and bare
   * `KEY-NN` issue refs (auto-linked by the comment renderer).
   */
  "comments.upsertStatus": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      issueId: z.string(),
      body: z.string().min(1).max(50_000),
      currentStep: z.string().max(120).nullable().optional(),
    }),
    async run(
      input: { issueId: string; body: string; currentStep?: string | null },
      ctx: McpContext,
    ) {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new Error("comments.upsertStatus requires an agent-linked API key.");
      }
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const authorId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const { run, isNew } = await openOrTouchRun(tx, {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          agentId,
          actorId: authorId,
          actorAgentId: agentId,
          currentStep: input.currentStep ?? null,
        });
        if (isNew) {
          await tx.agentRun.updateMany({
            where: { id: run.id, outputStartedAt: null },
            data: { outputStartedAt: new Date() },
          });
        }

        const existing = await tx.comment.findFirst({
          where: { runId: run.id, kind: CommentKind.STATUS },
        });

        let comment;
        if (!existing) {
          comment = await tx.comment.create({
            data: {
              workspaceId: ctx.workspaceId,
              issueId: input.issueId,
              authorId,
              authoringAgentId: agentId,
              body: input.body,
              kind: CommentKind.STATUS,
              runId: run.id,
              currentStep: input.currentStep ?? null,
              revisions: [],
            },
          });
        } else {
          const priorRevisions = Array.isArray(existing.revisions)
            ? (existing.revisions as Prisma.JsonArray)
            : [];
          const nextRevisions: Prisma.JsonArray = [
            ...priorRevisions,
            {
              body: existing.body,
              currentStep: existing.currentStep,
              ts: existing.updatedAt.toISOString(),
            },
          ].slice(-50);
          comment = await tx.comment.update({
            where: { id: existing.id },
            data: {
              body: input.body,
              currentStep: input.currentStep ?? null,
              revisions: nextRevisions,
              updatedAt: new Date(),
            },
          });
        }

        if (!isNew) {
          await appendRunEvent(tx, {
            runId: run.id,
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId,
            kind: "STATUS",
            payload: { commentId: comment.id, preview: input.body.slice(0, 120) },
            currentStep: input.currentStep ?? null,
          });
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: authorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Comment",
          entityId: comment.id,
          action: existing ? "update-status" : "create-status",
          after: comment,
          eventKind: existing ? EventKind.COMMENT_UPDATED : EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: {
            commentId: comment.id,
            issueId: input.issueId,
            kind: "STATUS",
            runId: run.id,
            preview: input.body.slice(0, 120),
            currentStep: input.currentStep ?? null,
          },
        });

        return { ...comment, runId: run.id };
      });
    },
  },

  /**
   * List comments on an issue, newest first. Cursor-paginated by createdAt
   * via the optional `before` parameter. Filters soft-deleted rows. Includes
   * `author` (the persisted user FK — agent-authored comments still have an
   * author of the API-key owner) and `authoringAgent` (set when the comment
   * was created via an agent-linked API key) so callers can render
   * provenance correctly.
   */
  "comments.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid)."),
      before: z.coerce
        .date()
        .optional()
        .describe("Cursor — return comments created strictly before this timestamp."),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    async run(input: { issueId: string; before?: Date; limit: number }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      // Defensive workspace check — assertKeyScope only enforces narrowing,
      // not workspace membership. The base findMany filter does the rest.
      const rows = await db.comment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          deletedAt: null,
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        include: {
          author: { select: { id: true, name: true, image: true } },
          authoringAgent: {
            select: { id: true, profileKey: true, name: true },
          },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) {
        rows.pop();
        nextCursor = rows.at(-1)?.createdAt.toISOString();
      }
      return mcpListEnvelope(rows, nextCursor);
    },
  },

  // ------------------------------------------------------------------- Projects
  "projects.list": {
    scopes: ["READ_PROJECTS"] as const,
    input: z.object({ includeArchived: z.boolean().default(false) }),
    async run(input: { includeArchived: boolean }, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "project");
      return db.project.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.includeArchived ? {} : { archived: false }),
        },
        orderBy: { updatedAt: "desc" },
      });
    },
  },

  "projects.create": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      key: projectKey,
      name: z.string().min(1).max(120),
      description: z.string().max(4000).optional(),
      icon: z.string().max(8).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      startDate: z.coerce.date().optional(),
      targetDate: z.coerce.date().optional(),
    }),
    async run(
      input: {
        key: string;
        name: string;
        description?: string;
        icon?: string;
        color?: string;
        startDate?: Date;
        targetDate?: Date;
      },
      ctx: McpContext,
    ) {
      if (ctx.apiKey?.projectIds.length) {
        throw new Error("API key scope does not include this resource.");
      }
      if (
        input.startDate &&
        input.targetDate &&
        input.targetDate.getTime() < input.startDate.getTime()
      ) {
        throw new Error("Project targetDate must be on or after startDate.");
      }
      const actorId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { ...input, workspaceId: ctx.workspaceId, createdById: actorId },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Project",
          entityId: project.id,
          action: "create",
          after: project,
          eventKind: EventKind.PROJECT_CREATED,
          subjectType: "project",
          subjectId: project.id,
          payload: { name: project.name, key: project.key },
        });
        return project;
      });
    },
  },

  "projects.update": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      id: z.string().describe("Project id (cuid)"),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(4000).nullable().optional(),
      icon: z.string().max(8).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      archived: z.boolean().optional(),
      startDate: z.coerce.date().nullable().optional(),
      targetDate: z.coerce.date().nullable().optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        description?: string | null;
        icon?: string;
        color?: string;
        archived?: boolean;
        startDate?: Date | null;
        targetDate?: Date | null;
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "project", id: input.id });
      const actorId = await resolveActorId(ctx);
      const { id, ...patch } = input;
      return db.$transaction(async (tx) => {
        const before = await tx.project.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
        });
        const startDate = patch.startDate === undefined ? before.startDate : patch.startDate;
        const targetDate = patch.targetDate === undefined ? before.targetDate : patch.targetDate;
        if (startDate && targetDate && targetDate.getTime() < startDate.getTime()) {
          throw new Error("Project targetDate must be on or after startDate.");
        }
        const after = await tx.project.update({ where: { id: before.id }, data: patch });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Project",
          entityId: before.id,
          action: "update",
          before,
          after,
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "project",
          subjectId: before.id,
          payload: patch,
        });
        return after;
      });
    },
  },

  "projects.archive": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({ id: z.string().describe("Project id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "project", id: input.id });
      return db.$transaction(async (tx) => {
        const project = await tx.project.findFirstOrThrow({
          where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        return tx.project.update({
          where: { id: project.id },
          data: { archived: true },
        });
      });
    },
  },

  // -------------------------------------------------------------------- Analytics
  "analytics.summary": {
    scopes: ["READ_ANALYTICS"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "issue");
      const [open, done] = await Promise.all([
        db.issue.count({
          where: {
            workspaceId: ctx.workspaceId,
            deletedAt: null,
            ...keyWhere,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
        }),
        db.issue.count({
          where: {
            workspaceId: ctx.workspaceId,
            ...keyWhere,
            status: { category: "DONE" },
          },
        }),
      ]);
      return { openIssues: open, doneIssues: done };
    },
  },

  // -------------------------------------------------------------------- Standup
  "standup.draft": {
    scopes: ["READ_ISSUES", "READ_ANALYTICS"] as const,
    input: z
      .object({
        /**
         * Lookback window in hours. 24 = yesterday, 72 = three days,
         * 168 = a full week. Capped at 168.
         */
        sinceHours: z.number().int().min(1).max(168).default(24),
      })
      .default({}),
    async run(raw: unknown, ctx: McpContext): Promise<unknown> {
      const input = (raw ?? {}) as { sinceHours?: number };
      const userId = await resolveActorId(ctx);
      const { composeStandup } = await import("@/server/services/standup");
      return composeStandup({
        workspaceId: ctx.workspaceId,
        userId,
        sinceHours: input.sinceHours ?? 24,
      });
    },
  },

  // ---------------------------------------------------------------------- Cycles
  "cycles.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({
        status: z
          .nativeEnum(CycleStatus)
          .optional()
          .describe("Filter by CycleStatus (PLANNED/ACTIVE/COMPLETED)"),
      })
      .default({}),
    async run(input: { status?: CycleStatus }, ctx: McpContext) {
      return db.cycle.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { startsAt: "desc" },
        include: { _count: { select: { issues: true } } },
      });
    },
  },

  "cycles.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().describe("Cycle id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      return db.cycle.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          issues: {
            where: { deletedAt: null },
            include: { status: true },
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
          },
        },
      });
    },
  },

  "cycles.current": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      return db.cycle.findFirst({
        where: { workspaceId: ctx.workspaceId, status: CycleStatus.ACTIVE },
        orderBy: { startsAt: "desc" },
      });
    },
  },

  "cycles.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      name: z.string().min(1).max(80),
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      lengthDays: z.number().int().min(1).max(365).optional(),
      cooldownDays: z.number().int().min(0).max(90).optional(),
      status: z.nativeEnum(CycleStatus).optional(),
    }),
    async run(
      input: {
        name: string;
        startsAt?: Date;
        endsAt?: Date;
        lengthDays?: number;
        cooldownDays?: number;
        status?: CycleStatus;
      },
      ctx: McpContext,
    ) {
      const ws = await db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { cycleLengthDays: true, cycleCooldownDays: true },
      });
      const lengthDays = input.lengthDays ?? ws.cycleLengthDays;
      const cooldownDays = input.cooldownDays ?? ws.cycleCooldownDays;
      const startsAt = input.startsAt ?? new Date();
      const endsAt = input.endsAt ?? addDays(startsAt, lengthDays);
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new Error("Cycle `endsAt` must be after `startsAt`.");
      }
      return db.$transaction(async (tx) => {
        if (input.status === CycleStatus.ACTIVE) {
          await assertNoOtherMcpActiveCycle(tx, ctx.workspaceId);
        }
        return tx.cycle.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: input.name,
            startsAt,
            endsAt,
            lengthDays,
            cooldownDays,
            status: input.status,
          },
        });
      });
    },
  },

  "cycles.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(80).optional(),
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      status: z.nativeEnum(CycleStatus).optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        startsAt?: Date;
        endsAt?: Date;
        status?: CycleStatus;
      },
      ctx: McpContext,
    ) {
      const { id, ...patch } = input;
      return db.$transaction(async (tx) => {
        const before = await tx.cycle.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId },
        });
        if (patch.status === CycleStatus.ACTIVE && before.status !== CycleStatus.ACTIVE) {
          await assertNoOtherMcpActiveCycle(tx, ctx.workspaceId, id);
        }
        const startsAt = patch.startsAt ?? before.startsAt;
        const endsAt = patch.endsAt ?? before.endsAt;
        if (endsAt.getTime() <= startsAt.getTime()) {
          throw new Error("Cycle `endsAt` must be after `startsAt`.");
        }
        return tx.cycle.update({
          where: { id: before.id },
          data: {
            ...patch,
            ...((patch.startsAt || patch.endsAt) && {
              lengthDays: daysBetween(startsAt, endsAt),
            }),
          },
        });
      });
    },
  },

  "cycles.plan": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      cycleId: z.string(),
      issueIds: z.array(z.string()).min(1).max(500),
    }),
    async run(input: { cycleId: string; issueIds: string[] }, ctx: McpContext) {
      const cycle = await db.cycle.findFirstOrThrow({
        where: { id: input.cycleId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      for (const id of input.issueIds) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id });
      }
      const issues = await db.issue.findMany({
        where: {
          id: { in: input.issueIds },
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (issues.length !== input.issueIds.length) {
        throw new Error("One or more issues were not found in this workspace.");
      }
      await db.issue.updateMany({
        where: { id: { in: issues.map((i) => i.id) }, workspaceId: ctx.workspaceId },
        data: { cycleId: cycle.id },
      });
      return { planned: issues.length, cycleId: cycle.id };
    },
  },

  /**
   * Attach a single issue to a cycle. Both entities must live in the same
   * workspace and the caller's key scope must include the issue.
   */
  "cycles.addIssue": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      cycleId: z.string().describe("Cycle id (cuid)"),
      issueId: z.string().describe("Issue id (cuid)"),
    }),
    async run(input: { cycleId: string; issueId: string }, ctx: McpContext) {
      await assertAgentIssueMutationAllowed(ctx, input.issueId, "cycles.addIssue");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const [cycle, issue] = await Promise.all([
        db.cycle.findFirst({
          where: { id: input.cycleId, workspaceId: ctx.workspaceId },
          select: { id: true },
        }),
        db.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        }),
      ]);
      if (!cycle) throw new Error("Cycle not found in this workspace.");
      if (!issue) throw new Error("Issue not found in this workspace.");
      return db.issue.update({
        where: { id: issue.id },
        data: { cycleId: cycle.id },
        include: { status: true, project: true },
      });
    },
  },

  /**
   * Detach an issue from its current cycle. No-op if the issue has no cycle.
   * No `cycleId` param — removing is per-issue.
   */
  "cycles.removeIssue": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().describe("Issue id (cuid)"),
    }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertAgentIssueMutationAllowed(ctx, input.issueId, "cycles.removeIssue");
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const issue = await db.issue.findFirst({
        where: {
          id: input.issueId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!issue) throw new Error("Issue not found in this workspace.");
      return db.issue.update({
        where: { id: issue.id },
        data: { cycleId: null },
        include: { status: true, project: true },
      });
    },
  },

  "cycles.rollover": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      fromCycleId: z.string(),
      completeSource: z.boolean().optional().default(false),
      activateTarget: z.boolean().optional().default(false),
    }),
    async run(
      input: { fromCycleId: string; completeSource?: boolean; activateTarget?: boolean },
      ctx: McpContext,
    ) {
      return db.$transaction(async (tx) => {
        const fromCycle = await tx.cycle.findFirstOrThrow({
          where: { id: input.fromCycleId, workspaceId: ctx.workspaceId },
        });
        const shouldActivateTarget = input.activateTarget ?? false;
        const shouldCompleteSource = (input.completeSource ?? false) || shouldActivateTarget;

        if (shouldActivateTarget) {
          await assertNoOtherMcpActiveCycle(tx, ctx.workspaceId, fromCycle.id);
        }

        const unfinished = await tx.issue.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            cycleId: fromCycle.id,
            deletedAt: null,
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
          select: { id: true },
        });

        let target = await tx.cycle.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            status: CycleStatus.PLANNED,
            id: { not: fromCycle.id },
            startsAt: { gte: fromCycle.endsAt },
          },
          orderBy: { startsAt: "asc" },
        });
        if (!target) {
          const ws = await tx.workspace.findUniqueOrThrow({
            where: { id: ctx.workspaceId },
            select: { cycleLengthDays: true, cycleCooldownDays: true },
          });
          const startsAt = addDays(fromCycle.endsAt, ws.cycleCooldownDays);
          const endsAt = addDays(startsAt, ws.cycleLengthDays);
          target = await tx.cycle.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: `${fromCycle.name} (rollover)`,
              startsAt,
              endsAt,
              lengthDays: ws.cycleLengthDays,
              cooldownDays: ws.cycleCooldownDays,
              status: shouldActivateTarget ? CycleStatus.ACTIVE : CycleStatus.PLANNED,
            },
          });
        } else if (shouldActivateTarget && target.status !== CycleStatus.ACTIVE) {
          target = await tx.cycle.update({
            where: { id: target.id },
            data: { status: CycleStatus.ACTIVE },
          });
        }
        if (unfinished.length) {
          await tx.issue.updateMany({
            where: { id: { in: unfinished.map((i) => i.id) }, workspaceId: ctx.workspaceId },
            data: { cycleId: target.id },
          });
        }
        let sourceCompleted = false;
        if (shouldCompleteSource && fromCycle.status !== CycleStatus.COMPLETED) {
          await tx.cycle.update({
            where: { id: fromCycle.id },
            data: { status: CycleStatus.COMPLETED },
          });
          sourceCompleted = true;
        }
        return {
          rolled: unfinished.length,
          targetCycleId: target.id,
          sourceCompleted,
          targetActivated: target.status === CycleStatus.ACTIVE,
        };
      });
    },
  },

  // ----------------------------------------------------------------- Initiatives
  "initiatives.list": {
    scopes: ["READ_PROJECTS"] as const,
    input: z
      .object({
        status: z.nativeEnum(InitiativeStatus).optional().describe("Filter by InitiativeStatus"),
      })
      .default({}),
    async run(input: { status?: InitiativeStatus }, ctx: McpContext) {
      const keyWhere = buildKeyScopeWhere(scopeCtx(ctx), "initiative");
      return db.initiative.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...keyWhere,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: { _count: { select: { projects: true } } },
      });
    },
  },

  "initiatives.get": {
    scopes: ["READ_PROJECTS"] as const,
    input: z.object({ id: z.string().describe("Initiative id (cuid)") }),
    async run(input: { id: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "initiative", id: input.id });
      return db.initiative.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          projects: {
            where: { deletedAt: null },
            orderBy: { updatedAt: "desc" },
          },
        },
      });
    },
  },

  "initiatives.create": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      name: z.string().min(1).max(120),
      slug: z
        .string()
        .min(2)
        .max(48)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      description: z.string().max(10_000).optional(),
      targetDate: z.coerce.date().optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    }),
    async run(
      input: {
        name: string;
        slug?: string;
        description?: string;
        targetDate?: Date;
        color?: string;
      },
      ctx: McpContext,
    ) {
      const slugSource =
        (input.slug ?? input.name)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48) || "initiative";
      const createdById = await resolveActorId(ctx);
      const last = await db.initiative.findFirst({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      return db.initiative.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          slug: slugSource,
          description: input.description,
          targetDate: input.targetDate,
          color: input.color,
          position: (last?.position ?? -1) + 1,
          createdById,
        },
      });
    },
  },

  "initiatives.update": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(10_000).nullable().optional(),
      targetDate: z.coerce.date().nullable().optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
      status: z.nativeEnum(InitiativeStatus).optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        description?: string | null;
        targetDate?: Date | null;
        color?: string | null;
        status?: InitiativeStatus;
      },
      ctx: McpContext,
    ) {
      const { id, ...patch } = input;
      await assertKeyScope(scopeCtx(ctx), { entity: "initiative", id });
      const initiative = await db.initiative.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.initiative.update({ where: { id: initiative.id }, data: patch });
    },
  },

  "initiatives.linkProject": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({
      initiativeId: z.string(),
      projectId: z.string(),
    }),
    async run(input: { initiativeId: string; projectId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), {
        entity: "initiative",
        id: input.initiativeId,
      });
      await assertKeyScope(scopeCtx(ctx), {
        entity: "project",
        id: input.projectId,
      });
      const initiative = await db.initiative.findFirstOrThrow({
        where: { id: input.initiativeId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.project.update({
        where: { id: project.id },
        data: { initiativeId: initiative.id },
      });
    },
  },

  "initiatives.unlinkProject": {
    scopes: ["WRITE_PROJECTS"] as const,
    input: z.object({ projectId: z.string() }),
    async run(input: { projectId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), {
        entity: "project",
        id: input.projectId,
      });
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      return db.project.update({
        where: { id: project.id },
        data: { initiativeId: null },
      });
    },
  },

  // ------------------------------------------------------------------- Relations
  "relations.add": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      fromIssueId: z.string(),
      toIssueId: z.string(),
      kind: z.nativeEnum(RelationKind),
    }),
    async run(
      input: { fromIssueId: string; toIssueId: string; kind: RelationKind },
      ctx: McpContext,
    ) {
      if (input.fromIssueId === input.toIssueId) {
        throw new Error("Cannot relate an issue to itself.");
      }
      await assertAgentIssueMutationsAllowed(
        ctx,
        [input.fromIssueId, input.toIssueId],
        "relations.add",
      );
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.fromIssueId });
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.toIssueId });

      return db.$transaction(async (tx) => {
        const [from, to] = await Promise.all([
          tx.issue.findFirst({
            where: {
              id: input.fromIssueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          }),
          tx.issue.findFirst({
            where: {
              id: input.toIssueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          }),
        ]);
        if (!from || !to) {
          throw new Error("Both issues must belong to this workspace.");
        }
        const primary = await tx.issueRelation.upsert({
          where: {
            fromIssueId_toIssueId_kind: {
              fromIssueId: input.fromIssueId,
              toIssueId: input.toIssueId,
              kind: input.kind,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            fromIssueId: input.fromIssueId,
            toIssueId: input.toIssueId,
            kind: input.kind,
          },
          update: {},
        });
        const mirror =
          input.kind === RelationKind.BLOCKS
            ? RelationKind.BLOCKED_BY
            : input.kind === RelationKind.BLOCKED_BY
              ? RelationKind.BLOCKS
              : null;
        let reciprocal: typeof primary | null = null;
        if (mirror) {
          reciprocal = await tx.issueRelation.upsert({
            where: {
              fromIssueId_toIssueId_kind: {
                fromIssueId: input.toIssueId,
                toIssueId: input.fromIssueId,
                kind: mirror,
              },
            },
            create: {
              workspaceId: ctx.workspaceId,
              fromIssueId: input.toIssueId,
              toIssueId: input.fromIssueId,
              kind: mirror,
            },
            update: {},
          });
        }
        return { relation: primary, reciprocal };
      });
    },
  },

  "relations.remove": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ relationId: z.string() }),
    async run(input: { relationId: string }, ctx: McpContext) {
      return db.$transaction(async (tx) => {
        const relation = await tx.issueRelation.findFirst({
          where: { id: input.relationId, workspaceId: ctx.workspaceId },
        });
        if (!relation) throw new Error("Relation not found.");
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: relation.fromIssueId,
        });
        await tx.issueRelation.delete({ where: { id: relation.id } });
        const mirror =
          relation.kind === RelationKind.BLOCKS
            ? RelationKind.BLOCKED_BY
            : relation.kind === RelationKind.BLOCKED_BY
              ? RelationKind.BLOCKS
              : null;
        if (mirror) {
          await tx.issueRelation.deleteMany({
            where: {
              workspaceId: ctx.workspaceId,
              fromIssueId: relation.toIssueId,
              toIssueId: relation.fromIssueId,
              kind: mirror,
            },
          });
        }
        return { ok: true };
      });
    },
  },

  "relations.listForIssue": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ issueId: z.string() }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const issue = await db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!issue) throw new Error("Issue not found.");
      return db.issueRelation.findMany({
        where: { workspaceId: ctx.workspaceId, fromIssueId: input.issueId },
        include: {
          toIssue: {
            select: {
              id: true,
              number: true,
              title: true,
              statusId: true,
              status: { select: { category: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });
    },
  },

  // ------------------------------------------------------------------- Time
  "time.start": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().optional(),
      description: z.string().max(1000).optional(),
      billable: z.boolean().default(false),
      hourlyRate: z.number().min(0).max(10_000).optional(),
    }),
    async run(
      input: {
        issueId?: string;
        description?: string;
        billable: boolean;
        hourlyRate?: number;
      },
      ctx: McpContext,
    ) {
      const userId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const running = await tx.timeEntry.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            userId,
            endedAt: null,
          },
        });
        if (running) {
          throw new Error("A time entry is already running. Stop it before starting a new one.");
        }
        if (input.issueId) {
          await assertKeyScope(scopeCtx(ctx), {
            entity: "issue",
            id: input.issueId,
          });
          const issue = await tx.issue.findFirst({
            where: {
              id: input.issueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (!issue) throw new Error("Issue not found in workspace.");
        }
        return tx.timeEntry.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId,
            issueId: input.issueId,
            description: input.description,
            startedAt: new Date(),
            billable: input.billable,
            hourlyRate: input.hourlyRate,
          },
        });
      });
    },
  },

  "time.stop": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ entryId: z.string() }),
    async run(input: { entryId: string }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const entry = await db.timeEntry.findFirst({
        where: {
          id: input.entryId,
          workspaceId: ctx.workspaceId,
          userId,
        },
      });
      if (!entry) throw new Error("Time entry not found.");
      if (entry.endedAt) throw new Error("Entry is already stopped.");
      return db.timeEntry.update({
        where: { id: entry.id },
        data: { endedAt: new Date() },
      });
    },
  },

  /**
   * Direct time-entry backfill — writes a completed entry without spinning
   * a timer. Use when reconciling external tools or logging retroactively.
   * `endedAt` must be strictly after `startedAt`.
   */
  "time.log": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().optional(),
      description: z.string().max(1000).optional(),
      startedAt: z.coerce.date(),
      endedAt: z.coerce.date(),
      billable: z.boolean().default(false),
      hourlyRate: z.number().min(0).max(10_000).optional(),
    }),
    async run(
      input: {
        issueId?: string;
        description?: string;
        startedAt: Date;
        endedAt: Date;
        billable: boolean;
        hourlyRate?: number;
      },
      ctx: McpContext,
    ) {
      if (input.endedAt.getTime() <= input.startedAt.getTime()) {
        throw new Error("`endedAt` must be after `startedAt`.");
      }
      const userId = await resolveActorId(ctx);
      if (input.issueId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.issueId,
        });
        const issue = await db.issue.findFirst({
          where: {
            id: input.issueId,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!issue) throw new Error("Issue not found in workspace.");
      }
      return db.timeEntry.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId,
          issueId: input.issueId,
          description: input.description,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          billable: input.billable,
          hourlyRate: input.hourlyRate,
        },
      });
    },
  },

  "time.running": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      return db.timeEntry.findFirst({
        where: { workspaceId: ctx.workspaceId, userId, endedAt: null },
        include: {
          issue: {
            select: { id: true, number: true, title: true, projectId: true },
          },
        },
      });
    },
  },

  "time.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      userId: z.string().optional(),
      issueId: z.string().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      billable: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    async run(
      input: {
        userId?: string;
        issueId?: string;
        from?: Date;
        to?: Date;
        billable?: boolean;
        limit: number;
      },
      ctx: McpContext,
    ) {
      const userId = input.userId ?? (await resolveActorId(ctx));
      return db.timeEntry.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          ...(input.issueId ? { issueId: input.issueId } : {}),
          ...(input.billable !== undefined ? { billable: input.billable } : {}),
          ...(input.from || input.to
            ? {
                startedAt: {
                  ...(input.from ? { gte: input.from } : {}),
                  ...(input.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { startedAt: "desc" },
        take: input.limit,
        include: {
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              project: { select: { id: true, key: true, name: true } },
            },
          },
        },
      });
    },
  },

  "time.summary": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      groupBy: z.enum(["day", "issue", "project", "billable"]),
      userId: z.string().optional(),
    }),
    async run(
      input: {
        from: Date;
        to: Date;
        groupBy: "day" | "issue" | "project" | "billable";
        userId?: string;
      },
      ctx: McpContext,
    ) {
      const userId = input.userId ?? (await resolveActorId(ctx));
      const entries = await db.timeEntry.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          startedAt: { gte: input.from, lte: input.to },
          endedAt: { not: null },
        },
        include: {
          issue: {
            select: {
              id: true,
              project: { select: { id: true } },
            },
          },
        },
      });
      const minutesBetween = (a: Date, b: Date) =>
        Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
      const amountFor = (minutes: number, rate?: number | null) =>
        !rate ? 0 : Math.round((minutes / 60) * rate * 100) / 100;
      const buckets = new Map<string, { key: string; minutes: number; billableAmount: number }>();
      let totalMinutes = 0;
      let totalBillableAmount = 0;
      for (const e of entries) {
        if (!e.endedAt) continue;
        const mins = minutesBetween(e.startedAt, e.endedAt);
        const amt = e.billable ? amountFor(mins, e.hourlyRate) : 0;
        totalMinutes += mins;
        totalBillableAmount += amt;
        let key: string;
        if (input.groupBy === "day") key = e.startedAt.toISOString().slice(0, 10);
        else if (input.groupBy === "issue") key = e.issue?.id ?? "unassigned";
        else if (input.groupBy === "project") key = e.issue?.project?.id ?? "unassigned";
        else key = e.billable ? "billable" : "non-billable";
        const bucket = buckets.get(key) ?? { key, minutes: 0, billableAmount: 0 };
        bucket.minutes += mins;
        bucket.billableAmount += amt;
        buckets.set(key, bucket);
      }
      return {
        totalMinutes,
        totalBillableAmount: Math.round(totalBillableAmount * 100) / 100,
        buckets: Array.from(buckets.values()).sort((a, b) => b.minutes - a.minutes),
      };
    },
  },

  // -------------------------------------------------------------- Attachments
  "attachments.initUpload": {
    scopes: ["WRITE_ISSUES"] as const,
    description: [
      "Start a file upload to a Forge entity. Two-step flow:",
      "  1. attachments.initUpload → { uploadUrl, attachmentId }",
      "  2. HTTP PUT the bytes directly to uploadUrl (Content-Type must match mimeType)",
      "  3. attachments.finalize → confirms the row.",
      "",
      `Allowed MIME types: ${[...ALLOWED_MIME_TYPES].sort().join(", ")}.`,
      `Allowed target types: ${[...ALLOWED_TARGET_TYPES].sort().join(", ")}.`,
      `Hard size cap: ${MAX_FILE_SIZE_BYTES} bytes (25 MB).`,
      "",
      "For URLs / external resources (Google Docs, GitHub PRs, Linear tickets, web pages),",
      "use attachments.attachLink instead — no upload needed.",
    ].join("\n"),
    input: z.object({
      targetType: z
        .string()
        .refine((v) => ALLOWED_TARGET_TYPES.has(v), {
          message: `targetType must be one of ${[...ALLOWED_TARGET_TYPES].join(", ")}`,
        })
        .describe(
          `One of ${[...ALLOWED_TARGET_TYPES].sort().join(", ")}. The Attachment will be attached to that entity.`,
        ),
      targetId: z.string().describe("Cuid of the target row in this workspace."),
      filename: z.string().min(1).max(255).describe("Original filename including extension."),
      mimeType: z
        .string()
        .refine((v) => ALLOWED_MIME_TYPES.has(v), {
          message: "mimeType not allowed",
        })
        .describe(
          `Declared MIME type. Must be in the allowlist: ${[...ALLOWED_MIME_TYPES].sort().join(", ")}.`,
        ),
      size: z
        .number()
        .int()
        .positive()
        .max(MAX_FILE_SIZE_BYTES)
        .describe(`Size in bytes. Hard cap: ${MAX_FILE_SIZE_BYTES} (25 MB).`),
    }),
    async run(
      input: {
        targetType: string;
        targetId: string;
        filename: string;
        mimeType: string;
        size: number;
      },
      ctx: McpContext,
    ) {
      if (input.targetType === "issue") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.targetId,
        });
      } else if (input.targetType === "project") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.targetId,
        });
      } else if (input.targetType === "initiative") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: input.targetId,
        });
      } else if (input.targetType === "chat-message") {
        await assertMcpChatMessageTarget(ctx, input.targetId);
      }
      const uploaderId = await resolveActorId(ctx);
      return presignUploadUrl({
        workspaceId: ctx.workspaceId,
        uploaderId,
        targetType: input.targetType,
        targetId: input.targetId,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
      });
    },
  },

  "attachments.finalize": {
    scopes: ["WRITE_ISSUES"] as const,
    description:
      "Step 3 of the upload flow. Call after the PUT to the presigned uploadUrl returns 200; flips the pending Attachment row to ready and emits ISSUE_UPDATED so plugins can react.",
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      return finalizeAttachment({
        attachmentId: input.attachmentId,
        workspaceId: ctx.workspaceId,
      });
    },
  },

  /**
   * Attach an external link as a first-class Attachment row. No bytes
   * uploaded, no MinIO object created. The row's `kind = LINK` and
   * `externalUrl` is the canonical pointer; `mimeType = "text/url"` so
   * the lightbox / chip surfaces can route on it.
   */
  "attachments.attachLink": {
    scopes: ["WRITE_ISSUES"] as const,
    description: [
      "Attach an external URL (Google Doc, GitHub PR, Linear ticket, web page, …)",
      "as a first-class Attachment row on a Forge entity. No bytes are uploaded —",
      "the URL is the entirety of the payload.",
      "",
      "Use this for any link to off-platform content. For uploading bytes (images,",
      "PDFs, text/html, JSON, audio, video, …) use attachments.initUpload.",
      "",
      `Allowed target types: ${[...ALLOWED_TARGET_TYPES].sort().join(", ")}.`,
    ].join("\n"),
    input: z.object({
      targetType: z
        .string()
        .refine((v) => ALLOWED_TARGET_TYPES.has(v), {
          message: `targetType must be one of ${[...ALLOWED_TARGET_TYPES].join(", ")}`,
        })
        .describe(
          `One of ${[...ALLOWED_TARGET_TYPES].sort().join(", ")}. The link Attachment will be attached to that entity.`,
        ),
      targetId: z.string().describe("Cuid of the target row in this workspace."),
      url: z
        .string()
        .max(2048)
        .refine(isSafeExternalUrl, { message: safeExternalUrlMessage() })
        .describe("Absolute http(s) URL to attach."),
      title: z
        .string()
        .max(255)
        .optional()
        .describe("Optional human label. Defaults to the URL hostname when omitted."),
    }),
    async run(
      input: {
        targetType: string;
        targetId: string;
        url: string;
        title?: string;
      },
      ctx: McpContext,
    ) {
      if (input.targetType === "issue") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.targetId,
        });
      } else if (input.targetType === "project") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.targetId,
        });
      } else if (input.targetType === "initiative") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: input.targetId,
        });
      } else if (input.targetType === "chat-message") {
        await assertMcpChatMessageTarget(ctx, input.targetId);
      }
      // If the caller didn't supply a label, try to scrape <title> from
      // the target page so the chip is meaningful out of the box. Fail
      // soft — createLinkAttachment falls back to hostname when title is
      // null/undefined.
      let resolvedTitle = input.title;
      const safeUrl = assertSafeExternalUrl(input.url);
      if (resolvedTitle === undefined) {
        const meta = await fetchLinkMetadata(safeUrl);
        resolvedTitle = meta.title;
      }
      return createLinkAttachment({
        workspaceId: ctx.workspaceId,
        targetType: input.targetType,
        targetId: input.targetId,
        url: safeUrl,
        title: resolvedTitle,
      });
    },
  },

  "attachments.list": {
    scopes: ["READ_ISSUES"] as const,
    description:
      "Returns finalized FILE attachments AND LINK attachments for the given target, oldest first. LINK rows have mimeType = 'text/url' and an `externalUrl` field; FILE rows have a real MIME type and a presigned URL is fetched separately via attachments.getDownloadUrl.",
    input: z.object({
      targetType: z.string().refine((v) => ALLOWED_TARGET_TYPES.has(v)),
      targetId: z.string(),
    }),
    async run(input: { targetType: string; targetId: string }, ctx: McpContext) {
      if (input.targetType === "issue") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.targetId,
        });
      } else if (input.targetType === "project") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: input.targetId,
        });
      } else if (input.targetType === "initiative") {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: input.targetId,
        });
      } else if (input.targetType === "chat-message") {
        await assertMcpChatMessageTarget(ctx, input.targetId);
      }
      return db.attachment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          NOT: { url: { startsWith: "pending:" } },
        },
        orderBy: { createdAt: "asc" },
      });
    },
  },

  "attachments.getDownloadUrl": {
    scopes: ["READ_ISSUES"] as const,
    description:
      "Returns a 15-minute presigned GET URL for a FILE attachment. For LINK attachments the row's `externalUrl` is the canonical pointer — call attachments.list and read it directly.",
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      const row = await db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: { id: true, targetType: true, targetId: true },
      });
      if (!row) throw new Error("Attachment not found.");
      if (row.targetType === "issue" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: row.targetId,
        });
      } else if (row.targetType === "chat-message" && row.targetId) {
        await assertMcpChatMessageTarget(ctx, row.targetId);
      }
      return presignDownloadUrl(input.attachmentId);
    },
  },

  "attachments.delete": {
    scopes: ["WRITE_ISSUES"] as const,
    description:
      "Permanently delete an Attachment row. For FILE rows the underlying object in MinIO is removed too; for LINK rows only the row is dropped (the external resource is untouched).",
    input: z.object({ attachmentId: z.string() }),
    async run(input: { attachmentId: string }, ctx: McpContext) {
      const row = await db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: { id: true, targetType: true, targetId: true },
      });
      if (!row) throw new Error("Attachment not found.");
      if (row.targetType === "issue" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: row.targetId,
        });
      } else if (row.targetType === "chat-message" && row.targetId) {
        await assertMcpChatMessageTarget(ctx, row.targetId);
      }
      await deleteAttachment(input.attachmentId);
      return { ok: true };
    },
  },

  /**
   * Server-side bytes fetch for an attachment, returned base64-encoded so
   * image-aware models can consume it inline (most MCP clients can't follow
   * a presigned URL out-of-band). Same scope checks as `getDownloadUrl`,
   * plus a small mime allowlist (image + pdf + text family) and a per-call
   * max bytes cap (default 1 MB, never above 25 MB) to keep MCP responses
   * bounded.
   */
  "attachments.getInline": {
    scopes: ["READ_ISSUES"] as const,
    description:
      "Fetch attachment bytes inline as base64. Allowed MIME: image/png, image/jpeg, image/gif, image/webp, application/pdf, text/plain, text/markdown, text/html, text/csv, text/xml, application/xml, application/json. Anything else: use attachments.getDownloadUrl. Max 25 MB; default 1 MB cap per call. Not for LINK attachments.",
    input: z.object({
      attachmentId: z.string(),
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(25 * 1024 * 1024)
        .default(1_000_000)
        .describe("Hard cap on bytes returned in the response. Defaults to 1 MB."),
    }),
    async run(input: { attachmentId: string; maxBytes: number }, ctx: McpContext) {
      const row = await db.attachment.findFirst({
        where: { id: input.attachmentId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          mimeType: true,
          targetType: true,
          targetId: true,
        },
      });
      if (!row) throw new Error("Attachment not found.");
      if (row.targetType === "issue" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: row.targetId,
        });
      } else if (row.targetType === "project" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "project",
          id: row.targetId,
        });
      } else if (row.targetType === "initiative" && row.targetId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "initiative",
          id: row.targetId,
        });
      } else if (row.targetType === "chat-message" && row.targetId) {
        await assertMcpChatMessageTarget(ctx, row.targetId);
      }
      // Narrow allowlist for inline reads — matches the storage allowlist
      // intersected with the MIME types most agents can actually consume
      // inline. Reject everything else with an explicit error so callers
      // know to fall back to `attachments.getDownloadUrl`.
      const INLINE_ALLOWED = new Set<string>([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/html",
        "text/csv",
        "text/xml",
        "application/xml",
        "application/json",
      ]);
      if (!INLINE_ALLOWED.has(row.mimeType)) {
        throw new Error(
          `Inline mime type ${row.mimeType} not supported; use attachments.getDownloadUrl.`,
        );
      }
      // Defensive intersection with the global allowlist — should always
      // hold since initUpload enforces it, but keeps this tool honest if
      // ALLOWED_MIME_TYPES ever expands.
      if (!ALLOWED_MIME_TYPES.has(row.mimeType)) {
        throw new Error(`Mime type ${row.mimeType} not allowed.`);
      }
      return getAttachmentInline(input.attachmentId, {
        maxBytes: input.maxBytes,
      });
    },
  },

  // -------------------------------------------------------------------- Pins
  // Backed by the polymorphic Pin table (migration 0023). The legacy
  // shape — flat ordered list of accessible Issue rows — is preserved
  // by filtering Pin to `workspaceId IS NULL, targetType = 'ISSUE'`,
  // which is what the cross-workspace topbar strip and Hermes consume.
  "pins.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_: unknown, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const pins = await db.pin.findMany({
        where: { userId, workspaceId: null, targetType: "ISSUE" },
        orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
        select: { targetId: true },
      });
      if (pins.length === 0) return [];
      const issues = await db.issue.findMany({
        where: {
          id: { in: pins.map((p) => p.targetId) },
          deletedAt: null,
          workspace: {
            deletedAt: null,
            memberships: { some: { userId } },
          },
        },
        select: {
          id: true,
          number: true,
          title: true,
          priority: true,
          workspace: { select: { id: true, slug: true, key: true, name: true } },
          status: {
            select: { id: true, name: true, color: true, category: true },
          },
        },
      });
      const byId = new Map(issues.map((i) => [i.id, i]));
      return pins
        .map((p) => byId.get(p.targetId))
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
    },
  },

  "pins.set": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueIds: z.array(z.string()).max(3).describe("Ordered list of pinned issue ids; max 3."),
    }),
    async run(input: { issueIds: string[] }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const ids = [...new Set(input.issueIds)];
      if (ids.length > 3) throw new Error("Max 3 pins.");
      if (ids.length > 0) {
        const count = await db.issue.count({
          where: {
            id: { in: ids },
            deletedAt: null,
            workspace: {
              deletedAt: null,
              memberships: { some: { userId } },
            },
          },
        });
        if (count !== ids.length) {
          throw new Error("One or more pinned issues are not accessible.");
        }
      }
      await db.$transaction(async (tx) => {
        await tx.pin.deleteMany({
          where: { userId, workspaceId: null, targetType: "ISSUE" },
        });
        if (ids.length > 0) {
          await tx.pin.createMany({
            data: ids.map((id, i) => ({
              userId,
              workspaceId: null,
              targetType: "ISSUE" as const,
              targetId: id,
              orderIndex: i,
            })),
          });
        }
      });
      return { pinnedIssueIds: ids };
    },
  },

  // --------------------------------------------------------------------- Agents
  // Self-management for a linked agent. Both tools resolve the caller to its
  // Agent row via `ctx.apiKey.linkedAgentId`; keys without a linked agent
  // have no identity to act on and are rejected.

  /**
   * List agents in the workspace (excludes archived by default). Powers
   * peer discovery — agents asking "who else can I hand off to" or runtime
   * daemons asking "what agents do I host" both consume this. Mirror of
   * `trpc.agent.list` shape (minus the heavy `_count` block) so UI and MCP
   * stay aligned.
   */
  "agents.list": {
    scopes: ["READ_USERS"] as const,
    input: z.object({
      includeArchived: z.boolean().default(false),
      runtimeId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "Filter to agents on a specific Runtime. Useful for daemons enumerating their own roster.",
        ),
    }),
    async run(input: { includeArchived: boolean; runtimeId?: string }, ctx: McpContext) {
      const rows = await db.agent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
          ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        },
        orderBy: [{ name: "asc" }, { profileKey: "asc" }],
        select: {
          id: true,
          name: true,
          profileKey: true,
        },
      });
      return mcpListEnvelope(rows);
    },
  },

  "agents.me": {
    scopes: ["READ_USERS"] as const,
    input: z
      .object({})
      .describe("Returns the Agent row linked to the calling API key (via linkedAgentId)."),
    async run(_input: Record<string, never>, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId;
      if (!agentId) {
        throw new Error("No agent inferred; use an API key with linkedAgentId set.");
      }
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: {
          id: true,
          profileKey: true,
          profileId: true,
          name: true,
          provider: true,
          runtimeMode: true,
          status: true,
          capabilities: true,
          webhookUrl: true,
          maxConcurrent: true,
          templateMarkdown: true,
          lastHeartbeatAt: true,
          lastDispatchedAt: true,
          workspaceId: true,
          archivedAt: true,
        },
      });
      if (!agent || agent.workspaceId !== ctx.workspaceId) {
        throw new Error("Agent not found in this workspace.");
      }
      // Surface the owning user's instance role (drives /admin + global
      // AgentProfile governance). Pulled from the API key's user so it's
      // available to the binding-level identity call too.
      const ownerId = ctx.apiKey?.userId ?? ctx.userId ?? null;
      const owner = ownerId
        ? await db.user.findUnique({
            where: { id: ownerId },
            select: { instanceRole: true },
          })
        : null;
      return { ...agent, instanceRole: owner?.instanceRole ?? null };
    },
  },

  "agents.heartbeat": {
    scopes: ["READ_USERS"] as const,
    input: z.object({
      status: z
        .nativeEnum(AgentStatus)
        .default(AgentStatus.ONLINE)
        .describe("Presence to set — ONLINE | BUSY | OFFLINE."),
    }),
    async run(input: { status: AgentStatus }, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId;
      if (!agentId) {
        throw new Error("No agent inferred; use an API key with linkedAgentId set.");
      }
      const existing = await db.agent.findUnique({
        where: { id: agentId },
        select: { workspaceId: true, archivedAt: true },
      });
      if (!existing || existing.workspaceId !== ctx.workspaceId) {
        throw new Error("Agent not found in this workspace.");
      }
      if (existing.archivedAt) {
        throw new Error("Agent is archived; cannot heartbeat.");
      }
      return db.agent.update({
        where: { id: agentId },
        data: { status: input.status, lastHeartbeatAt: new Date() },
        select: {
          id: true,
          profileKey: true,
          provider: true,
          runtimeMode: true,
          status: true,
          lastHeartbeatAt: true,
        },
      });
    },
  },

  // --------------------------------------------------------------------- Agent profiles
  // Global, user-owned agent *definitions* (`AgentProfile`) — the layer above
  // the per-workspace `Agent` *binding* (`Agent.profileId`). `agents.list`
  // above returns the bindings in the caller's workspace; these two tools
  // return the global profiles the caller can see: the ones they own (keyed
  // off the API key's user) plus instance-shared profiles published by an
  // instance admin. Read-only — profile create/approve flows stay in the UI.

  /**
   * List the global agent profiles visible to the authenticated key's owner:
   * profiles they own + instance-shared profiles. Approved profiles only by
   * default (pending profiles aren't bindable). Mirrors `agents.list` shape
   * (READ_USERS, list envelope) but reads the global `AgentProfile` table
   * rather than the per-workspace `Agent` binding.
   */
  "agents.profiles.list": {
    scopes: ["READ_USERS"] as const,
    input: z.object({
      includeArchived: z.boolean().default(false),
      includePending: z
        .boolean()
        .default(false)
        .describe("Include profiles awaiting instance-admin approval (approvedAt null)."),
      mine: z
        .boolean()
        .default(false)
        .describe(
          "Only profiles owned by the key's user (exclude instance-shared profiles owned by others).",
        ),
    }),
    async run(
      input: { includeArchived: boolean; includePending: boolean; mine: boolean },
      ctx: McpContext,
    ) {
      const ownerId = ctx.apiKey?.userId ?? ctx.userId ?? null;
      const owner = ownerId
        ? await db.user.findUnique({
            where: { id: ownerId },
            select: { instanceRole: true },
          })
        : null;
      const ownership: Prisma.AgentProfileWhereInput =
        input.mine || !ownerId
          ? { ownerId: ownerId ?? "__none__" }
          : { OR: [{ ownerId }, { instanceShared: true }] };
      const rows = await db.agentProfile.findMany({
        where: {
          AND: [
            ownership,
            input.includeArchived ? {} : { archivedAt: null },
            input.includePending ? {} : { approvedAt: { not: null } },
          ],
        },
        orderBy: [{ profileKey: "asc" }, { name: "asc" }],
        select: {
          id: true,
          ownerId: true,
          profileKey: true,
          name: true,
          provider: true,
          runEngine: true,
          runtimeMode: true,
          role: true,
          baseCapabilities: true,
          runtimeId: true,
          instanceShared: true,
          approvedAt: true,
          archivedAt: true,
          _count: { select: { bindings: true } },
        },
      });
      return {
        ...mcpListEnvelope(
          rows.map((r) => ({ ...r, mine: ownerId != null && r.ownerId === ownerId })),
        ),
        // Owner identity context — drives /admin gating + global profile
        // governance. `forge whoami` reads this to report the user's role
        // even when the key has no linkedAgentId.
        instanceRole: owner?.instanceRole ?? null,
      };
    },
  },

  /**
   * Fetch a single global agent profile by id or `profileKey`. Resolves
   * within the caller's visibility (owned + instance-shared). `profileKey`
   * resolution prefers the caller's own profile (it is unique per owner).
   */
  "agents.profiles.get": {
    scopes: ["READ_USERS"] as const,
    input: z
      .object({
        id: z.string().min(1).max(40).optional(),
        profileKey: z.string().min(1).max(120).optional(),
      })
      .refine((v) => Boolean(v.id || v.profileKey), {
        message: "Provide either id or profileKey.",
      }),
    async run(input: { id?: string; profileKey?: string }, ctx: McpContext) {
      const ownerId = ctx.apiKey?.userId ?? ctx.userId ?? null;
      const visibility: Prisma.AgentProfileWhereInput = ownerId
        ? { OR: [{ ownerId }, { instanceShared: true }] }
        : { instanceShared: true };
      const select = {
        id: true,
        ownerId: true,
        profileKey: true,
        name: true,
        description: true,
        avatar: true,
        provider: true,
        runEngine: true,
        runtimeMode: true,
        role: true,
        baseCapabilities: true,
        webhookUrl: true,
        runtimeId: true,
        templateMarkdown: true,
        instanceShared: true,
        disabledAt: true,
        approvedAt: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
        runtime: { select: { id: true, name: true, kind: true } },
        _count: { select: { bindings: true } },
      } satisfies Prisma.AgentProfileSelect;

      let row;
      if (input.id) {
        row = await db.agentProfile.findFirst({
          where: { AND: [{ id: input.id }, visibility] },
          select,
        });
      } else {
        // profileKey is unique per owner, so prefer the caller's own row,
        // then fall back to an instance-shared profile with that key.
        row = ownerId
          ? await db.agentProfile.findFirst({
              where: { ownerId, profileKey: input.profileKey! },
              select,
            })
          : null;
        if (!row) {
          row = await db.agentProfile.findFirst({
            where: { profileKey: input.profileKey!, instanceShared: true },
            select,
          });
        }
      }
      if (!row) throw new Error("Agent profile not found or not visible to this key.");
      return { ...row, mine: ownerId != null && row.ownerId === ownerId };
    },
  },

  // --------------------------------------------------------------------- Chat
  // Agent-side chat reply. Tied to the calling API key's linkedAgentId — the
  // agent can only reply in threads where it is the addressee, mirroring
  // the `chat.appendAgentMessage` tRPC mutation.
  //
  // Webhook flow: Forge fans out CHAT_MESSAGE_POSTED to the addressed
  // agent's webhook. The agent processes the message, generates a reply,
  // and calls this tool to commit it. Forge persists the reply, fans out
  // CHAT_MESSAGE_POSTED with role=AGENT, and the client picks it up via
  // realtime SSE — no separate streaming protocol needed for v1.

  /**
   * Read a chat thread + paginated history. Restricted to the addressed
   * agent — the calling API key's linkedAgentId must equal the thread's
   * agentId (same gating as the chat write tools). This unblocks the
   * "agent gets a single CHAT_MESSAGE_POSTED webhook but needs prior
   * messages for grounding" gap.
   */
  "chat.getThread": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z.string().min(1).max(40),
      before: z.coerce
        .date()
        .optional()
        .describe("Cursor — return messages strictly before this createdAt."),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    async run(input: { threadId: string; before?: Date; limit: number }, ctx: McpContext) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("chat.getThread requires an API key with linkedAgentId set.");
      }
      const thread = await db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          agentId: true,
          userId: true,
          title: true,
          topic: true,
          isDefault: true,
          contextMode: true,
          summaryMarkdown: true,
          summarizedUntilMessageId: true,
          summarizedAt: true,
          lastMessageAt: true,
          createdAt: true,
          archivedAt: true,
        },
      });
      if (!thread) throw new Error("Chat thread not found in this workspace.");
      if (thread.agentId !== linkedAgentId) {
        throw new Error("Only the thread's agent may read this thread.");
      }
      const messages = await db.chatMessage.findMany({
        where: {
          threadId: thread.id,
          OR: [{ role: { not: "USER" } }, { dispatchedAt: { not: null } }],
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          role: true,
          body: true,
          contextSnapshot: true,
          sourceRunId: true,
          createdAt: true,
        },
      });
      const attachmentMap = await loadChatAttachmentMap(
        ctx.workspaceId,
        messages.map((m) => m.id),
      );
      // Surface `finalizedDraftId` if the persisted message carried one in
      // its publish payload — the column itself isn't on ChatMessage, so we
      // omit unless callers reach further. For now, expose null.
      return {
        thread,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          body: m.body,
          contextSnapshot: m.contextSnapshot,
          sourceRunId: m.sourceRunId,
          createdAt: m.createdAt,
          finalizedDraftId: null as string | null,
          attachments: attachmentMap.get(m.id) ?? [],
        })),
      };
    },
  },

  "chat.appendMessage": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z
        .string()
        .min(1)
        .max(40)
        .describe("ChatThread.id from the inbound webhook payload."),
      body: z
        .string()
        .min(1)
        .max(16_000)
        .describe("Reply body. Markdown is rendered client-side; use fenced code blocks for code."),
      sourceRunId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "Optional AgentRun id to link the chat reply to a longer agent run for deep-linking.",
        ),
      replyToMessageId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("Exact inbound USER ChatMessage.id this reply satisfies."),
    }),
    async run(
      input: {
        threadId: string;
        body: string;
        sourceRunId?: string;
        replyToMessageId?: string;
      },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("chat.appendMessage requires an API key with linkedAgentId set.");
      }
      const thread = await db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new Error("Chat thread not found in this workspace.");
      if (thread.agentId !== linkedAgentId) {
        throw new Error("Only the thread's agent may post replies.");
      }
      return db.$transaction(async (tx) => {
        // Inbox lifecycle: an AGENT reply on the thread is the
        // canonical "this user turn is satisfied" signal. Mark the
        // most recent unfinished USER message as ack'd + output-
        // started so the chat UI clears its "wake sent" / typing
        // diagnostics in lock-step with the visible reply.
        const pendingUserMessage = await tx.chatMessage.findFirst({
          where: {
            threadId: thread.id,
            workspaceId: ctx.workspaceId,
            role: "USER",
            dispatchedAt: { not: null },
            ...(input.replyToMessageId
              ? { id: input.replyToMessageId }
              : { outputStartedAt: null }),
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, acknowledgedAt: true },
        });
        if (input.replyToMessageId && !pendingUserMessage) {
          throw new Error("Reply target was not found in this chat thread.");
        }
        if (pendingUserMessage) {
          const now = new Date();
          await tx.chatMessage.update({
            where: { id: pendingUserMessage.id },
            data: {
              acknowledgedAt: pendingUserMessage.acknowledgedAt ?? now,
              outputStartedAt: now,
            },
          });
        }
        const message = await tx.chatMessage.create({
          data: {
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: "AGENT",
            body: input.body,
            sourceRunId: input.sourceRunId ?? null,
            contextSnapshot: pendingUserMessage
              ? { replyToMessageId: pendingUserMessage.id }
              : undefined,
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: null,
          actorAgentId: linkedAgentId,
          entity: "ChatMessage",
          entityId: message.id,
          action: "create",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: thread.id,
          payload: {
            threadId: thread.id,
            messageId: message.id,
            agentId: thread.agentId,
            role: "AGENT",
            sourceRunId: input.sourceRunId ?? null,
          },
        });
        return { messageId: message.id, threadId: thread.id };
      });
    },
  },

  // ---------------------------------------------------------------- Chat streaming
  // Three-step streaming draft: startDraft → N×appendDraftChunk → finalizeDraft.
  // The draft is a durable AGENT placeholder from the first call onward.
  // Redis remains the low-latency fan-out, while the row lets reloads, late
  // subscribers, and other tabs recover the cumulative text and lease time.

  "chat.startDraft": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z
        .string()
        .min(1)
        .max(40)
        .describe("ChatThread.id from the inbound webhook payload."),
      replyToMessageId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe("Exact inbound USER ChatMessage.id this draft replies to."),
    }),
    async run(input: { threadId: string; replyToMessageId?: string }, ctx: McpContext) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("chat.startDraft requires an API key with linkedAgentId set.");
      }
      const thread = await db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new Error("Chat thread not found in this workspace.");
      if (thread.agentId !== linkedAgentId) {
        throw new Error("Only the thread's agent may stream replies.");
      }
      // Inbox lifecycle: a chat draft starting is the canonical
      // "agent picked up the wake" signal for chat threads. Bump
      // acknowledgedAt + outputStartedAt on the latest unfinished
      // USER message in this thread so the chat panel's typing
      // animation gets driven by canonical state instead of the
      // ambient draft chunk stream alone.
      const pendingUserMessage = await db.chatMessage.findFirst({
        where: {
          threadId: thread.id,
          workspaceId: ctx.workspaceId,
          role: "USER",
          dispatchedAt: { not: null },
          ...(input.replyToMessageId ? { id: input.replyToMessageId } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, acknowledgedAt: true, outputStartedAt: true },
      });
      if (!pendingUserMessage)
        throw new Error("No dispatched user turn is waiting in this thread.");

      const existingDraft = await db.chatMessage.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          role: "AGENT",
          contextSnapshot: { path: ["replyToMessageId"], equals: pendingUserMessage.id },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, body: true, contextSnapshot: true },
      });
      const existingContext =
        existingDraft?.contextSnapshot &&
        typeof existingDraft.contextSnapshot === "object" &&
        !Array.isArray(existingDraft.contextSnapshot)
          ? (existingDraft.contextSnapshot as Record<string, Prisma.JsonValue>)
          : null;
      if (existingDraft && existingContext?.running === true) {
        return { draftId: existingDraft.id, threadId: thread.id, recovered: true };
      }
      if (existingDraft) {
        throw new Error("The latest user turn already has a finalized reply.");
      }

      const now = new Date();
      if (!pendingUserMessage.outputStartedAt || !pendingUserMessage.acknowledgedAt) {
        await db.chatMessage.update({
          where: { id: pendingUserMessage.id },
          data: {
            acknowledgedAt: pendingUserMessage.acknowledgedAt ?? now,
            outputStartedAt: pendingUserMessage.outputStartedAt ?? now,
          },
        });
      }
      const draftId = nanoid();
      await db.chatMessage.create({
        data: {
          id: draftId,
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          role: "AGENT",
          body: "",
          contextSnapshot: {
            draft: true,
            draftId,
            running: true,
            status: "running",
            replyToMessageId: pendingUserMessage.id,
            startedAt: now.toISOString(),
            draftUpdatedAt: now.toISOString(),
            streamUpdatedAt: now.toISOString(),
            lastSeq: -1,
          },
        },
      });
      void publish({
        id: nanoid(),
        workspaceId: ctx.workspaceId,
        kind: EventKind.CHAT_MESSAGE_POSTED, // re-use the event channel
        subjectType: "chat-thread-stream", // discriminator for the client
        subjectId: thread.id,
        payload: {
          phase: "started",
          threadId: thread.id,
          agentId: thread.agentId,
          draftId,
          messageId: draftId,
          body: "",
          updatedAt: now.toISOString(),
        },
        actorId: null,
        createdAt: now.toISOString(),
      });
      void publish({
        id: nanoid(),
        workspaceId: ctx.workspaceId,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectType: "chat-thread-state",
        subjectId: thread.id,
        payload: {
          phase: "started",
          threadId: thread.id,
          messageId: draftId,
          draftId,
          updatedAt: now.toISOString(),
        },
        actorId: null,
        createdAt: now.toISOString(),
      });
      return { draftId, threadId: thread.id, recovered: false };
    },
  },

  "chat.appendDraftChunk": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z.string().min(1).max(40),
      draftId: z.string().min(1).max(40),
      delta: z
        .string()
        .min(1)
        .max(4_000)
        .describe(
          "Token delta to append. Caller is responsible for batching at a sane cadence (~60–200ms).",
        ),
      /** Optional cumulative index/sequence — purely advisory; client tolerates gaps. */
      seq: z.number().int().nonnegative().optional(),
    }),
    async run(
      input: { threadId: string; draftId: string; delta: string; seq?: number },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("chat.appendDraftChunk requires an API key with linkedAgentId set.");
      }
      const result = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.draftId}))`;
        const draft = await tx.chatMessage.findFirst({
          where: {
            id: input.draftId,
            threadId: input.threadId,
            workspaceId: ctx.workspaceId,
            role: "AGENT",
            thread: { agentId: linkedAgentId },
          },
          select: {
            id: true,
            body: true,
            contextSnapshot: true,
            thread: { select: { agentId: true } },
          },
        });
        if (!draft) throw new Error("Chat draft not found.");
        const snapshot =
          draft.contextSnapshot &&
          typeof draft.contextSnapshot === "object" &&
          !Array.isArray(draft.contextSnapshot)
            ? ({ ...draft.contextSnapshot } as Record<string, Prisma.JsonValue>)
            : {};
        if (snapshot.running !== true) throw new Error("Chat draft is no longer running.");
        const previousSeq = typeof snapshot.lastSeq === "number" ? snapshot.lastSeq : -1;
        if (input.seq !== undefined && input.seq <= previousSeq) {
          return { draft, body: draft.body, seq: previousSeq, duplicate: true };
        }
        const body = `${draft.body}${input.delta}`;
        if (body.length > 16_000) throw new Error("Chat draft exceeds 16000 chars.");
        const now = new Date().toISOString();
        await tx.chatMessage.update({
          where: { id: draft.id },
          data: {
            body,
            contextSnapshot: {
              ...snapshot,
              running: true,
              status: "running",
              partial_text: body,
              lastSeq: input.seq ?? previousSeq + 1,
              draftUpdatedAt: now,
              streamUpdatedAt: now,
            } as Prisma.InputJsonObject,
          },
        });
        return {
          draft,
          body,
          seq: input.seq ?? previousSeq + 1,
          duplicate: false,
        };
      });
      if (result.duplicate) return { ok: true, duplicate: true, seq: result.seq };
      const now = new Date().toISOString();
      void publish({
        id: nanoid(),
        workspaceId: ctx.workspaceId,
        kind: EventKind.CHAT_MESSAGE_POSTED,
        subjectType: "chat-thread-stream",
        subjectId: input.threadId,
        payload: {
          phase: "delta",
          threadId: input.threadId,
          agentId: result.draft.thread.agentId,
          draftId: input.draftId,
          messageId: input.draftId,
          delta: input.delta,
          body: result.body,
          seq: result.seq,
          updatedAt: now,
        },
        actorId: null,
        createdAt: now,
      });
      return { ok: true, duplicate: false, seq: result.seq };
    },
  },

  "chat.finalizeDraft": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z.string().min(1).max(40),
      draftId: z.string().min(1).max(40),
      body: z.string().min(1).max(16_000),
      sourceRunId: z.string().min(1).max(40).optional(),
    }),
    async run(
      input: { threadId: string; draftId: string; body: string; sourceRunId?: string },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("chat.finalizeDraft requires an API key with linkedAgentId set.");
      }
      const thread = await db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new Error("Chat thread not found in this workspace.");
      if (thread.agentId !== linkedAgentId) {
        throw new Error("Only the thread's agent may finalize a draft here.");
      }
      return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.draftId}))`;
        const durableDraft = await tx.chatMessage.findFirst({
          where: {
            id: input.draftId,
            workspaceId: ctx.workspaceId,
            threadId: thread.id,
            role: "AGENT",
          },
          select: { id: true, body: true, contextSnapshot: true },
        });
        const durableSnapshot =
          durableDraft?.contextSnapshot &&
          typeof durableDraft.contextSnapshot === "object" &&
          !Array.isArray(durableDraft.contextSnapshot)
            ? (durableDraft.contextSnapshot as Record<string, Prisma.JsonValue>)
            : {};
        if (durableDraft && durableSnapshot.running === false) {
          return {
            messageId: durableDraft.id,
            threadId: thread.id,
            draftId: input.draftId,
            duplicate: true,
          };
        }

        // Inbox lifecycle: finalizing a draft is a definitive
        // "user turn satisfied" — mirror the single-shot
        // chat.appendMessage path so canonical state stays in sync. A newer
        // user turn may arrive while this draft is streaming, so acknowledge
        // the exact turn captured by startDraft rather than whichever USER row
        // happens to be newest at finalize time.
        const replyToMessageId =
          typeof durableSnapshot.replyToMessageId === "string"
            ? durableSnapshot.replyToMessageId
            : null;
        const pendingUserMessage = await tx.chatMessage.findFirst({
          where: {
            threadId: thread.id,
            workspaceId: ctx.workspaceId,
            role: "USER",
            dispatchedAt: { not: null },
            ...(replyToMessageId ? { id: replyToMessageId } : {}),
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, acknowledgedAt: true, outputStartedAt: true },
        });
        if (pendingUserMessage) {
          const now = new Date();
          await tx.chatMessage.update({
            where: { id: pendingUserMessage.id },
            data: {
              acknowledgedAt: pendingUserMessage.acknowledgedAt ?? now,
              outputStartedAt: pendingUserMessage.outputStartedAt ?? now,
            },
          });
        }
        const finishedAt = new Date().toISOString();
        const message = durableDraft
          ? await tx.chatMessage.update({
              where: { id: durableDraft.id },
              data: {
                body: input.body,
                sourceRunId: input.sourceRunId ?? null,
                contextSnapshot: {
                  ...durableSnapshot,
                  draft: true,
                  partial_text: input.body,
                  running: false,
                  status: "completed",
                  replyToMessageId: pendingUserMessage?.id,
                  finishedAt,
                  draftUpdatedAt: finishedAt,
                  streamUpdatedAt: finishedAt,
                } as Prisma.InputJsonObject,
              },
            })
          : await tx.chatMessage.create({
              data: {
                workspaceId: ctx.workspaceId,
                threadId: thread.id,
                role: "AGENT",
                body: input.body,
                sourceRunId: input.sourceRunId ?? null,
                contextSnapshot: {
                  draft: true,
                  running: false,
                  status: "completed",
                  finishedAt,
                  streamUpdatedAt: finishedAt,
                },
              },
            });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: null,
          actorAgentId: linkedAgentId,
          entity: "ChatMessage",
          entityId: message.id,
          action: "create",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: thread.id,
          payload: {
            threadId: thread.id,
            messageId: message.id,
            agentId: thread.agentId,
            role: "AGENT",
            sourceRunId: input.sourceRunId ?? null,
            // Carry the draftId so the client can swap its draft bubble for
            // the persisted message without flicker.
            finalizedDraftId: input.draftId,
          },
        });
        // Also publish a stream-finalized event so clients listening on the
        // chat-thread-stream channel know to dispose the draft bubble.
        void publish({
          id: nanoid(),
          workspaceId: ctx.workspaceId,
          kind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread-stream",
          subjectId: thread.id,
          payload: {
            phase: "finalized",
            threadId: thread.id,
            agentId: thread.agentId,
            draftId: input.draftId,
            messageId: message.id,
            body: input.body,
            updatedAt: finishedAt,
          },
          actorId: null,
          createdAt: finishedAt,
        });
        void publish({
          id: nanoid(),
          workspaceId: ctx.workspaceId,
          kind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread-state",
          subjectId: thread.id,
          payload: {
            phase: "completed",
            threadId: thread.id,
            messageId: message.id,
            draftId: input.draftId,
          },
          actorId: null,
          createdAt: finishedAt,
        });
        return {
          messageId: message.id,
          threadId: thread.id,
          draftId: input.draftId,
          duplicate: false,
        };
      });
    },
  },

  // --------------------------------------------------------------------- Runtimes
  // Runtime as a first-class primitive — see PLAN.md "Runtime model".
  // `forge daemon` registers a LOCAL_DAEMON on start, then heartbeats
  // every 60s. Hermes-style integrations register a REMOTE_HTTP runtime
  // when their endpoint is provisioned.

  /**
   * List runtimes (mirror of `trpc.runtime.list`). ADMIN-scoped — same as
   * `runtimes.register` / `runtimes.heartbeat`. Used by the `forge` CLI's
   * `runtimes list` subcommand and by daemons enumerating peers.
   */
  "runtimes.list": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      kind: z
        .nativeEnum(RuntimeKind)
        .optional()
        .describe("Optional filter — LOCAL_DAEMON | REMOTE_HTTP | CLOUD."),
      includeArchived: z.boolean().default(false),
    }),
    async run(input: { kind?: RuntimeKind; includeArchived: boolean }, ctx: McpContext) {
      const rows = await db.runtime.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        select: {
          id: true,
          workspaceId: true,
          name: true,
          kind: true,
          adapterKey: true,
          endpoint: true,
          secret: true,
          providersAvailable: true,
          connectedAt: true,
          ownerKeyPrefix: true,
          ownerId: true,
          instanceShared: true,
          archivedAt: true,
          disabledAt: true,
          config: true,
          heartbeatAt: true,
          runtimeInfo: true,
          lastInfoAt: true,
          createdAt: true,
          updatedAt: true,
          owner: { select: { id: true, name: true, image: true } },
          _count: { select: { agents: true } },
        },
      });
      return rows.map(({ secret, ...row }) => ({
        ...row,
        hasSecret: !!secret,
        runtimeInfoSummary: summarizeRuntimeInfo(row),
      }));
    },
  },

  "runtimes.register": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe(
          "Display name. Defaults at the daemon to os.hostname(); REMOTE_HTTP integrations pick whatever the operator wants.",
        ),
      kind: z.nativeEnum(RuntimeKind).describe("LOCAL_DAEMON | REMOTE_HTTP | CLOUD."),
      endpoint: z
        .string()
        .url()
        .max(500)
        .optional()
        .describe(
          "Webhook URL for REMOTE_HTTP. Omit / null for LOCAL_DAEMON (the daemon polls Forge via SSE).",
        ),
      providersAvailable: z
        .array(z.nativeEnum(AgentProvider))
        .max(16)
        .default([])
        .describe(
          "Provider CLIs the runtime can host. The daemon reports these from PATH detection; REMOTE_HTTP runtimes set whatever their integration supports.",
        ),
      info: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional sanitized runtime metadata such as runtimeVersion, bridgeVersion, codexVersion, containerImage, hostname, os, arch, and workspaceRoot.",
        ),
    }),
    async run(
      input: {
        name: string;
        kind: RuntimeKind;
        endpoint?: string;
        providersAvailable: AgentProvider[];
        info?: Record<string, unknown>;
      },
      ctx: McpContext,
    ) {
      // ownerId attribution: prefer the user the API key belongs to,
      // otherwise fall back to null. AGENT-kind keys often have no
      // userId; treating that as "owned by the workspace" is correct.
      const ownerId = ctx.apiKey?.userId ?? ctx.userId ?? null;
      const now = new Date();
      return db.runtime.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          kind: input.kind,
          endpoint: input.endpoint || null,
          providersAvailable: input.providersAvailable,
          ownerId,
          // ownerKeyPrefix is left null from MCP — set later via the
          // tRPC `runtime.update` path or backfilled from `ApiKey.prefix`
          // by a follow-up sweep when we wire the daemon's auth flow.
          ownerKeyPrefix: null,
          connectedAt: input.kind === RuntimeKind.LOCAL_DAEMON ? now : null,
          heartbeatAt: input.kind === RuntimeKind.LOCAL_DAEMON ? now : null,
          ...(input.info ? runtimeInfoCreateData(input.info, now) : {}),
        },
        select: {
          id: true,
          name: true,
          kind: true,
          endpoint: true,
          providersAvailable: true,
          ownerId: true,
          connectedAt: true,
          heartbeatAt: true,
          runtimeInfo: true,
          lastInfoAt: true,
          createdAt: true,
        },
      });
    },
  },

  "runtimes.heartbeat": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      runtimeId: z.string().min(1).max(40).describe("Runtime.id returned from runtimes.register."),
      info: z
        .record(z.unknown())
        .optional()
        .describe("Optional sanitized runtime metadata reported with this heartbeat."),
    }),
    async run(input: { runtimeId: string; info?: Record<string, unknown> }, ctx: McpContext) {
      const row = await db.runtime.findFirst({
        where: { id: input.runtimeId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (!row) throw new Error("Runtime not found in this workspace.");
      if (row.archivedAt) throw new Error("Runtime is archived; cannot heartbeat.");
      const now = new Date();
      return db.runtime.update({
        where: { id: row.id },
        data: {
          heartbeatAt: now,
          ...(input.info ? runtimeInfoUpdateData(input.info, now) : {}),
        },
        select: { id: true, heartbeatAt: true, runtimeInfo: true, lastInfoAt: true },
      });
    },
  },

  "runtimes.reportInfo": {
    scopes: [] as const,
    input: z.object({
      runtimeId: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "Optional Runtime.id. When omitted, Forge uses the calling linked agent's runtime.",
        ),
      info: z
        .record(z.unknown())
        .describe(
          "Runtime metadata. Forge stores a sanitized whitelist: versions, bridge/container/build/host fields, workspaceRoot, and details.",
        ),
    }),
    async run(input: { runtimeId?: string; info: Record<string, unknown> }, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId;
      if (!agentId) {
        throw new Error("runtimes.reportInfo requires an agent-linked API key.");
      }
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId: ctx.workspaceId },
        select: { id: true, runtimeId: true },
      });
      if (!agent?.runtimeId) {
        throw new Error(
          "The calling agent has no runtime attached; attach one before reporting info.",
        );
      }
      if (input.runtimeId && input.runtimeId !== agent.runtimeId) {
        throw new Error("A linked-agent key can only report info for its own runtime.");
      }
      const runtime = await db.runtime.findFirst({
        where: { id: agent.runtimeId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true },
      });
      if (!runtime) throw new Error("Runtime not found in this workspace.");
      if (runtime.archivedAt)
        throw new Error("Runtime is archived; restore it before reporting info.");

      const sanitized = sanitizeRuntimeInfo(input.info);
      if (!sanitized) {
        throw new Error(
          "No supported runtime info fields were provided. Include fields such as runtimeVersion, bridgeVersion, codexVersion, containerImage, hostname, os, arch, or workspaceRoot.",
        );
      }
      const now = new Date();
      const updated = await db.runtime.update({
        where: { id: runtime.id },
        data: { runtimeInfo: sanitized, lastInfoAt: now },
        select: { id: true, runtimeInfo: true, lastInfoAt: true },
      });
      return {
        runtimeId: updated.id,
        recordedAt: updated.lastInfoAt,
        runtimeInfo: updated.runtimeInfo,
        runtimeInfoSummary: summarizeRuntimeInfo(updated),
      };
    },
  },

  "runtimes.configure": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      runtimeId: z.string().min(1).max(40).describe("Runtime.id to configure."),
      config: z
        .record(z.unknown())
        .describe(
          "Adapter config object. Hermes accepts localWorkspaceTools, toolCapabilities, and workspaceRoot.",
        ),
      merge: z
        .boolean()
        .default(true)
        .describe("Merge with existing config before validating. Defaults to true."),
    }),
    async run(
      input: { runtimeId: string; config: Record<string, unknown>; merge: boolean },
      ctx: McpContext,
    ) {
      const row = await db.runtime.findFirst({
        where: { id: input.runtimeId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          adapterKey: true,
          config: true,
          archivedAt: true,
        },
      });
      if (!row) throw new Error("Runtime not found in this workspace.");
      if (row.archivedAt) throw new Error("Runtime is archived; restore it before configuring.");
      const current =
        row.config && typeof row.config === "object" && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      const next = input.merge ? { ...current, ...input.config } : input.config;
      const validated = validateRuntimeConfig(row.adapterKey, next);
      return db.runtime.update({
        where: { id: row.id },
        data: { config: validated },
        select: {
          id: true,
          name: true,
          adapterKey: true,
          config: true,
          updatedAt: true,
        },
      });
    },
  },

  // --------------------------------------------------------------------- Runtime deregister
  // Archive (deregister) a runtime — the teardown counterpart of
  // `runtimes.register`. A local daemon calls this on shutdown so its
  // LOCAL_DAEMON runtime stops showing as live; `register` reuses/unarchives
  // the row on next start. Archived runtimes drop out of the runtimes list.
  "runtimes.archive": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      runtimeId: z.string().min(1).max(40).describe("Runtime.id to archive (deregister)."),
    }),
    async run(input: { runtimeId: string }, ctx: McpContext) {
      const row = await db.runtime.findFirst({
        where: { id: input.runtimeId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true, archivedAt: true },
      });
      if (!row) throw new Error("Runtime not found in this workspace.");
      if (row.archivedAt) {
        return { id: row.id, name: row.name, alreadyArchived: true };
      }
      await db.runtime.update({
        where: { id: row.id },
        data: { archivedAt: new Date() },
      });
      return { id: row.id, name: row.name, alreadyArchived: false };
    },
  },

  // --------------------------------------------------------------------- Runtime self-provisioning
  // The runtime (authenticating with an agent-linked API key) fetches the
  // DECRYPTED secrets + repo bindings for ITS OWN runtime so it can export
  // env, set up gh/git auth, and clone-or-pull repos before the agent's turn.
  // Linked-agent-required (mcp-policy) and strictly scoped to the agent's
  // runtime — a key for agent A can never read agent B's runtime secrets.
  // No PluginScope ceiling (the linked-agent gate is the real control), so a
  // narrowly-scoped runtime key can still self-provision.
  "runtimes.provisioning": {
    scopes: [] as const,
    input: z
      .object({})
      .describe("Returns decrypted secrets + repo bindings for the calling agent's runtime."),
    async run(_input: Record<string, never>, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId;
      if (!agentId) {
        throw new Error("runtimes.provisioning requires an agent-linked API key.");
      }
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId: ctx.workspaceId },
        select: { id: true, runtimeId: true },
      });
      if (!agent?.runtimeId) {
        throw new Error(
          "The calling agent has no runtime attached; attach one before provisioning.",
        );
      }
      const runtime = await db.runtime.findFirst({
        where: { id: agent.runtimeId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          workspaceId: true,
          config: true,
          secrets: { select: { key: true, valueEnc: true }, orderBy: { key: "asc" } },
          repos: {
            select: { url: true, branch: true, path: true },
            orderBy: { path: "asc" },
          },
          githubApp: {
            select: { id: true, appId: true, installationId: true, privateKeyEnc: true },
          },
        },
      });
      if (!runtime) throw new Error("Runtime not found.");

      const cfg =
        runtime.config && typeof runtime.config === "object" && !Array.isArray(runtime.config)
          ? (runtime.config as Record<string, unknown>)
          : {};

      const secrets: Array<{ key: string; value: string }> = [];
      for (const s of runtime.secrets) {
        try {
          secrets.push({ key: s.key, value: decryptSecret(s.valueEnc) });
        } catch {
          // A value that can't be decrypted (e.g. AUTH_SECRET was rotated) is
          // skipped rather than failing the whole provision; re-enter it.
        }
      }

      // Repos to materialize: the runtime's own bindings PLUS each project's
      // bound repo in this workspace (per-project repos let one runtime serve
      // many codebases — an agent dispatched to any project's issue lands in
      // the right checkout). Runtime bindings win on a path collision.
      const projectRepos = await db.project.findMany({
        where: { workspaceId: runtime.workspaceId, deletedAt: null, repoUrl: { not: null } },
        select: { repoUrl: true, repoBranch: true },
      });
      const repos: Array<{ url: string; branch: string | null; path: string }> = [...runtime.repos];
      const seenPaths = new Set(repos.map((r) => r.path));
      for (const p of projectRepos) {
        if (!p.repoUrl) continue;
        const path = deriveRepoPath(p.repoUrl);
        if (!path || seenPaths.has(path)) continue;
        seenPaths.add(path);
        repos.push({ url: p.repoUrl, branch: p.repoBranch ?? null, path });
      }
      repos.sort((a, b) => a.path.localeCompare(b.path));

      // If a GitHub App is linked, mint a short-lived installation token and
      // inject it as GH_TOKEN — superseding any static GH_TOKEN secret so the
      // managed path wins. The minted token never persists; mint failures are
      // recorded for the UI but don't break the rest of provisioning. Skipped
      // when the app isn't installed yet (no installation id → can't mint).
      let githubAppTokenExpiresAt: string | null = null;
      const app = runtime.githubApp;
      if (app?.installationId) {
        try {
          const token = await getInstallationTokenForApp(app.id, {
            appId: app.appId,
            installationId: app.installationId,
            privateKeyPem: decryptSecret(app.privateKeyEnc),
          });
          const withoutStatic = secrets.filter((s) => s.key !== "GH_TOKEN");
          withoutStatic.push({ key: "GH_TOKEN", value: token.token });
          secrets.length = 0;
          secrets.push(...withoutStatic);
          githubAppTokenExpiresAt = token.expiresAt;
          db.githubApp
            .update({ where: { id: app.id }, data: { lastMintedAt: new Date(), lastError: null } })
            .catch(() => {});
        } catch (e) {
          const message = e instanceof Error ? e.message : "GitHub App token mint failed.";
          db.githubApp
            .update({ where: { id: app.id }, data: { lastError: message } })
            .catch(() => {});
        }
      }

      return {
        runtimeId: runtime.id,
        runtimeName: runtime.name,
        workspaceRoot: typeof cfg.workspaceRoot === "string" ? cfg.workspaceRoot : null,
        secrets,
        repos,
        githubAppTokenExpiresAt,
      };
    },
  },

  // --------------------------------------------------------------------- Agent opens a run on itself
  // Lets an agent (a linked-agent key — e.g. a local CLI session) proactively
  // open a tracked AgentRun on an issue it's working, instead of only getting
  // one as a dispatch side-effect. Reuses openOrTouchRun, so it resumes an
  // existing ACTIVE/WAITING run for (issue, agent) rather than stacking a
  // duplicate, and stamps the STARTED event so it shows in Mission Control.
  // Issue-anchored by design; drive it afterward with runs.recordUsage /
  // runs.setWaiting / runs.complete.
  "runs.open": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().min(1).max(40).describe("Issue this run is doing work on."),
      summary: z
        .string()
        .max(2_000)
        .optional()
        .describe("Optional first step / what you're about to do (shown as currentStep)."),
      mode: z
        .enum(["EXECUTE", "RESEARCH", "REVIEW", "DISCUSS"])
        .optional()
        .describe("Engagement mode for this run (default EXECUTE)."),
    }),
    async run(
      input: {
        issueId: string;
        summary?: string;
        mode?: "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS";
      },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error(
          "runs.open requires an API key with linkedAgentId set (an agent opening a run on itself).",
        );
      }
      const issue = await db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) throw new Error("Issue not found in this workspace.");
      const { run, isNew } = await db.$transaction((tx) =>
        openOrTouchRun(tx, {
          workspaceId: ctx.workspaceId,
          issueId: issue.id,
          agentId: linkedAgentId,
          actorId: ctx.userId ?? null,
          actorAgentId: linkedAgentId,
          engagementMode: (input.mode as EngagementMode | undefined) ?? "EXECUTE",
          currentStep: input.summary ?? "opened by agent",
        }),
      );
      return { runId: run.id, isNew, status: run.status, issueId: issue.id };
    },
  },

  // --------------------------------------------------------------------- Agent run usage
  // Token / cost telemetry for an in-flight or completed AgentRun.
  // Idempotent: latest call replaces the prior values, so agents send
  // running totals (not deltas). Validates that the calling key's
  // linkedAgentId owns the run so a key for agent A can't accidentally
  // overwrite a run for agent B.

  "runs.recordUsage": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      runId: z
        .string()
        .min(1)
        .max(40)
        .describe("AgentRun.id (from comments.upsertStatus / openOrTouchRun)."),
      tokensIn: z.number().int().nonnegative().optional(),
      tokensOut: z.number().int().nonnegative().optional(),
      tokensCached: z.number().int().nonnegative().optional(),
      costUsd: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "USD cost the agent attributes to the run, e.g. 0.0123. Stored as Decimal(10,4).",
        ),
    }),
    async run(
      input: {
        runId: string;
        tokensIn?: number;
        tokensOut?: number;
        tokensCached?: number;
        costUsd?: number;
      },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("runs.recordUsage requires an API key with linkedAgentId set.");
      }
      const run = await db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          agentId: true,
          costUsd: true,
          workspaceId: true,
          issueId: true,
          status: true,
          externalRunId: true,
          startedAt: true,
          completionMeta: true,
          workspace: { select: RUN_BUDGET_WORKSPACE_SELECT },
          agent: {
            select: {
              provider: true,
              runtime: {
                select: {
                  adapterKey: true,
                  endpoint: true,
                  secret: true,
                  config: true,
                  disabledAt: true,
                  name: true,
                },
              },
            },
          },
        },
      });
      if (!run) throw new Error("AgentRun not found in this workspace.");
      if (run.agentId !== linkedAgentId) {
        throw new Error("AgentRun belongs to a different agent than the calling key.");
      }
      const data: Prisma.AgentRunUpdateManyMutationInput = {};
      if (input.tokensIn !== undefined) data.tokensIn = input.tokensIn;
      if (input.tokensOut !== undefined) data.tokensOut = input.tokensOut;
      if (input.tokensCached !== undefined) data.tokensCached = input.tokensCached;
      if (input.costUsd !== undefined) data.costUsd = input.costUsd;
      // Compute the cost delta atomically: lock the run row (SELECT … FOR
      // UPDATE) inside the same tx as the update so a concurrent recordUsage
      // can't read the same `prev` and double-count against the plan budget.
      // recordUsage is replace-not-add for the run, so the plan gets prev→new.
      let costDelta = 0;
      const updated = await db.$transaction(async (tx) => {
        if (input.costUsd !== undefined) {
          const locked = await tx.$queryRaw<Array<{ costUsd: Prisma.Decimal | null }>>`
            SELECT "costUsd" FROM "AgentRun" WHERE id = ${run.id} FOR UPDATE`;
          const prev = locked[0]?.costUsd != null ? Number(locked[0].costUsd) : 0;
          costDelta = Number(input.costUsd) - prev;
        }
        return tx.agentRun.update({
          where: { id: run.id },
          data,
          select: {
            id: true,
            tokensIn: true,
            tokensOut: true,
            tokensCached: true,
            costUsd: true,
          },
        });
      });
      // Budget watchdog: when this run finished a plan step, fold the cost
      // delta into the plan + goal totals and BLOCK + open a gate if a cap is
      // now breached. Runs after the tx commits (releases the row lock) so the
      // plan-increment tx can't deadlock against it.
      if (input.costUsd !== undefined && costDelta !== 0) {
        const { applyRunCostToPlan } = await import("@/server/services/orchestration-service");
        await applyRunCostToPlan(db, {
          workspaceId: ctx.workspaceId,
          runId: run.id,
          costDelta,
        });
      }
      // P0-2 run budget: after recording usage, pause/stop a runaway run
      // cleanly. Best-effort — never fail the usage write the agent's loop
      // depends on. The connector lets us actually stop provider spend.
      try {
        if (run.status === AgentRunStatus.ACTIVE && hasAnyBudget(run.workspace)) {
          const connector = getRunsConnectorForAgent({
            provider: run.agent.provider,
            runtime: run.agent.runtime,
          });
          await enforceRunBudget({
            run: {
              id: run.id,
              workspaceId: run.workspaceId,
              issueId: run.issueId,
              agentId: run.agentId,
              status: AgentRunStatus.ACTIVE,
              externalRunId: run.externalRunId,
              completionMeta: run.completionMeta,
              startedAt: run.startedAt,
              tokensIn: updated.tokensIn,
              tokensOut: updated.tokensOut,
              costUsd: updated.costUsd,
            },
            limits: run.workspace,
            connector,
          });
        }
      } catch (err) {
        logger.warn({ err, runId: run.id }, "runs.recordUsage: budget enforcement failed");
      }
      return updated;
    },
  },

  /**
   * Wave 5: structured completion submission. The agent calls this once
   * at the end of a run with the deliverables that satisfy the issue's
   * completion contract:
   *   - `summary`           — markdown explaining what was done
   *   - `producedArtifactIds` — Artifact rows the agent created/updated
   *   - `verificationResult` — checklist snapshot with `done` flags
   *   - `followUps`         — array of follow-up items the operator can
   *                            triage later
   *
   * `runs.complete` is the agent-owned lifecycle close for issue runs:
   * it stores the completion contract fields, marks the AgentRun
   * COMPLETED with `finishedAt`, and emits the standard
   * AGENT_RUN_COMPLETED audit/activity event via `finishRun()`. For
   * Research/Review/Discuss the issue itself is not transitioned — an
   * agent can finish its response on an issue that should remain open.
   * For EXECUTE, if the workspace has `reviewStatusId` configured, a
   * successful completion auto-transitions the issue to that IN_REVIEW
   * status (`maybeAutoTransitionOnComplete`) — completing EXECUTE work is
   * a "ready for human review" signal, never a "mark done" signal.
   */
  "runs.complete": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      runId: z.string().min(1).max(40),
      summary: z.string().max(50_000).optional(),
      producedArtifactIds: z.array(z.string().cuid()).max(50).optional(),
      verificationResult: z
        .array(
          z.object({
            id: z.string().min(1).optional(),
            label: z.string().min(1).max(500),
            kind: z.enum(["manual", "command", "artifact"]).optional(),
            value: z.string().max(2_000).optional(),
            done: z.boolean(),
          }),
        )
        .max(50)
        .optional(),
      followUps: z
        .array(
          z.object({
            title: z.string().min(1).max(300),
            body: z.string().max(5_000).optional(),
            kind: z.string().max(40).optional(),
          }),
        )
        .max(20)
        .optional(),
      confidence: z.enum(RUN_COMPLETION_CONFIDENCE_VALUES).optional(),
      verdict: z.enum(RUN_REVIEW_VERDICT_VALUES).optional(),
    }),
    async run(
      input: {
        runId: string;
        summary?: string;
        producedArtifactIds?: string[];
        verificationResult?: Array<{
          id?: string;
          label: string;
          kind?: "manual" | "command" | "artifact";
          value?: string;
          done: boolean;
        }>;
        followUps?: Array<{ title: string; body?: string; kind?: string }>;
        confidence?: RunCompletionConfidence;
        verdict?: RunReviewVerdict;
      },
      ctx: McpContext,
    ) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("runs.complete requires an API key with linkedAgentId set.");
      }
      const run = await db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          agentId: true,
          issueId: true,
          status: true,
          engagementMode: true,
          executionStepId: true,
          issue: {
            select: {
              expectedOutput: true,
              verificationChecklist: true,
              artifactRequired: true,
            },
          },
        },
      });
      if (!run) throw new Error("AgentRun not found in this workspace.");
      if (run.agentId !== linkedAgentId) {
        throw new Error("AgentRun belongs to a different agent than the calling key.");
      }
      if (run.status !== AgentRunStatus.ACTIVE && run.status !== AgentRunStatus.WAITING) {
        throw new Error(`Run is ${run.status}; only ACTIVE / WAITING runs can be completed.`);
      }
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: run.issueId });

      let issueLinkedArtifactIds = new Set<string>();
      // Validate every producedArtifactId belongs to this workspace.
      if (input.producedArtifactIds?.length) {
        const found = await db.artifact.findMany({
          where: {
            id: { in: input.producedArtifactIds },
            workspaceId: ctx.workspaceId,
          },
          select: { id: true, issueId: true, sourceType: true, sourceId: true },
        });
        if (found.length !== input.producedArtifactIds.length) {
          throw new Error("One or more producedArtifactIds not found in this workspace.");
        }
        issueLinkedArtifactIds = new Set(
          found
            .filter(
              (artifact) =>
                artifact.issueId === run.issueId ||
                (artifact.sourceType === "issue" && artifact.sourceId === run.issueId),
            )
            .map((artifact) => artifact.id),
        );
      }
      const completionErrors = validateRunCompletion({
        mode: run.engagementMode,
        issue: run.issue,
        completion: input,
        issueLinkedArtifactIds,
      });
      if (completionErrors.length > 0) {
        throw new Error(
          `Run completion does not satisfy ${run.engagementMode}: ${completionErrors.join(" ")}`,
        );
      }

      const completionMeta = runCompletionMeta(run.engagementMode, input);
      const data: Prisma.AgentRunUpdateInput = {};
      if (input.summary !== undefined) data.summary = input.summary;
      if (input.producedArtifactIds !== undefined) {
        data.producedArtifactIds = input.producedArtifactIds;
      }
      if (input.verificationResult !== undefined) {
        data.verificationResult = input.verificationResult as Prisma.InputJsonValue;
      }
      if (input.followUps !== undefined) {
        data.followUps = input.followUps as Prisma.InputJsonValue;
      }
      data.completionMeta = completionMeta as Prisma.InputJsonValue;
      const completed = await db.$transaction(async (tx) => {
        const updated = await tx.agentRun.updateMany({
          where: {
            id: run.id,
            workspaceId: ctx.workspaceId,
            agentId: linkedAgentId,
            status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
          },
          data,
        });
        if (updated.count !== 1) {
          throw new Error("Run is no longer active; completion was not applied.");
        }

        // Close the lifecycle row through the shared service so the
        // active-run strip/inbox stop treating a completed no-op response
        // as idle work, while preserving audit + ActivityEvent fan-out.
        await finishRun(tx, {
          runId: run.id,
          workspaceId: ctx.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "COMPLETED",
          summary: input.summary,
          actorId: ctx.userId,
          actorAgentId: linkedAgentId ?? null,
        });
        // A genuinely successful EXECUTE completion (this path only, not
        // abandons/stops that also emit AGENT_RUN_COMPLETED elsewhere) is a
        // "ready for review" signal when the workspace opted in.
        await maybeAutoTransitionOnComplete(tx, ctx.workspaceId, run.issueId, run.engagementMode);
        if (run.executionStepId) {
          await handoffCompletedRunToStep(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId,
            actorAgentId: linkedAgentId,
            runId: run.id,
            stepId: run.executionStepId,
          });
        }
        return tx.agentRun.findUniqueOrThrow({
          where: { id: run.id },
          select: {
            id: true,
            status: true,
            finishedAt: true,
            summary: true,
            producedArtifactIds: true,
            verificationResult: true,
            followUps: true,
            completionMeta: true,
          },
        });
      });
      if (run.executionStepId) {
        await maybeAutoJudge(db, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId,
          stepId: run.executionStepId,
        });
      }
      return completed;
    },
  },

  /**
   * Flip an ACTIVE run to WAITING — the patient-agent state. Use this
   * when the agent is blocked on the operator (or another agent) and
   * doesn't want the stale-run watchdog to mistake patience for death.
   *
   * Behavior:
   *  - Validates the calling key is linked to the owning agent
   *    (`ctx.apiKey.linkedAgentId === run.agentId`), mirroring the
   *    `runs.recordUsage` pattern. Cross-agent writes are rejected.
   *  - Only ACTIVE runs can transition into WAITING. Calling on a
   *    terminal run (COMPLETED / ABANDONED / STALLED) throws; calling
   *    on an already-WAITING run is idempotent (no-op on status, but
   *    `reason` / `currentStep` still update).
   *  - Sets `status = WAITING`, replaces `currentStep` with `reason`
   *    (or "Waiting on operator" if none provided), and bumps
   *    `lastEventAt = now`. The bump matters: when the run later
   *    resumes via `runs.resumeWork`, the stale timer measures
   *    against the resume moment, not the original block moment.
   *  - If `blocking: true`, also emits `AGENT_RUN_BLOCKED` via the
   *    standard `recordChange` flow. The audit fan-out branch in
   *    `audit.ts` then notifies the agent's webhook so its runtime
   *    sees the block confirmed. Set `blocking: false` (default) for
   *    silent waits that don't need to wake anyone.
   *
   * Resuming work later: call `runs.resumeWork({ runId })`. Any
   * subsequent activity routed through `openOrTouchRun` (a comment,
   * a status upsert) will also auto-resume the run, so the explicit
   * `resumeWork` call is only required for "I'm back" pings that
   * don't otherwise touch the run.
   */
  "runs.setWaiting": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      runId: z.string().min(1).max(40).describe("AgentRun.id"),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Operator-facing label, e.g. "awaiting credentials for prod DB". Replaces currentStep.',
        ),
      blocking: z
        .boolean()
        .default(false)
        .describe(
          "When true, emit AGENT_RUN_BLOCKED so the agent's webhook is notified. Default false for silent waits.",
        ),
    }),
    async run(input: { runId: string; reason?: string; blocking: boolean }, ctx: McpContext) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("runs.setWaiting requires an API key with linkedAgentId set.");
      }
      const run = await db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true, issueId: true, status: true },
      });
      if (!run) throw new Error("AgentRun not found in this workspace.");
      if (run.agentId !== linkedAgentId) {
        throw new Error("AgentRun belongs to a different agent than the calling key.");
      }
      if (run.status !== AgentRunStatus.ACTIVE && run.status !== AgentRunStatus.WAITING) {
        throw new Error(`Run is ${run.status}; only ACTIVE / WAITING runs can be marked waiting.`);
      }

      const reasonLabel = input.reason ?? "Waiting on operator";

      const updated = await db.$transaction(async (tx) => {
        const next = await tx.agentRun.update({
          where: { id: run.id },
          data: {
            status: AgentRunStatus.WAITING,
            currentStep: reasonLabel,
            lastEventAt: new Date(),
          },
          select: {
            id: true,
            status: true,
            currentStep: true,
            lastEventAt: true,
          },
        });

        // Always append a timeline event so the activity drawer reflects
        // the block. The publish + AuditLog only happens for blocking
        // calls — silent waits stay quiet on the wider event bus.
        await tx.agentRunEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            runId: run.id,
            kind: "WAITING",
            payload: { reason: reasonLabel, blocking: input.blocking },
          },
        });

        if (input.blocking) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "AgentRun",
            entityId: run.id,
            action: "set-waiting",
            after: { status: "WAITING", currentStep: reasonLabel },
            eventKind: EventKind.AGENT_RUN_BLOCKED,
            subjectType: "agent-run",
            subjectId: run.id,
            payload: {
              runId: run.id,
              issueId: run.issueId,
              agentId: run.agentId,
              reason: reasonLabel,
            },
          });
        }
        return next;
      });

      return updated;
    },
  },

  /**
   * Flip a WAITING run back to ACTIVE. Reverse of `runs.setWaiting`.
   * Same agent-ownership check; no event is emitted (the next agent
   * action will record its own audit row). Idempotent on ACTIVE runs.
   */
  "runs.resumeWork": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      runId: z.string().min(1).max(40).describe("AgentRun.id"),
      currentStep: z
        .string()
        .max(120)
        .optional()
        .describe('Optional fresh step label, e.g. "resuming after creds."'),
    }),
    async run(input: { runId: string; currentStep?: string }, ctx: McpContext) {
      const linkedAgentId = ctx.apiKey?.linkedAgentId;
      if (!linkedAgentId) {
        throw new Error("runs.resumeWork requires an API key with linkedAgentId set.");
      }
      const run = await db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true, status: true, completionMeta: true },
      });
      if (!run) throw new Error("AgentRun not found in this workspace.");
      if (run.agentId !== linkedAgentId) {
        throw new Error("AgentRun belongs to a different agent than the calling key.");
      }
      if (run.status !== AgentRunStatus.WAITING && run.status !== AgentRunStatus.ACTIVE) {
        throw new Error(`Run is ${run.status}; only WAITING / ACTIVE runs can be resumed.`);
      }
      // Re-arm run-budget enforcement: clear any breach marker so a
      // budget-paused run can't resume uncapped (no-op for normal waits).
      const rearmedMeta = clearBudgetMarkers(run.completionMeta);
      return db.agentRun.update({
        where: { id: run.id },
        data: {
          status: AgentRunStatus.ACTIVE,
          lastEventAt: new Date(),
          controlState: "NONE",
          controlRequestedAt: null,
          ...(rearmedMeta !== undefined ? { completionMeta: rearmedMeta } : {}),
          ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
        },
        select: {
          id: true,
          status: true,
          currentStep: true,
          lastEventAt: true,
        },
      });
    },
  },

  /**
   * List AgentRun rows. Useful for agents that want to scan their own
   * recent history (e.g., "did I already touch this issue today"). Cursor-
   * paginated by `startedAt DESC` via `before`. Defaults exclude nothing
   * — pass `status` to filter by lifecycle.
   */
  "runs.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      agentId: z.string().min(1).max(40).optional(),
      issueId: z.string().min(1).max(40).optional(),
      status: z.enum(["ACTIVE", "COMPLETED", "ABANDONED", "STALLED", "WAITING"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      before: z.coerce
        .date()
        .optional()
        .describe("Cursor — return runs started strictly before this timestamp."),
    }),
    async run(
      input: {
        agentId?: string;
        issueId?: string;
        status?: "ACTIVE" | "COMPLETED" | "ABANDONED" | "STALLED" | "WAITING";
        limit: number;
        before?: Date;
      },
      ctx: McpContext,
    ) {
      // Defensive: if the caller scopes by issue, run the narrowing check
      // so a key narrowed to project A can't list runs for project B's issue.
      if (input.issueId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.issueId,
        });
      }
      return db.agentRun.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.issueId ? { issueId: input.issueId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.before ? { startedAt: { lt: input.before } } : {}),
        },
        orderBy: { startedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          status: true,
          currentStep: true,
          startedAt: true,
          finishedAt: true,
          lastEventAt: true,
          tokensIn: true,
          tokensOut: true,
          tokensCached: true,
          costUsd: true,
          issue: {
            select: {
              id: true,
              number: true,
              title: true,
              workspace: { select: { key: true } },
            },
          },
          agent: { select: { id: true, profileKey: true } },
        },
      });
    },
  },

  /**
   * Operator "kick" for a stalled run. Re-fires the dispatch webhook
   * for the underlying issue without changing assignment or
   * controlState. Mirrors the tRPC `agentRun.kick` proc — same
   * eligibility (run must be ACTIVE and quiet past `STALE_RUN_MS`)
   * and same `AGENT_RUN_KICKED` audit row. WRITE_ISSUES scope so a
   * narrowed agent key can't kick across project boundaries.
   *
   * Returns `{ ok, kicked, idleMs }`. `kicked: false` means the run
   * was found but not yet stalled — the caller should retry rather
   * than treat this as an error.
   */
  "runs.kick": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      runId: z.string().min(1).max(40).describe("AgentRun.id"),
    }),
    async run(input: { runId: string }, ctx: McpContext) {
      const run = await db.agentRun.findFirst({
        where: { id: input.runId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          issueId: true,
          status: true,
          lastEventAt: true,
          currentStep: true,
          agent: {
            select: {
              id: true,
              profileKey: true,
              webhookUrl: true,
              webhookSecret: true,
            },
          },
        },
      });
      if (!run) throw new Error("AgentRun not found in this workspace.");
      if (run.status !== AgentRunStatus.ACTIVE) {
        throw new Error(`Run is ${run.status}; only ACTIVE runs can be kicked.`);
      }
      // Defensive scope check: kick is an issue-side action, so reuse
      // the issue narrowing the API key may carry.
      await assertKeyScope(scopeCtx(ctx), {
        entity: "issue",
        id: run.issueId,
      });
      const idleMs = Date.now() - run.lastEventAt.getTime();
      if (idleMs < STALE_RUN_MS) {
        return { ok: true, kicked: false, idleMs } as const;
      }

      await db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "AgentRun",
          entityId: run.id,
          action: "kick",
          eventKind: EventKind.AGENT_RUN_KICKED,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            runId: run.id,
            issueId: run.issueId,
            agentId: run.agent.id,
            idleMs,
            currentStep: run.currentStep,
            via: "mcp",
          },
        });
      });

      const url = run.agent.webhookUrl;
      const secret = run.agent.webhookSecret;
      if (url && secret) {
        void deliverWebhook({
          url,
          secret,
          timeoutMs: 5000,
          body: {
            id: `run-kick-${run.id}-${Date.now()}`,
            kind: "AGENT_RUN_KICKED",
            subjectType: "agent-run",
            subjectId: run.id,
            payload: {
              runId: run.id,
              issueId: run.issueId,
              agentId: run.agent.id,
              workspaceId: ctx.workspaceId,
              idleMs,
              reason: "operator-kick",
            },
            createdAt: new Date().toISOString(),
          },
        }).catch(() => undefined);
      }

      return { ok: true, kicked: true, idleMs } as const;
    },
  },

  // --------------------------------------------------------------------- Chat thread kick
  /**
   * Re-fire the wake for a stalled chat thread. Mirrors the operator-
   * facing tRPC `chat.retryLastUserMessage` mutation but is scoped to
   * the linked agent (the agent that owns the thread) rather than the
   * thread's user — letting an agent's own backstop poller recover
   * missed wakes without the operator having to click "retry" in the
   * UI.
   *
   * Resolves the latest dispatched USER message on the thread that
   * hasn't been acknowledged yet, then emits a CHAT_MESSAGE_POSTED
   * event with `retry: true`. Forge's worker re-queues a
   * WebhookDelivery against the agent's `webhookUrl`. Idempotent
   * call-wise — re-running just re-fires another wake; the
   * acknowledgedAt timestamp on the message row keeps the inbox
   * filter honest.
   */
  "chat.kickThread": {
    scopes: ["WRITE_COMMENTS"] as const,
    input: z.object({
      threadId: z.string().min(1).max(40).describe("ChatThread.id to kick."),
    }),
    async run(input: { threadId: string }, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new Error("chat.kickThread requires an API key with linkedAgentId set.");
      }
      const thread = await db.chatThread.findFirst({
        where: { id: input.threadId, workspaceId: ctx.workspaceId, agentId },
        select: { id: true, agentId: true },
      });
      if (!thread) {
        throw new Error(
          "Chat thread not found in this workspace, or it does not belong to the calling agent.",
        );
      }
      const latest = await db.chatMessage.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          role: "USER",
          dispatchedAt: { not: null },
          acknowledgedAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, body: true, contextSnapshot: true, createdAt: true },
      });
      if (!latest) {
        return {
          ok: true,
          kicked: false,
          reason: "no-unacked-user-message",
        } as const;
      }
      const laterAgentReply = await db.chatMessage.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          threadId: thread.id,
          role: "AGENT",
          OR: [
            { createdAt: { gt: latest.createdAt } },
            { createdAt: latest.createdAt, id: { gt: latest.id } },
          ],
        },
        select: { id: true },
      });
      if (laterAgentReply) {
        return {
          ok: true,
          kicked: false,
          reason: "no-unacked-user-message",
        } as const;
      }
      await db.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: null,
          actorAgentId: agentId,
          entity: "ChatMessage",
          entityId: latest.id,
          action: "retry-dispatch",
          eventKind: EventKind.CHAT_MESSAGE_POSTED,
          subjectType: "chat-thread",
          subjectId: thread.id,
          payload: {
            threadId: thread.id,
            messageId: latest.id,
            agentId: thread.agentId,
            role: "USER",
            body: latest.body,
            context: (latest.contextSnapshot ?? {}) as Prisma.InputJsonValue,
            retry: true,
            retriedAt: new Date().toISOString(),
            retryReason: "inbox-poll-backstop",
          },
        });
      });
      return {
        ok: true,
        kicked: true,
        chatMessageId: latest.id,
      } as const;
    },
  },

  // --------------------------------------------------------------------- Agent dispatch inbox
  /**
   * Durable inbox for the calling agent. Returns the canonical work
   * units (`AgentRun`s rooted on issues + USER `ChatMessage`s rooted
   * on chat threads) that the agent owes attention on, with derived
   * lifecycle state (queued → wake-sent → acknowledged → running →
   * stalled). Identity comes from `ctx.apiKey.linkedAgentId`; calls
   * without a linked agent key are rejected.
   *
   * Returned items always carry enough snapshot data for the agent to
   * decide which `agent.context.bundle` call to make next without an
   * extra round-trip — the recommended flow remains
   * `agent.inbox.list → agent.inbox.ack → agent.context.bundle → act`.
   */
  "agent.inbox.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z.enum(["unacked", "active", "stale", "all"]).default("unacked"),
      limit: z.number().int().min(1).max(100).default(50),
      staleAfterSeconds: z.number().int().min(30).max(86_400).optional(),
    }),
    async run(
      input: {
        status: "unacked" | "active" | "stale" | "all";
        limit: number;
        staleAfterSeconds?: number;
      },
      ctx: McpContext,
    ) {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new Error("agent.inbox.list requires an API key with linkedAgentId set.");
      }
      const { listInbox } = await import("@/server/services/agent-dispatch-inbox");
      const items = await listInbox(db, {
        workspaceId: ctx.workspaceId,
        agentId,
        filter: input.status,
        limit: input.limit,
        staleAfterSeconds: input.staleAfterSeconds,
        scope: {
          projectIds: ctx.apiKey?.projectIds ?? [],
          labelIds: ctx.apiKey?.labelIds ?? [],
          initiativeIds: ctx.apiKey?.initiativeIds ?? [],
        },
      });
      return { items };
    },
  },

  /**
   * Acknowledge an inbox item. Sets `acknowledgedAt` on the canonical
   * row (AgentRun.acknowledgedAt or ChatMessage.acknowledgedAt), which
   * the UI uses to clear "wake sent" indicators and start the typing
   * animation for chat. Idempotent — re-acking an already-acked row
   * returns the prior timestamp.
   */
  "agent.inbox.ack": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z
      .object({
        runId: z.string().min(1).max(40).optional(),
        chatMessageId: z.string().min(1).max(40).optional(),
      })
      .refine(
        (v) => Boolean(v.runId) !== Boolean(v.chatMessageId),
        "Provide exactly one of runId or chatMessageId.",
      ),
    async run(input: { runId?: string; chatMessageId?: string }, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new Error("agent.inbox.ack requires an API key with linkedAgentId set.");
      }
      const { ackInboxItem } = await import("@/server/services/agent-dispatch-inbox");
      const target = input.runId ? { runId: input.runId } : { chatMessageId: input.chatMessageId! };
      return db.$transaction((tx) =>
        ackInboxItem(tx, {
          workspaceId: ctx.workspaceId,
          agentId,
          target,
        }),
      );
    },
  },

  /**
   * Mark output as started on an inbox item. For chat, this is usually
   * called from `chat.startDraft` already; this tool exists so issue
   * runs can explicitly transition `wake-sent → running` without
   * waiting for the first status comment. Idempotent.
   */
  "agent.inbox.outputStarted": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z
      .object({
        runId: z.string().min(1).max(40).optional(),
        chatMessageId: z.string().min(1).max(40).optional(),
      })
      .refine(
        (v) => Boolean(v.runId) !== Boolean(v.chatMessageId),
        "Provide exactly one of runId or chatMessageId.",
      ),
    async run(input: { runId?: string; chatMessageId?: string }, ctx: McpContext) {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new Error("agent.inbox.outputStarted requires an API key with linkedAgentId set.");
      }
      const { markOutputStarted } = await import("@/server/services/agent-dispatch-inbox");
      const target = input.runId ? { runId: input.runId } : { chatMessageId: input.chatMessageId! };
      return db.$transaction((tx) =>
        markOutputStarted(tx, {
          workspaceId: ctx.workspaceId,
          agentId,
          target,
        }),
      );
    },
  },

  // --------------------------------------------------------------------- Events
  /**
   * Read the workspace ActivityEvent stream. Cursor-paginated newest-first
   * by `createdAt`. Filters by subjectType + subjectId + kind list. The
   * caller's actor narrowing applies via the existing scope helpers when
   * subjectType="issue" + subjectId is given. Use this to power "what
   * happened on this issue lately" without hitting the tRPC ai router.
   */
  "events.recent": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      subjectType: z.string().min(1).max(40).optional(),
      subjectId: z.string().min(1).max(40).optional(),
      kinds: z.array(z.nativeEnum(EventKind)).max(32).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      before: z.coerce.date().optional(),
    }),
    async run(
      input: {
        subjectType?: string;
        subjectId?: string;
        kinds?: EventKind[];
        limit: number;
        before?: Date;
      },
      ctx: McpContext,
    ) {
      if (input.subjectType === "issue" && input.subjectId) {
        await assertKeyScope(scopeCtx(ctx), {
          entity: "issue",
          id: input.subjectId,
        });
      }
      return db.activityEvent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.subjectType ? { subjectType: input.subjectType } : {}),
          ...(input.subjectId ? { subjectId: input.subjectId } : {}),
          ...(input.kinds && input.kinds.length ? { kind: { in: input.kinds } } : {}),
          ...(input.before ? { createdAt: { lt: input.before } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
        include: {
          actor: { select: { id: true, name: true, image: true } },
        },
      });
    },
  },

  // --------------------------------------------------------------------- Workspace
  /**
   * Workspace settings the calling agent could plausibly need at dispatch
   * time. Intentionally narrow — no member list (admin-gated) and no
   * secrets. Cycle/quota/dispatch knobs only.
   */
  "workspace.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_input: Record<string, never>, ctx: McpContext) {
      return db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: {
          id: true,
          slug: true,
          key: true,
          name: true,
          cycleLengthDays: true,
          cycleCooldownDays: true,
          timeTrackingEnabled: true,
          attachmentQuotaMb: true,
          requiredAckSeconds: true,
          autoDispatch: true,
          autoDispatchMode: true,
        },
      });
    },
  },

  /**
   * Workspaces visible to this MCP principal. Non-admin API keys remain
   * pinned to their issuing workspace. Admin/user-backed keys and
   * session-authenticated callers can discover every workspace the user
   * belongs to, which lets agents mint or select a PER/WRK-scoped key
   * without guessing ids.
   */
  "workspaces.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_input: Record<string, never>, ctx: McpContext) {
      const canListMemberships =
        Boolean(ctx.userId) && (!ctx.apiKey || ctx.apiKey.scopes.includes(PluginScope.ADMIN));
      const where: Prisma.WorkspaceWhereInput = canListMemberships
        ? { deletedAt: null, memberships: { some: { userId: ctx.userId! } } }
        : { id: ctx.workspaceId, deletedAt: null };
      const rows = await db.workspace.findMany({
        where,
        orderBy: { name: "asc" },
        select: { id: true, key: true, name: true, slug: true },
      });
      return mcpListEnvelope(rows);
    },
  },

  // --------------------------------------------------------------------- Access keys
  /**
   * Read non-plugin API keys for the selected workspace. Raw secrets and
   * hashes are never returned. Cross-workspace selection is limited to
   * ADMIN + user-backed principals that are members of the target workspace.
   */
  "access.list": {
    scopes: ["ADMIN"] as const,
    input: z.object({ ...workspaceSelectorShape }).default({}),
    async run(input: WorkspaceSelectorInput, ctx: McpContext) {
      const workspace = await resolveTargetWorkspace(ctx, input);
      const rows = await db.apiKey.findMany({
        where: { workspaceId: workspace.id, pluginId: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          prefix: true,
          kind: true,
          scopes: true,
          projectIds: true,
          labelIds: true,
          initiativeIds: true,
          linkedAgentId: true,
          linkedAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          userId: true,
        },
      });
      return mcpListEnvelope(rows);
    },
  },

  /**
   * Create a permanent or optionally expiring user-owned personal key for a
   * selected workspace. The raw key is returned once; callers must store it
   * outside Forge. Use this to bootstrap a PER/WRK-scoped Hermes profile.
   */
  "access.createPersonal": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      ...workspaceSelectorShape,
      name: z.string().min(1).max(80),
      scopes: z.array(z.nativeEnum(PluginScope)).min(1),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      ...accessNarrowingShape,
    }),
    async run(
      input: WorkspaceSelectorInput &
        AccessNarrowingInput & {
          name: string;
          scopes: PluginScope[];
          expiresInDays?: number;
        },
      ctx: McpContext,
    ) {
      if (!ctx.userId) throw new Error("Creating access keys requires a user-backed principal.");
      const workspace = await resolveTargetWorkspace(ctx, input);
      await assertMcpIdsInWorkspace(workspace.id, input);
      const { raw, hashed, prefix } = generateMcpApiKey();
      const row = await db.apiKey.create({
        data: {
          workspaceId: workspace.id,
          userId: ctx.userId,
          kind: ApiKeyKind.PERSONAL,
          name: input.name,
          hashedKey: hashed,
          prefix,
          scopes: input.scopes,
          projectIds: input.projectIds ?? [],
          labelIds: input.labelIds ?? [],
          initiativeIds: input.initiativeIds ?? [],
          linkedAgentId: null,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : null,
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          kind: true,
          scopes: true,
          projectIds: true,
          labelIds: true,
          initiativeIds: true,
          linkedAgentId: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      return { ...row, workspace, rawKey: raw };
    },
  },

  /**
   * Create a short-lived user-owned session key in a selected workspace.
   * Session keys are intentionally not agent-linked; use
   * access.createAgentKey for persistent Hermes agent identities.
   */
  "access.createSession": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      ...workspaceSelectorShape,
      name: z.string().min(1).max(80),
      scopes: z.array(z.nativeEnum(PluginScope)).min(1),
      ttlHours: z.number().int().min(1).max(168).default(24),
      ...accessNarrowingShape,
    }),
    async run(
      input: WorkspaceSelectorInput &
        AccessNarrowingInput & {
          name: string;
          scopes: PluginScope[];
          ttlHours: number;
        },
      ctx: McpContext,
    ) {
      if (!ctx.userId) throw new Error("Creating access keys requires a user-backed principal.");
      const workspace = await resolveTargetWorkspace(ctx, input);
      await assertMcpIdsInWorkspace(workspace.id, input);
      const { raw, hashed, prefix } = generateMcpApiKey();
      const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
      const row = await db.apiKey.create({
        data: {
          workspaceId: workspace.id,
          userId: ctx.userId,
          kind: ApiKeyKind.SESSION,
          name: input.name,
          hashedKey: hashed,
          prefix,
          scopes: input.scopes,
          projectIds: input.projectIds ?? [],
          labelIds: input.labelIds ?? [],
          initiativeIds: input.initiativeIds ?? [],
          linkedAgentId: null,
          expiresAt,
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          kind: true,
          scopes: true,
          projectIds: true,
          labelIds: true,
          initiativeIds: true,
          linkedAgentId: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      return { ...row, workspace, rawKey: raw };
    },
  },

  /**
   * Create a workspace-scoped AGENT key linked to an existing Agent binding
   * in that workspace. This is the safe MCP bootstrap path for giving Victor
   * a PER-scoped key without allowing an AXI key to read PER data directly.
   */
  "access.createAgentKey": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      ...workspaceSelectorShape,
      name: z.string().min(1).max(80).optional(),
      agentId: agentIdSchema.optional(),
      profileKey: z.string().min(1).max(120).optional(),
      scopes: z.array(z.nativeEnum(PluginScope)).min(1).default(allPluginScopes),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      ...accessNarrowingShape,
    }),
    async run(
      input: WorkspaceSelectorInput &
        AccessNarrowingInput & {
          name?: string;
          agentId?: string;
          profileKey?: string;
          scopes: PluginScope[];
          expiresInDays?: number;
        },
      ctx: McpContext,
    ) {
      if (!ctx.userId) throw new Error("Creating access keys requires a user-backed principal.");
      if (!input.agentId && !input.profileKey) {
        throw new Error("Provide agentId or profileKey for access.createAgentKey.");
      }
      const workspace = await resolveTargetWorkspace(ctx, input);
      await assertMcpIdsInWorkspace(workspace.id, input);
      const agent = await db.agent.findFirst({
        where: {
          workspaceId: workspace.id,
          ...(input.agentId ? { id: input.agentId } : {}),
          ...(input.profileKey ? { profileKey: input.profileKey } : {}),
          archivedAt: null,
        },
        select: { id: true, name: true, profileKey: true },
      });
      if (!agent) {
        throw new Error(
          "Agent binding not found in selected workspace. Create or bind the agent in that workspace first.",
        );
      }
      const { raw, hashed, prefix } = generateMcpApiKey();
      const row = await db.apiKey.create({
        data: {
          workspaceId: workspace.id,
          userId: ctx.userId,
          kind: ApiKeyKind.AGENT,
          name: input.name ?? `${agent.name} MCP (${workspace.key})`,
          hashedKey: hashed,
          prefix,
          scopes: input.scopes,
          projectIds: input.projectIds ?? [],
          labelIds: input.labelIds ?? [],
          initiativeIds: input.initiativeIds ?? [],
          linkedAgentId: agent.id,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : null,
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          kind: true,
          scopes: true,
          projectIds: true,
          labelIds: true,
          initiativeIds: true,
          linkedAgentId: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      return { ...row, workspace, linkedAgent: agent, rawKey: raw };
    },
  },

  /** Revoke a non-plugin API key in the selected workspace. */
  "access.revoke": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      ...workspaceSelectorShape,
      id: z.string().cuid(),
    }),
    async run(input: WorkspaceSelectorInput & { id: string }, ctx: McpContext) {
      const workspace = await resolveTargetWorkspace(ctx, input);
      const key = await db.apiKey.findFirst({
        where: { id: input.id, workspaceId: workspace.id, pluginId: null },
        select: { id: true },
      });
      if (!key) throw new Error("Access key not found in selected workspace.");
      return db.apiKey.update({
        where: { id: key.id },
        data: { revokedAt: new Date() },
        select: { id: true, prefix: true, kind: true, revokedAt: true },
      });
    },
  },

  // --------------------------------------------------------------------- GitHub
  "github.parseUrl": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      url: z.string().url().max(2048),
    }),
    async run(input: { url: string }) {
      return parseGitHubUrl(input.url);
    },
  },

  "github.listLinked": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      issueId: z.string().cuid(),
    }),
    async run(input: { issueId: string }, ctx: McpContext) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      return listLinkedGitHubResources({
        db,
        workspaceId: ctx.workspaceId,
        issueId: input.issueId,
      });
    },
  },

  "github.link": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      issueId: z.string().cuid(),
      url: z.string().url().max(2048),
      kind: z.enum(EXTERNAL_LINK_KINDS).default("RELATES_TO"),
      mappingId: z.string().cuid().optional(),
    }),
    async run(
      input: {
        issueId: string;
        url: string;
        kind: (typeof EXTERNAL_LINK_KINDS)[number];
        mappingId?: string;
      },
      ctx: McpContext,
    ) {
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
      const actorId = await resolveActorId(ctx);
      return linkGitHubUrlToIssue({
        db,
        workspaceId: ctx.workspaceId,
        issueId: input.issueId,
        url: input.url,
        kind: input.kind,
        mappingId: input.mappingId,
        actor: {
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        },
      });
    },
  },

  "github.importIssue": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      mappingId: z.string().cuid().optional(),
      url: z.string().url().max(2048).optional(),
      repoFullName: z.string().min(3).max(200).optional(),
      resourceType: z.enum(GITHUB_RESOURCE_TYPES).optional(),
      number: z.number().int().positive().optional(),
      projectId: z.string().cuid().nullable().optional(),
      labelIds: z.array(z.string().cuid()).default([]),
      queue: z.boolean().optional(),
    }),
    async run(
      input: {
        mappingId?: string;
        url?: string;
        repoFullName?: string;
        resourceType?: GitHubResourceType;
        number?: number;
        projectId?: string | null;
        labelIds: string[];
        queue?: boolean;
      },
      ctx: McpContext,
    ) {
      if (input.projectId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "project", id: input.projectId });
      }
      const actorId = await resolveActorId(ctx);
      const result = await importGitHubIssue({
        db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
        url: input.url,
        repoFullName: input.repoFullName,
        resourceType: input.resourceType,
        number: input.number,
        projectId: input.projectId,
        labelIds: input.labelIds,
        queue: input.queue,
        actor: {
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        },
      });
      await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: result.issueId });
      return result;
    },
  },

  "github.sync": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      externalResourceId: z.string().cuid(),
    }),
    async run(input: { externalResourceId: string }, ctx: McpContext) {
      const links = await db.externalResourceLink.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          externalResourceId: input.externalResourceId,
        },
        select: { issueId: true },
      });
      for (const link of links) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: link.issueId });
      }
      const actorId = await resolveActorId(ctx);
      return syncGitHubExternalResource({
        db,
        workspaceId: ctx.workspaceId,
        externalResourceId: input.externalResourceId,
        actor: {
          actorId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        },
      });
    },
  },

  "github.listMappings": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({ includePaused: z.boolean().default(false) })
      .default({ includePaused: false }),
    async run(input: { includePaused: boolean }, ctx: McpContext) {
      // Active repo mappings the agent can link/search against. Pair with
      // `github.search` (needs a mappingId) and `github.link` (resolves a
      // mapping by repo from the URL) so agents can discover which repos are
      // wired up before acting.
      return listGitHubRepoMappings({
        db,
        workspaceId: ctx.workspaceId,
        includePaused: input.includePaused,
      });
    },
  },

  "github.search": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      mappingId: z.string().cuid(),
      query: z.string().min(1).max(200),
      type: z.enum(["issue", "pr"]).optional(),
    }),
    async run(input: { mappingId: string; query: string; type?: "issue" | "pr" }, ctx: McpContext) {
      const mapping = await resolveGitHubRepoMapping({
        db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
      });
      return searchGitHubIssuesAndPulls({
        installationId: githubInstallationId(mapping.connection),
        repoFullName: mapping.target,
        query: input.query,
        type: input.type,
      });
    },
  },

  // --------------------------------------------------------------------- Statuses
  /**
   * List the workspace's status rows ordered by `position`. Optional
   * `category` filter (BACKLOG | TODO | IN_PROGRESS | IN_REVIEW | DONE
   * | CANCELED). Used by agents to discover the right `statusId` for an
   * `issues.transition` call without inventing ids — e.g., the local
   * `forge` daemon calls `statuses.list({ category: "IN_PROGRESS" })`
   * on AGENT_ASSIGNED to flip the issue into work-in-progress before
   * spawning Claude.
   */
  "statuses.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({
        category: z.nativeEnum(StatusCategory).optional(),
      })
      .default({}),
    async run(input: { category?: StatusCategory }, ctx: McpContext) {
      return db.status.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.category ? { category: input.category } : {}),
        },
        orderBy: { position: "asc" },
        select: {
          id: true,
          name: true,
          category: true,
          color: true,
          position: true,
          isDefault: true,
        },
      });
    },
  },

  // --------------------------------------------------------------------- Agent context bundle
  /**
   * Composite "give me everything I need to act" call. Saves agents 4–5
   * round trips on dispatch by fetching the workspace + issue + comments
   * + attachments + relations + currentRun in one shot. For chat threads,
   * fetches thread + messages + workspace, and (bonus) hydrates an issue
   * snapshot if any message's contextSnapshot.issueId pointed at one.
   *
   * Exactly one of `issueId` / `threadId` must be provided. Scope is
   * enforced on whichever subject is inferred — narrowing rejection
   * mirrors what the per-tool callers would have done individually.
   */
  "agent.context.bundle": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({
        issueId: z.string().min(1).max(40).optional(),
        threadId: z.string().min(1).max(40).optional(),
      })
      .refine((v) => (v.issueId && !v.threadId) || (!v.issueId && v.threadId), {
        message: "Provide exactly one of issueId or threadId.",
      }),
    async run(input: { issueId?: string; threadId?: string }, ctx: McpContext) {
      const workspace = await db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: {
          id: true,
          slug: true,
          key: true,
          name: true,
          cycleLengthDays: true,
          cycleCooldownDays: true,
          timeTrackingEnabled: true,
          attachmentQuotaMb: true,
          requiredAckSeconds: true,
          autoDispatch: true,
          autoDispatchMode: true,
        },
      });

      if (input.issueId) {
        const issueId = input.issueId;
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: issueId });
        const issue = await db.issue.findFirst({
          where: { id: issueId, workspaceId: ctx.workspaceId, deletedAt: null },
          include: {
            status: true,
            project: true,
            labels: { include: { label: true } },
            assignees: {
              include: { user: { select: { id: true, name: true, image: true } } },
            },
            assignedAgent: {
              select: { id: true, profileKey: true, name: true, status: true },
            },
          },
        });
        if (!issue) throw new Error("Issue not found in this workspace.");

        const [rawComments, attachments, relations, currentRun, artifacts, externalResources] =
          await Promise.all([
            db.comment.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                issueId,
                deletedAt: null,
              },
              orderBy: { updatedAt: "desc" },
              take: 50,
              include: {
                author: { select: { id: true, name: true, image: true } },
                authoringAgent: {
                  select: { id: true, profileKey: true, name: true },
                },
                run: { select: { id: true, status: true, finishedAt: true } },
              },
            }),
            db.attachment.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                OR: [{ targetType: "issue", targetId: issueId }, { issueId }],
                NOT: { url: { startsWith: "pending:" } },
              },
              orderBy: { createdAt: "asc" },
            }),
            db.issueRelation.findMany({
              where: { workspaceId: ctx.workspaceId, fromIssueId: issueId },
              include: {
                toIssue: {
                  select: {
                    id: true,
                    number: true,
                    title: true,
                    statusId: true,
                    status: { select: { category: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            }),
            db.agentRun.findFirst({
              where: {
                workspaceId: ctx.workspaceId,
                issueId,
                status: { in: ["ACTIVE", "WAITING"] },
                ...(ctx.apiKey?.linkedAgentId ? { agentId: ctx.apiKey.linkedAgentId } : {}),
              },
              orderBy: { startedAt: "desc" },
            }),
            // Wave 2: surface linked artifacts in the agent's context bundle.
            // Includes both artifacts directly linked via `issueId` AND
            // artifacts promoted from a source on this issue (via sourceType
            // = "issue", sourceId = this id). Hidden when archived.
            db.artifact.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                archivedAt: null,
                OR: [{ issueId }, { sourceType: "issue", sourceId: issueId }],
              },
              orderBy: { updatedAt: "desc" },
              take: 20,
              select: {
                id: true,
                slug: true,
                title: true,
                type: true,
                status: true,
                summary: true,
                sourceType: true,
                sourceId: true,
                updatedAt: true,
              },
            }),
            db.externalResourceLink.findMany({
              where: { workspaceId: ctx.workspaceId, issueId },
              orderBy: { createdAt: "asc" },
              include: { externalResource: true },
            }),
          ]);

        // Wave 5: completion contract — surfaced so agents know
        // exactly what "done" looks like before starting work.
        const completionContract = {
          expectedOutput: issue.expectedOutput,
          verificationChecklist: issue.verificationChecklist,
          artifactRequired: issue.artifactRequired,
        };
        const { loadRunOrchestrationContext } =
          await import("@/server/services/orchestration-context");
        const orchestrationContext = await loadRunOrchestrationContext(db, {
          workspaceId: ctx.workspaceId,
          issueId,
          executionStepId: currentRun?.executionStepId,
          snapshot: currentRun?.orchestrationContextSnapshot,
        });
        const comments = sortCommentsChronologically(rawComments);
        const currentMode = (currentRun?.engagementMode ?? "EXECUTE") as EngagementMode;
        const runProtocol = {
          contractVersion: FORGE_RUN_CONTRACT_VERSION,
          runId: currentRun?.id ?? null,
          engagementMode: currentMode,
          modeInstruction: engagementInstruction({
            mode: currentMode,
            source: "surface-default",
            inferable: false,
          }),
          protocolInstruction: forgeRunProtocolInstruction(),
          mayMutateIssue: modeMayExecute(currentMode),
        };

        return {
          workspace,
          issue,
          description: issue.description,
          comments,
          attachments,
          relations,
          currentRun,
          artifacts,
          externalResources,
          orchestrationContext,
          completionContract,
          runProtocol,
        };
      }

      // threadId branch — addressee gating mirrors chat.getThread.
      const threadId = input.threadId!;
      const linkedAgentId = ctx.apiKey?.linkedAgentId ?? null;
      const thread = await db.chatThread.findFirst({
        where: { id: threadId, workspaceId: ctx.workspaceId },
        select: { id: true, agentId: true },
      });
      if (!thread) throw new Error("Chat thread not found in this workspace.");
      if (linkedAgentId && thread.agentId !== linkedAgentId) {
        throw new Error("Only the thread's agent may bundle this context.");
      }

      const bundle = await buildChatContextBundle(db, {
        workspaceId: ctx.workspaceId,
        threadId: thread.id,
        limit: 50,
      });
      const agent =
        linkedAgentId && linkedAgentId === thread.agentId
          ? null
          : await db.agent.findUnique({
              where: { id: thread.agentId },
              select: {
                id: true,
                profileKey: true,
                name: true,
                status: true,
                provider: true,
              },
            });

      // Wave 11: surface open action requests + recent artifacts +
      // pending review gates targeting this thread's agent so the
      // chat bundle gives a full "what's outstanding" picture.
      const [pendingActionRequests, recentArtifacts] = await Promise.all([
        linkedAgentId
          ? db.actionRequest.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                assignedAgentId: linkedAgentId,
                status: "OPEN",
              },
              orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
              take: 10,
              select: {
                id: true,
                title: true,
                body: true,
                severity: true,
                createdAt: true,
                issueId: true,
              },
            })
          : Promise.resolve([]),
        db.artifact.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            archivedAt: null,
            createdByAgentId: linkedAgentId ?? undefined,
          },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: {
            id: true,
            slug: true,
            title: true,
            type: true,
            status: true,
            updatedAt: true,
          },
        }),
      ]);

      return {
        workspace,
        thread: bundle.thread,
        conversation: bundle.conversation,
        summary: bundle.summary,
        messages: bundle.recentMessages,
        recentMessages: bundle.recentMessages,
        attachments: bundle.attachments,
        agent,
        linkedIssues: bundle.linkedIssues,
        diagnostics: bundle.diagnostics,
        contextPolicy: bundle.contextPolicy,
        pendingActionRequests,
        recentArtifacts,
      };
    },
  },

  // -------------------------------------------------------------------- Artifacts
  //
  // Durable, versionable output objects: specs, decisions, runbooks,
  // reports, briefs, verification logs, and accepted agent deliverables.
  // Body changes snapshot a new ArtifactVersion automatically; metadata
  // edits stay in-place. Promotions (chat-message/comment/note/agent-run
  // /issue → Artifact) preserve the source ref so the UI can render
  // provenance backlinks.

  "artifacts.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z.enum(["DRAFT", "IN_REVIEW", "ACCEPTED", "ARCHIVED"]).optional(),
      type: z
        .enum(["DOCUMENT", "DECISION", "RUNBOOK", "REPORT", "SPEC", "BRIEF", "VERIFICATION"])
        .optional(),
      issueId: z.string().cuid().optional(),
      projectId: z.string().cuid().optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async run(
      input: {
        status?: "DRAFT" | "IN_REVIEW" | "ACCEPTED" | "ARCHIVED";
        type?: "DOCUMENT" | "DECISION" | "RUNBOOK" | "REPORT" | "SPEC" | "BRIEF" | "VERIFICATION";
        issueId?: string;
        projectId?: string;
        includeArchived: boolean;
        limit: number;
      },
      ctx: McpContext,
    ) {
      return db.artifact.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          type: input.type,
          issueId: input.issueId,
          projectId: input.projectId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          slug: true,
          title: true,
          type: true,
          status: true,
          summary: true,
          issueId: true,
          projectId: true,
          sourceType: true,
          sourceId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    },
  },

  "artifacts.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z
      .object({
        id: z.string().cuid().optional(),
        slug: z.string().min(1).max(64).optional(),
      })
      .refine((v) => v.id || v.slug, { message: "Provide id or slug." }),
    async run(input: { id?: string; slug?: string }, ctx: McpContext) {
      const row = await db.artifact.findFirst({
        where: input.id
          ? { id: input.id, workspaceId: ctx.workspaceId }
          : { slug: input.slug!, workspaceId: ctx.workspaceId },
        include: {
          versions: {
            orderBy: { version: "desc" },
            take: 10,
            select: {
              id: true,
              version: true,
              title: true,
              summary: true,
              changelog: true,
              createdAt: true,
            },
          },
        },
      });
      if (!row) throw new Error("Artifact not found in this workspace.");
      return row;
    },
  },

  "artifacts.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(200_000).default(""),
      slug: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/)
        .optional(),
      type: z
        .enum(["DOCUMENT", "DECISION", "RUNBOOK", "REPORT", "SPEC", "BRIEF", "VERIFICATION"])
        .default("DOCUMENT"),
      status: z.enum(["DRAFT", "IN_REVIEW", "ACCEPTED", "ARCHIVED"]).default("DRAFT"),
      summary: z.string().max(2_000).nullable().optional(),
      issueId: z.string().cuid().optional(),
      projectId: z.string().cuid().optional(),
    }),
    async run(
      input: {
        title: string;
        body: string;
        slug?: string;
        type: "DOCUMENT" | "DECISION" | "RUNBOOK" | "REPORT" | "SPEC" | "BRIEF" | "VERIFICATION";
        status: "DRAFT" | "IN_REVIEW" | "ACCEPTED" | "ARCHIVED";
        summary?: string | null;
        issueId?: string;
        projectId?: string;
      },
      ctx: McpContext,
    ) {
      if (input.issueId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: input.issueId });
        await assertAgentIssueMutationAllowed(ctx, input.issueId, "artifacts.create");
      }
      const { createArtifact } = await import("@/server/services/artifact-service");
      const actorId = ctx.userId ?? null;
      return createArtifact(db, {
        workspaceId: ctx.workspaceId,
        actorId,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        slug: input.slug,
        body: input.body,
        type: input.type,
        status: input.status,
        summary: input.summary ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
      });
    },
  },

  "artifacts.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(200_000).optional(),
      summary: z.string().max(2_000).nullable().optional(),
      type: z
        .enum(["DOCUMENT", "DECISION", "RUNBOOK", "REPORT", "SPEC", "BRIEF", "VERIFICATION"])
        .optional(),
      status: z.enum(["DRAFT", "IN_REVIEW", "ACCEPTED", "ARCHIVED"]).optional(),
      changelog: z.string().max(1_000).optional(),
      publish: z.boolean().optional(),
    }),
    async run(
      input: {
        id: string;
        title?: string;
        body?: string;
        summary?: string | null;
        type?: "DOCUMENT" | "DECISION" | "RUNBOOK" | "REPORT" | "SPEC" | "BRIEF" | "VERIFICATION";
        status?: "DRAFT" | "IN_REVIEW" | "ACCEPTED" | "ARCHIVED";
        changelog?: string;
        publish?: boolean;
      },
      ctx: McpContext,
    ) {
      const artifact = await db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      if (artifact?.issueId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: artifact.issueId });
        await assertAgentIssueMutationAllowed(ctx, artifact.issueId, "artifacts.update");
      }
      const { updateArtifact } = await import("@/server/services/artifact-service");
      return updateArtifact(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        artifactId: input.id,
        title: input.title,
        body: input.body,
        summary: input.summary,
        type: input.type,
        status: input.status,
        changelog: input.changelog,
        publish: input.publish,
      });
    },
  },

  "artifacts.archive": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const artifact = await db.artifact.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      if (artifact?.issueId) {
        await assertKeyScope(scopeCtx(ctx), { entity: "issue", id: artifact.issueId });
        await assertAgentIssueMutationAllowed(ctx, artifact.issueId, "artifacts.archive");
      }
      const { archiveArtifact } = await import("@/server/services/artifact-service");
      await archiveArtifact(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        artifactId: input.id,
      });
      return { ok: true };
    },
  },

  "artifacts.promote": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      sourceType: z.enum(["chat-message", "comment", "note", "agent-run", "issue"]),
      sourceId: z.string().cuid(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(200_000).optional(),
      summary: z.string().max(2_000).nullable().optional(),
      type: z
        .enum(["DOCUMENT", "DECISION", "RUNBOOK", "REPORT", "SPEC", "BRIEF", "VERIFICATION"])
        .default("DOCUMENT"),
      issueId: z.string().cuid().optional(),
      projectId: z.string().cuid().optional(),
    }),
    async run(
      input: {
        sourceType: "chat-message" | "comment" | "note" | "agent-run" | "issue";
        sourceId: string;
        title?: string;
        body?: string;
        summary?: string | null;
        type: "DOCUMENT" | "DECISION" | "RUNBOOK" | "REPORT" | "SPEC" | "BRIEF" | "VERIFICATION";
        issueId?: string;
        projectId?: string;
      },
      ctx: McpContext,
    ) {
      if (input.issueId) {
        await assertAgentIssueMutationAllowed(ctx, input.issueId, "artifacts.promote");
      } else if (input.sourceType === "issue") {
        await assertAgentIssueMutationAllowed(ctx, input.sourceId, "artifacts.promote");
      } else {
        await assertMcpWorkspaceMutationPolicy(ctx, "artifacts.promote");
      }
      const { promoteToArtifact } = await import("@/server/services/artifact-service");
      return promoteToArtifact(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        title: input.title,
        body: input.body,
        summary: input.summary ?? null,
        type: input.type,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
      });
    },
  },

  // ------------------------------------------------------------------ ContextSets
  //
  // Reusable bundles of canonical refs an agent receives as context.
  // Items are polymorphic via targetType/targetId; includeMode
  // controls INCLUDE/EXCLUDE/SUMMARY_ONLY visibility. Agents call
  // `contextSets.hydrate` to get the bundle resolved to labels/urls.

  "contextSets.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(input: { includeArchived: boolean; limit: number }, ctx: McpContext) {
      return db.contextSet.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          name: true,
          description: true,
          ownerUserId: true,
          ownerAgentId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { items: true } },
        },
      });
    },
  },

  "contextSets.hydrate": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const { hydrateContextSet } = await import("@/server/services/context-set-service");
      const ws = await db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { slug: true },
      });
      const result = await hydrateContextSet(db, {
        workspaceId: ctx.workspaceId,
        contextSetId: input.id,
        workspaceSlug: ws.slug,
      });
      if (!result) throw new Error("Context set not found.");
      return result;
    },
  },

  "contextSets.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2_000).nullable().optional(),
      items: z
        .array(
          z.object({
            targetType: z.string().min(1).max(40),
            targetId: z.string().min(1),
            includeMode: z.enum(["INCLUDE", "EXCLUDE", "SUMMARY_ONLY"]).default("INCLUDE"),
            note: z.string().max(1_000).nullable().optional(),
          }),
        )
        .max(200)
        .optional(),
    }),
    async run(
      input: {
        name: string;
        description?: string | null;
        items?: Array<{
          targetType: string;
          targetId: string;
          includeMode: "INCLUDE" | "EXCLUDE" | "SUMMARY_ONLY";
          note?: string | null;
        }>;
      },
      ctx: McpContext,
    ) {
      const { createContextSet } = await import("@/server/services/context-set-service");
      return createContextSet(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        name: input.name,
        description: input.description ?? null,
        items: input.items?.map((it) => ({ ...it, note: it.note ?? null })),
      });
    },
  },

  "contextSets.addItem": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      contextSetId: z.string().cuid(),
      targetType: z.string().min(1).max(40),
      targetId: z.string().min(1),
      includeMode: z.enum(["INCLUDE", "EXCLUDE", "SUMMARY_ONLY"]).default("INCLUDE"),
      note: z.string().max(1_000).nullable().optional(),
    }),
    async run(
      input: {
        contextSetId: string;
        targetType: string;
        targetId: string;
        includeMode: "INCLUDE" | "EXCLUDE" | "SUMMARY_ONLY";
        note?: string | null;
      },
      ctx: McpContext,
    ) {
      const { addContextSetItem } = await import("@/server/services/context-set-service");
      return addContextSetItem(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        contextSetId: input.contextSetId,
        targetType: input.targetType,
        targetId: input.targetId,
        includeMode: input.includeMode,
        note: input.note ?? null,
      });
    },
  },

  "contextSets.removeItem": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      contextSetId: z.string().cuid(),
      itemId: z.string().cuid(),
    }),
    async run(input: { contextSetId: string; itemId: string }, ctx: McpContext) {
      const { removeContextSetItem } = await import("@/server/services/context-set-service");
      await removeContextSetItem(db, {
        workspaceId: ctx.workspaceId,
        contextSetId: input.contextSetId,
        itemId: input.itemId,
      });
      return { ok: true };
    },
  },

  // ----------------------------------------------------------- ExecutionPlans
  //
  // Multi-step plans an agent (or crew) executes under an issue or
  // project. Steps form an ordered list with optional dependencies;
  // the runner watches step state and surfaces ReviewGates (Wave 7)
  // when approval is required. Agents call these tools to read their
  // assigned steps, mark progress, and link AgentRun completion.

  "executionPlans.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z
        .enum(["DRAFT", "APPROVED", "RUNNING", "BLOCKED", "COMPLETED", "CANCELED"])
        .optional(),
      issueId: z.string().cuid().optional(),
      projectId: z.string().cuid().optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(
      input: {
        status?: "DRAFT" | "APPROVED" | "RUNNING" | "BLOCKED" | "COMPLETED" | "CANCELED";
        issueId?: string;
        projectId?: string;
        includeArchived: boolean;
        limit: number;
      },
      ctx: McpContext,
    ) {
      return db.executionPlan.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          issueId: input.issueId,
          projectId: input.projectId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: { _count: { select: { steps: true } } },
      });
    },
  },

  "executionPlans.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const plan = await db.executionPlan.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          steps: { orderBy: { position: "asc" } },
          contextSet: { select: { id: true, name: true } },
        },
      });
      if (!plan) throw new Error("Execution plan not found.");
      return plan;
    },
  },

  "executionPlans.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(50_000).nullable().optional(),
      issueId: z.string().cuid().nullable().optional(),
      projectId: z.string().cuid().nullable().optional(),
      contextSetId: z.string().cuid().nullable().optional(),
      goalId: z.string().cuid().nullable().optional(),
      status: z
        .enum(["DRAFT", "APPROVED", "RUNNING", "BLOCKED", "COMPLETED", "CANCELED"])
        .optional(),
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(300),
            body: z.string().max(50_000).nullable().optional(),
            assignedAgentId: agentIdSchema.nullable().optional(),
            assignedUserId: z.string().cuid().nullable().optional(),
            expectedOutput: z.string().max(50_000).nullable().optional(),
            dependsOnStepIds: z.array(z.string()).max(50).optional(),
            dependsOnStepIndexes: z.array(z.number().int().min(0)).max(50).optional(),
          }),
        )
        .max(50)
        .optional(),
    }),
    async run(
      input: {
        title: string;
        description?: string | null;
        issueId?: string | null;
        projectId?: string | null;
        contextSetId?: string | null;
        goalId?: string | null;
        status?: "DRAFT" | "APPROVED" | "RUNNING" | "BLOCKED" | "COMPLETED" | "CANCELED";
        steps?: Array<{
          title: string;
          body?: string | null;
          assignedAgentId?: string | null;
          assignedUserId?: string | null;
          expectedOutput?: string | null;
          dependsOnStepIds?: string[];
          dependsOnStepIndexes?: number[];
        }>;
      },
      ctx: McpContext,
    ) {
      const { createExecutionPlan } = await import("@/server/services/execution-plan-service");
      return createExecutionPlan(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        description: input.description ?? null,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? null,
        contextSetId: input.contextSetId ?? null,
        goalId: input.goalId ?? null,
        status: input.status,
        steps: input.steps?.map((s) => ({
          title: s.title,
          body: s.body ?? null,
          assignedAgentId: s.assignedAgentId ?? null,
          assignedUserId: s.assignedUserId ?? null,
          expectedOutput: s.expectedOutput ?? null,
          dependsOnStepIds: s.dependsOnStepIds ?? [],
          dependsOnStepIndexes: s.dependsOnStepIndexes ?? [],
        })),
      });
    },
  },

  "executionPlans.materializeStep": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ stepId: z.string().cuid() }),
    async run(input: { stepId: string }, ctx: McpContext) {
      const { materializeStepAsIssue } = await import("@/server/services/execution-plan-service");
      return materializeStepAsIssue(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        stepId: input.stepId,
      });
    },
  },

  "executionPlans.transition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      status: z.enum(["DRAFT", "APPROVED", "RUNNING", "BLOCKED", "COMPLETED", "CANCELED"]),
    }),
    async run(
      input: {
        id: string;
        status: "DRAFT" | "APPROVED" | "RUNNING" | "BLOCKED" | "COMPLETED" | "CANCELED";
      },
      ctx: McpContext,
    ) {
      if (input.status === "RUNNING") {
        const { activatePlan } = await import("@/server/services/orchestration-service");
        await db.$transaction((tx) =>
          activatePlan(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId ?? null,
            planId: input.id,
          }),
        );
      } else {
        const { updateExecutionPlan } = await import("@/server/services/execution-plan-service");
        await updateExecutionPlan(db, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          planId: input.id,
          status: input.status as never,
        });
      }
      return { ok: true };
    },
  },

  "executionPlans.transitionStep": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      stepId: z.string().cuid(),
      status: z.enum(["TODO", "READY", "RUNNING", "BLOCKED", "REVIEW", "DONE", "CANCELED"]),
      sourceRunId: z.string().cuid().nullable().optional(),
    }),
    async run(
      input: {
        stepId: string;
        status: "TODO" | "READY" | "RUNNING" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELED";
        sourceRunId?: string | null;
      },
      ctx: McpContext,
    ) {
      const { updateExecutionStep } = await import("@/server/services/execution-plan-service");
      await updateExecutionStep(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        stepId: input.stepId,
        status: input.status as never,
        sourceRunId: input.sourceRunId === undefined ? undefined : input.sourceRunId,
      });
      return { ok: true };
    },
  },

  // ---------------------------------------------------------- WorkspaceCanvas
  //
  // Read-only access for agents. Canvases hold layout + entity refs,
  // never canonical content; mutation stays in the human UI for v0.

  "canvases.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      scopeType: z.string().max(40).optional(),
      scopeId: z.string().max(40).optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(
      input: { scopeType?: string; scopeId?: string; includeArchived: boolean; limit: number },
      ctx: McpContext,
    ) {
      return db.workspaceCanvas.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: { _count: { select: { nodes: true, edges: true } } },
      });
    },
  },

  "canvases.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const row = await db.workspaceCanvas.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        include: {
          nodes: { orderBy: { zIndex: "asc" } },
          edges: true,
        },
      });
      if (!row) throw new Error("Canvas not found.");
      return row;
    },
  },

  "canvases.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      name: z.string().min(1).max(200),
      scopeType: z.string().max(40).nullable().optional(),
      scopeId: z.string().max(40).nullable().optional(),
    }),
    async run(
      input: { name: string; scopeType?: string | null; scopeId?: string | null },
      ctx: McpContext,
    ) {
      let scopeType: ForgeEntityType | null = null;
      let scopeId: string | null = null;
      if (input.scopeType || input.scopeId) {
        if (!input.scopeType || !input.scopeId) {
          throw new Error("Canvas scopeType and scopeId must be provided together.");
        }
        const parsed = forgeEntityTypeSchema.safeParse(input.scopeType);
        if (!parsed.success) throw new Error("Canvas scopeType must be a known Forge entity type.");
        await assertMcpCanvasRef(ctx, parsed.data, input.scopeId);
        scopeType = parsed.data;
        scopeId = input.scopeId;
      }
      const canvas = await db.$transaction(async (tx) => {
        const created = await tx.workspaceCanvas.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: input.name.trim(),
            scopeType,
            scopeId,
            createdById: ctx.userId ?? null,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: created.id,
          action: "created",
          after: { name: created.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: created.id,
        });
        return created;
      });
      return { id: canvas.id, name: canvas.name };
    },
  },

  "canvases.addNode": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      targetType: forgeEntityTypeSchema,
      targetId: z.string().min(1),
      x: z.number(),
      y: z.number(),
      width: z.number().min(40).max(8_000).default(280),
      height: z.number().min(40).max(8_000).default(120),
      zIndex: z.number().int().optional(),
      collapsed: z.boolean().optional(),
      viewMode: z.string().max(20).nullable().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        targetType: string;
        targetId: string;
        x: number;
        y: number;
        width: number;
        height: number;
        zIndex?: number;
        collapsed?: boolean;
        viewMode?: string | null;
      },
      ctx: McpContext,
    ) {
      await assertMcpCanvasRef(ctx, input.targetType as ForgeEntityType, input.targetId);
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const node = await db.$transaction(async (tx) => {
        const created = await tx.workspaceCanvasNode.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            targetType: input.targetType,
            targetId: input.targetId,
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
            zIndex: input.zIndex ?? 0,
            collapsed: input.collapsed ?? false,
            viewMode: input.viewMode ?? null,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "node_added",
          after: { nodeId: created.id, targetType: input.targetType, targetId: input.targetId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { id: node.id };
    },
  },

  "canvases.patchNode": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(40).max(8_000).optional(),
      height: z.number().min(40).max(8_000).optional(),
      zIndex: z.number().int().optional(),
      collapsed: z.boolean().optional(),
      viewMode: z.string().max(20).nullable().optional(),
    }),
    async run(
      input: {
        id: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        zIndex?: number;
        collapsed?: boolean;
        viewMode?: string | null;
      },
      ctx: McpContext,
    ) {
      const node = await db.workspaceCanvasNode.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!node) throw new Error("Canvas node not found.");
      await db.$transaction(async (tx) => {
        await tx.workspaceCanvasNode.update({
          where: { id: input.id },
          data: {
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
            zIndex: input.zIndex,
            collapsed: input.collapsed,
            viewMode: input.viewMode === undefined ? undefined : input.viewMode,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: node.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: node.canvasId,
          action: "node_updated",
          after: { nodeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: node.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.removeNode": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const node = await db.workspaceCanvasNode.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!node) throw new Error("Canvas node not found.");
      await db.$transaction(async (tx) => {
        await tx.workspaceCanvasEdge.deleteMany({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [{ fromNodeId: input.id }, { toNodeId: input.id }],
          },
        });
        await tx.workspaceCanvasNode.delete({ where: { id: input.id } });
        await tx.workspaceCanvas.update({
          where: { id: node.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: node.canvasId,
          action: "node_removed",
          before: { nodeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: node.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.addEdge": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      fromNodeId: z.string().cuid(),
      toNodeId: z.string().cuid(),
      label: z.string().max(200).nullable().optional(),
      kind: z.string().max(40).nullable().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        fromNodeId: string;
        toNodeId: string;
        label?: string | null;
        kind?: string | null;
      },
      ctx: McpContext,
    ) {
      const [canvas, from, to] = await Promise.all([
        db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        db.workspaceCanvasNode.findFirst({
          where: {
            id: input.fromNodeId,
            canvasId: input.canvasId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        }),
        db.workspaceCanvasNode.findFirst({
          where: {
            id: input.toNodeId,
            canvasId: input.canvasId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        }),
      ]);
      if (!canvas || !from || !to) {
        throw new Error("Canvas, fromNode, or toNode missing from this workspace.");
      }
      const edge = await db.$transaction(async (tx) => {
        const created = await tx.workspaceCanvasEdge.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            fromNodeId: input.fromNodeId,
            toNodeId: input.toNodeId,
            label: input.label ?? null,
            kind: input.kind ?? null,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "edge_added",
          after: { edgeId: created.id, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { id: edge.id };
    },
  },

  "canvases.removeEdge": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const edge = await db.workspaceCanvasEdge.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!edge) throw new Error("Canvas edge not found.");
      await db.$transaction(async (tx) => {
        await tx.workspaceCanvasEdge.delete({ where: { id: input.id } });
        await tx.workspaceCanvas.update({
          where: { id: edge.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: edge.canvasId,
          action: "edge_removed",
          before: { edgeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: edge.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.edgePatch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      label: z.string().max(200).nullable().optional(),
      kind: z.string().max(40).nullable().optional(),
      meta: z.unknown().optional(),
    }),
    async run(
      input: {
        id: string;
        label?: string | null;
        kind?: string | null;
        meta?: unknown;
      },
      ctx: McpContext,
    ) {
      const edge = await db.workspaceCanvasEdge.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!edge) throw new Error("Canvas edge not found.");
      const data: Prisma.WorkspaceCanvasEdgeUpdateInput = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.kind !== undefined) data.kind = input.kind;
      if (input.meta !== undefined) {
        data.meta = input.meta === null ? Prisma.JsonNull : (input.meta as Prisma.InputJsonValue);
      }
      await db.$transaction(async (tx) => {
        await tx.workspaceCanvasEdge.update({ where: { id: input.id }, data });
        await tx.workspaceCanvas.update({
          where: { id: edge.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: edge.canvasId,
          action: "edge_updated",
          after: { edgeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: edge.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.shapeAdd": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      kind: z.enum(["box", "ellipse", "line", "arrow", "text", "freehand"]),
      x: z.number(),
      y: z.number(),
      width: z.number().optional(),
      height: z.number().optional(),
      path: z.unknown().optional(),
      style: z.unknown().optional(),
      text: z.string().max(50_000).optional(),
      groupId: z.string().max(80).optional(),
      zIndex: z.number().int().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        kind: "box" | "ellipse" | "line" | "arrow" | "text" | "freehand";
        x: number;
        y: number;
        width?: number;
        height?: number;
        path?: unknown;
        style?: unknown;
        text?: string;
        groupId?: string;
        zIndex?: number;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const shape = await db.$transaction(async (tx) => {
        const created = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: input.kind,
            x: input.x,
            y: input.y,
            width: input.width ?? null,
            height: input.height ?? null,
            path: (input.path ?? undefined) as Prisma.InputJsonValue | undefined,
            style: (input.style ?? undefined) as Prisma.InputJsonValue | undefined,
            text: input.text ?? null,
            groupId: input.groupId ?? null,
            zIndex: input.zIndex ?? 0,
            createdById: ctx.userId ?? null,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "shape_added",
          after: { shapeId: created.id, kind: created.kind },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { ok: true, id: shape.id };
    },
  },

  "canvases.shapePatch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      path: z.unknown().optional(),
      style: z.unknown().optional(),
      text: z.string().max(50_000).nullable().optional(),
      groupId: z.string().max(80).nullable().optional(),
      zIndex: z.number().int().optional(),
    }),
    async run(
      input: {
        id: string;
        x?: number;
        y?: number;
        width?: number | null;
        height?: number | null;
        path?: unknown;
        style?: unknown;
        text?: string | null;
        groupId?: string | null;
        zIndex?: number;
      },
      ctx: McpContext,
    ) {
      const shape = await db.canvasShape.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!shape) throw new Error("Canvas shape not found.");
      const data: Prisma.CanvasShapeUpdateInput = {};
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.path !== undefined) {
        data.path = input.path === null ? Prisma.JsonNull : (input.path as Prisma.InputJsonValue);
      }
      if (input.style !== undefined) {
        data.style =
          input.style === null ? Prisma.JsonNull : (input.style as Prisma.InputJsonValue);
      }
      if (input.text !== undefined) data.text = input.text;
      if (input.groupId !== undefined) data.groupId = input.groupId;
      if (input.zIndex !== undefined) data.zIndex = input.zIndex;
      await db.$transaction(async (tx) => {
        await tx.canvasShape.update({ where: { id: input.id }, data });
        await tx.workspaceCanvas.update({
          where: { id: shape.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: shape.canvasId,
          action: "shape_updated",
          after: { shapeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: shape.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.shapeRemove": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const shape = await db.canvasShape.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!shape) throw new Error("Canvas shape not found.");
      await db.$transaction(async (tx) => {
        await tx.canvasShape.delete({ where: { id: input.id } });
        await tx.workspaceCanvas.update({
          where: { id: shape.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: shape.canvasId,
          action: "shape_removed",
          before: { shapeId: input.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: shape.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.bulkAddShapes": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      shapes: z
        .array(
          z.object({
            kind: z.enum(["box", "ellipse", "line", "arrow", "text", "freehand"]),
            x: z.number(),
            y: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            path: z.unknown().optional(),
            style: z.unknown().optional(),
            text: z.string().max(50_000).optional(),
            groupId: z.string().max(80).optional(),
            zIndex: z.number().int().optional(),
          }),
        )
        .min(1)
        .max(50),
    }),
    async run(
      input: {
        canvasId: string;
        shapes: Array<{
          kind: "box" | "ellipse" | "line" | "arrow" | "text" | "freehand";
          x: number;
          y: number;
          width?: number;
          height?: number;
          path?: unknown;
          style?: unknown;
          text?: string;
          groupId?: string;
          zIndex?: number;
        }>;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const ids = await db.$transaction(async (tx) => {
        const created: string[] = [];
        for (const s of input.shapes) {
          const row = await tx.canvasShape.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              kind: s.kind,
              x: s.x,
              y: s.y,
              width: s.width ?? null,
              height: s.height ?? null,
              path: (s.path ?? undefined) as Prisma.InputJsonValue | undefined,
              style: (s.style ?? undefined) as Prisma.InputJsonValue | undefined,
              text: s.text ?? null,
              groupId: s.groupId ?? null,
              zIndex: s.zIndex ?? 0,
              createdById: ctx.userId ?? null,
            },
            select: { id: true },
          });
          created.push(row.id);
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "shapes_bulk_added",
          after: { count: created.length, ids: created },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { ok: true as const, ids };
    },
  },

  "canvases.applyTemplate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      templateId: z.enum([
        "decision_matrix",
        "retro",
        "architecture",
        "standup",
        "okr_tree",
        "empty",
      ]),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
    async run(
      input: {
        canvasId: string;
        templateId: "decision_matrix" | "retro" | "architecture" | "standup" | "okr_tree" | "empty";
        position?: { x: number; y: number };
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const template = MCP_CANVAS_TEMPLATES[input.templateId];
      if (!template) throw new Error("Unknown template id.");
      const offsetX = input.position?.x ?? 0;
      const offsetY = input.position?.y ?? 0;

      const { createArtifact } = await import("@/server/services/artifact-service");
      const noteArtifactByKey = new Map<string, string>();
      for (const n of template.nodes) {
        const trimmedBody = (n.noteBody ?? "").trim();
        const firstLine = trimmedBody.split(/\r?\n/)[0]?.trim() ?? "";
        const title = firstLine.length
          ? firstLine.slice(0, 180)
          : `Note ${new Date().toISOString().slice(0, 10)}`;
        const artifact = await createArtifact(db, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          title,
          body: n.noteBody ?? "",
          type: ArtifactType.NOTE,
        });
        noteArtifactByKey.set(n.key, artifact.id);
      }

      const ids = await db.$transaction(async (tx) => {
        const created: string[] = [];
        const keyToNodeId = new Map<string, string>();
        for (const n of template.nodes) {
          const artifactId = noteArtifactByKey.get(n.key)!;
          const node = await tx.workspaceCanvasNode.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              targetType: "artifact",
              targetId: artifactId,
              x: n.x + offsetX,
              y: n.y + offsetY,
              width: n.width ?? 240,
              height: n.height ?? 160,
              zIndex: 0,
              viewMode: "card",
              meta: { kind: "NOTE", ...(n.lane ? { lane: n.lane } : {}) },
            },
            select: { id: true },
          });
          created.push(node.id);
          keyToNodeId.set(n.key, node.id);
        }
        for (const e of template.edges ?? []) {
          const fromId = keyToNodeId.get(e.from);
          const toId = keyToNodeId.get(e.to);
          if (!fromId || !toId) continue;
          await tx.workspaceCanvasEdge.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              fromNodeId: fromId,
              toNodeId: toId,
              label: e.label ?? null,
              kind: e.kind ?? null,
            },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "template_applied",
          after: {
            templateId: input.templateId,
            nodeCount: created.length,
            edgeCount: template.edges?.length ?? 0,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { ok: true as const, ids };
    },
  },

  "canvases.layout": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      algorithm: z.enum(["topological", "force", "grid"]),
    }),
    async run(
      input: { canvasId: string; algorithm: "topological" | "force" | "grid" },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        include: {
          nodes: { select: { id: true, x: true, y: true, targetType: true, targetId: true } },
          edges: { select: { fromNodeId: true, toNodeId: true } },
        },
      });
      if (!canvas) throw new Error("Canvas not found.");
      if (canvas.nodes.length === 0) return { ok: true as const, count: 0 };

      const positions =
        input.algorithm === "topological"
          ? mcpTopologicalLayout(canvas.nodes, canvas.edges)
          : input.algorithm === "force"
            ? mcpForceLayout(canvas.nodes, canvas.edges)
            : mcpGridLayout(canvas.nodes);

      let updated = 0;
      await db.$transaction(async (tx) => {
        for (const node of canvas.nodes) {
          const pos = positions.get(node.id);
          if (!pos) continue;
          await tx.workspaceCanvasNode.update({
            where: { id: node.id },
            data: { x: pos.x, y: pos.y },
          });
          updated += 1;
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "layout_applied",
          after: { algorithm: input.algorithm, count: updated },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true as const, count: updated };
    },
  },

  "canvases.addNote": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      body: z.string().max(200_000).default(""),
      x: z.number(),
      y: z.number(),
    }),
    async run(input: { canvasId: string; body: string; x: number; y: number }, ctx: McpContext) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const trimmedBody = input.body.trim();
      const firstLine = trimmedBody.split(/\r?\n/)[0]?.trim() ?? "";
      const title = firstLine.length
        ? firstLine.slice(0, 180)
        : `Note ${new Date().toISOString().slice(0, 10)}`;
      const { createArtifact } = await import("@/server/services/artifact-service");
      const { id: artifactId } = await createArtifact(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title,
        body: input.body,
        type: ArtifactType.NOTE,
      });
      const node = await db.workspaceCanvasNode.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          targetType: "artifact",
          targetId: artifactId,
          x: input.x,
          y: input.y,
          width: 240,
          height: 160,
          zIndex: 0,
          viewMode: "card",
          meta: { kind: "NOTE" },
        },
      });
      await db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { updatedAt: new Date() },
      });
      return { nodeId: node.id, artifactId };
    },
  },

  "canvases.addChatThread": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      threadId: z.string().cuid(),
      x: z.number(),
      y: z.number(),
    }),
    async run(
      input: { canvasId: string; threadId: string; x: number; y: number },
      ctx: McpContext,
    ) {
      const [canvas, thread] = await Promise.all([
        db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        db.chatThread.findFirst({
          where: {
            id: input.threadId,
            workspaceId: ctx.workspaceId,
            // MCP callers (agents) may not own the thread; we require
            // either an owning user or a linked agent that matches the
            // thread's agent.
            OR: [
              ...(ctx.userId ? [{ userId: ctx.userId }] : []),
              ...(ctx.apiKey?.linkedAgentId ? [{ agentId: ctx.apiKey.linkedAgentId }] : []),
            ],
          },
          select: { id: true },
        }),
      ]);
      if (!canvas) throw new Error("Canvas not found.");
      if (!thread) throw new Error("Chat thread not found or not visible to caller.");
      const node = await db.workspaceCanvasNode.create({
        data: {
          workspaceId: ctx.workspaceId,
          canvasId: input.canvasId,
          targetType: "chat-thread",
          targetId: input.threadId,
          x: input.x,
          y: input.y,
          width: 280,
          height: 200,
          zIndex: 0,
          viewMode: "card",
        },
      });
      await db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { updatedAt: new Date() },
      });
      return { nodeId: node.id };
    },
  },

  "canvases.convertToPlan": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      title: z.string().min(1).max(300).optional(),
    }),
    async run(input: { canvasId: string; title?: string }, ctx: McpContext) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        include: { nodes: true, edges: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const skippedNodes: Array<{ nodeId: string; reason: string }> = [];
      const sortedNodes = [...canvas.nodes].sort((a, b) => {
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });

      const artifactNodes = sortedNodes.filter((n) => n.targetType === "artifact");
      const artifactRows = artifactNodes.length
        ? await db.artifact.findMany({
            where: {
              id: { in: artifactNodes.map((n) => n.targetId) },
              workspaceId: ctx.workspaceId,
              archivedAt: null,
            },
            select: { id: true, title: true, body: true, type: true },
          })
        : [];
      const artifactById = new Map(artifactRows.map((a) => [a.id, a] as const));

      const existingStepIds = sortedNodes
        .filter((n) => n.targetType === "execution-step")
        .map((n) => n.targetId);
      const existingStepRows = existingStepIds.length
        ? await db.executionStep.findMany({
            where: { id: { in: existingStepIds }, workspaceId: ctx.workspaceId },
            select: { id: true, title: true, body: true, expectedOutput: true },
          })
        : [];
      const existingStepById = new Map(existingStepRows.map((s) => [s.id, s] as const));

      interface PendingStep {
        canvasNodeId: string;
        title: string;
        body: string | null;
        expectedOutput: string | null;
      }
      const pending: PendingStep[] = [];

      for (const node of sortedNodes) {
        if (node.targetType === "execution-step") {
          const row = existingStepById.get(node.targetId);
          if (!row) {
            skippedNodes.push({
              nodeId: node.id,
              reason: "execution-step target not found in this workspace",
            });
            continue;
          }
          pending.push({
            canvasNodeId: node.id,
            title: row.title,
            body: row.body ?? null,
            expectedOutput: row.expectedOutput ?? null,
          });
          continue;
        }
        if (node.targetType === "artifact") {
          const artifact = artifactById.get(node.targetId);
          if (!artifact) {
            skippedNodes.push({
              nodeId: node.id,
              reason: "artifact target not found in this workspace",
            });
            continue;
          }
          const isNote =
            artifact.type === ArtifactType.NOTE ||
            (node.meta &&
              typeof node.meta === "object" &&
              (node.meta as { kind?: unknown }).kind === "NOTE");
          if (!isNote) {
            skippedNodes.push({
              nodeId: node.id,
              reason: `artifact target kind ${artifact.type} is not NOTE`,
            });
            continue;
          }
          const trimmed = (artifact.body ?? "").trim();
          const lines = trimmed.length ? trimmed.split(/\r?\n/) : [];
          const firstLine = lines[0]?.trim() ?? "";
          const rest = lines.slice(1).join("\n").trim();
          const title = firstLine.length ? firstLine.slice(0, 280) : artifact.title;
          pending.push({
            canvasNodeId: node.id,
            title: title || "Untitled step",
            body: rest.length ? rest : null,
            expectedOutput: null,
          });
          continue;
        }
        skippedNodes.push({
          nodeId: node.id,
          reason: `targetType ${node.targetType} is not convertible (only execution-step and artifact NOTE)`,
        });
      }

      const includedCanvasNodeIds = new Set(pending.map((p) => p.canvasNodeId));
      const dependsByTo = new Map<string, string[]>();
      for (const edge of canvas.edges) {
        if (edge.kind !== "depends_on") continue;
        if (!includedCanvasNodeIds.has(edge.fromNodeId)) continue;
        if (!includedCanvasNodeIds.has(edge.toNodeId)) continue;
        const list = dependsByTo.get(edge.toNodeId) ?? [];
        list.push(edge.fromNodeId);
        dependsByTo.set(edge.toNodeId, list);
      }

      const planTitle = (input.title ?? canvas.name).trim() || canvas.name;
      const today = new Date().toISOString().slice(0, 10);
      const planDescription = `Imported from canvas '${canvas.name}' on ${today}.`;

      const result = await db.$transaction(async (tx) => {
        const plan = await tx.executionPlan.create({
          data: {
            workspaceId: ctx.workspaceId,
            title: planTitle,
            description: planDescription,
            status: ExecutionPlanStatus.DRAFT,
            createdById: ctx.userId ?? null,
            createdByAgentId: ctx.apiKey?.linkedAgentId ?? null,
          },
        });
        const canvasNodeIdToStepId = new Map<string, string>();
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i]!;
          const step = await tx.executionStep.create({
            data: {
              workspaceId: ctx.workspaceId,
              planId: plan.id,
              title: p.title.trim() || "Untitled step",
              body: p.body,
              expectedOutput: p.expectedOutput,
              position: i,
              dependsOnStepIds: [],
            },
            select: { id: true },
          });
          canvasNodeIdToStepId.set(p.canvasNodeId, step.id);
        }
        for (const p of pending) {
          const deps = dependsByTo.get(p.canvasNodeId);
          if (!deps || deps.length === 0) continue;
          const realIds = deps
            .map((nodeId) => canvasNodeIdToStepId.get(nodeId))
            .filter((id): id is string => Boolean(id));
          if (realIds.length === 0) continue;
          const stepId = canvasNodeIdToStepId.get(p.canvasNodeId)!;
          await tx.executionStep.update({
            where: { id: stepId },
            data: { dependsOnStepIds: realIds },
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "execution-plan",
          entityId: plan.id,
          action: "created",
          after: {
            title: plan.title,
            status: plan.status,
            stepCount: pending.length,
            sourceCanvasId: canvas.id,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "execution-plan",
          subjectId: plan.id,
        });
        return { planId: plan.id, stepCount: pending.length };
      });

      return {
        planId: result.planId,
        stepCount: result.stepCount,
        skippedNodes,
      };
    },
  },

  // -------------------------------------------------------- Canvas styles
  //
  // Workspace-scoped design tokens (color / text / effect). Nodes / shapes /
  // frames carry a `styleRefs` JSON map; rendering looks up the row here so
  // edits cascade to every consumer.

  "canvases.styleCreate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      kind: z.enum(["COLOR", "TEXT", "EFFECT"]),
      name: z.string().min(1).max(120),
      value: z.unknown(),
    }),
    async run(
      input: { kind: "COLOR" | "TEXT" | "EFFECT"; name: string; value: unknown },
      ctx: McpContext,
    ) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error("Style name cannot be blank.");
      try {
        const created = await db.$transaction(async (tx) => {
          const row = await tx.canvasStyle.create({
            data: {
              workspaceId: ctx.workspaceId,
              kind: input.kind as CanvasStyleKind,
              name: trimmed,
              value: (input.value ?? {}) as Prisma.InputJsonValue,
              createdById: ctx.userId ?? null,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId ?? null,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "canvas-style",
            entityId: row.id,
            action: "created",
            after: { kind: row.kind, name: row.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-style",
            subjectId: row.id,
          });
          return row;
        });
        return { id: created.id, kind: created.kind, name: created.name };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new Error(
            `A ${input.kind} style named "${trimmed}" already exists in this workspace.`,
          );
        }
        throw err;
      }
    },
  },

  "canvases.styleList": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      kind: z.enum(["COLOR", "TEXT", "EFFECT"]).optional(),
      includeArchived: z.boolean().default(false),
    }),
    async run(
      input: { kind?: "COLOR" | "TEXT" | "EFFECT"; includeArchived: boolean },
      ctx: McpContext,
    ) {
      const rows = await db.canvasStyle.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          kind: input.kind ? (input.kind as CanvasStyleKind) : undefined,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
      });
      return { items: rows };
    },
  },

  "canvases.styleUpdate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      styleId: z.string().cuid(),
      name: z.string().min(1).max(120).optional(),
      value: z.unknown().optional(),
    }),
    async run(input: { styleId: string; name?: string; value?: unknown }, ctx: McpContext) {
      const existing = await db.canvasStyle.findFirst({
        where: { id: input.styleId, workspaceId: ctx.workspaceId },
        select: { id: true, kind: true, name: true },
      });
      if (!existing) throw new Error("Canvas style not found.");
      const data: Prisma.CanvasStyleUpdateInput = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) throw new Error("Style name cannot be blank.");
        data.name = trimmed;
      }
      if (input.value !== undefined) {
        data.value = (input.value ?? {}) as Prisma.InputJsonValue;
      }
      try {
        await db.$transaction(async (tx) => {
          await tx.canvasStyle.update({ where: { id: input.styleId }, data });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId ?? null,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "canvas-style",
            entityId: input.styleId,
            action: "updated",
            after: { name: data.name ?? existing.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-style",
            subjectId: input.styleId,
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new Error(`A ${existing.kind} style with that name already exists.`);
        }
        throw err;
      }
      return { ok: true };
    },
  },

  "canvases.styleDelete": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ styleId: z.string().cuid() }),
    async run(input: { styleId: string }, ctx: McpContext) {
      const existing = await db.canvasStyle.findFirst({
        where: { id: input.styleId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true, name: true },
      });
      if (!existing) throw new Error("Canvas style not found.");
      if (existing.archivedAt) return { ok: true };
      await db.$transaction(async (tx) => {
        await tx.canvasStyle.update({
          where: { id: input.styleId },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-style",
          entityId: input.styleId,
          action: "archived",
          before: { name: existing.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "canvas-style",
          subjectId: input.styleId,
        });
      });
      return { ok: true };
    },
  },

  // -------------------------------------------------------- Canvas components
  //
  // Workspace-scoped reusable definitions. Instances on a canvas render
  // against the snapshot tree; overrides are sparse diffs applied at
  // render time. Detaching expands the definition into raw rows.

  "canvases.componentCreate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2_000).nullable().optional(),
      thumbnail: z.string().max(200_000).nullable().optional(),
      definition: z
        .object({
          nodes: z.array(z.unknown()).default([]),
          shapes: z.array(z.unknown()).default([]),
          frames: z.array(z.unknown()).default([]),
          edges: z.array(z.unknown()).default([]),
          width: z.number().min(1).max(20_000),
          height: z.number().min(1).max(20_000),
        })
        .passthrough(),
    }),
    async run(
      input: {
        name: string;
        description?: string | null;
        thumbnail?: string | null;
        definition: {
          nodes: unknown[];
          shapes: unknown[];
          frames: unknown[];
          edges: unknown[];
          width: number;
          height: number;
        };
      },
      ctx: McpContext,
    ) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error("Component name cannot be blank.");
      try {
        const created = await db.$transaction(async (tx) => {
          const row = await tx.canvasComponent.create({
            data: {
              workspaceId: ctx.workspaceId,
              name: trimmed,
              description: input.description ?? null,
              thumbnail: input.thumbnail ?? null,
              definition: input.definition as unknown as Prisma.InputJsonValue,
              createdById: ctx.userId ?? null,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId ?? null,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "canvas-component",
            entityId: row.id,
            action: "created",
            after: { name: row.name },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-component",
            subjectId: row.id,
          });
          return row;
        });
        return { id: created.id, name: created.name };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new Error(`A component named "${trimmed}" already exists in this workspace.`);
        }
        throw err;
      }
    },
  },

  "canvases.componentList": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ includeArchived: z.boolean().default(false) }),
    async run(input: { includeArchived: boolean }, ctx: McpContext) {
      const rows = await db.canvasComponent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          description: true,
          thumbnail: true,
          createdAt: true,
          updatedAt: true,
          archivedAt: true,
          _count: { select: { instances: true } },
        },
      });
      return { items: rows };
    },
  },

  "canvases.componentGet": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ componentId: z.string().cuid() }),
    async run(input: { componentId: string }, ctx: McpContext) {
      const row = await db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
      });
      if (!row) throw new Error("Component not found.");
      return row;
    },
  },

  "canvases.componentUpdate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      componentId: z.string().cuid(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2_000).nullable().optional(),
      thumbnail: z.string().max(200_000).nullable().optional(),
      definition: z
        .object({
          nodes: z.array(z.unknown()).default([]),
          shapes: z.array(z.unknown()).default([]),
          frames: z.array(z.unknown()).default([]),
          edges: z.array(z.unknown()).default([]),
          width: z.number().min(1).max(20_000),
          height: z.number().min(1).max(20_000),
        })
        .passthrough()
        .optional(),
    }),
    async run(
      input: {
        componentId: string;
        name?: string;
        description?: string | null;
        thumbnail?: string | null;
        definition?: {
          nodes: unknown[];
          shapes: unknown[];
          frames: unknown[];
          edges: unknown[];
          width: number;
          height: number;
        };
      },
      ctx: McpContext,
    ) {
      const existing = await db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true },
      });
      if (!existing) throw new Error("Component not found.");
      const data: Prisma.CanvasComponentUpdateInput = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) throw new Error("Component name cannot be blank.");
        data.name = trimmed;
      }
      if (input.description !== undefined) data.description = input.description;
      if (input.thumbnail !== undefined) data.thumbnail = input.thumbnail;
      if (input.definition !== undefined) {
        data.definition = input.definition as unknown as Prisma.InputJsonValue;
      }
      try {
        await db.$transaction(async (tx) => {
          await tx.canvasComponent.update({ where: { id: input.componentId }, data });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId ?? null,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "canvas-component",
            entityId: input.componentId,
            action: "updated",
            after: {
              name: data.name ?? existing.name,
              definitionUpdated: input.definition !== undefined,
            },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "canvas-component",
            subjectId: input.componentId,
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new Error("A component with that name already exists.");
        }
        throw err;
      }
      return { ok: true };
    },
  },

  "canvases.componentArchive": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ componentId: z.string().cuid() }),
    async run(input: { componentId: string }, ctx: McpContext) {
      const existing = await db.canvasComponent.findFirst({
        where: { id: input.componentId, workspaceId: ctx.workspaceId },
        select: { id: true, archivedAt: true, name: true },
      });
      if (!existing) throw new Error("Component not found.");
      if (existing.archivedAt) return { ok: true };
      await db.$transaction(async (tx) => {
        await tx.canvasComponent.update({
          where: { id: input.componentId },
          data: { archivedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-component",
          entityId: input.componentId,
          action: "archived",
          before: { name: existing.name },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "canvas-component",
          subjectId: input.componentId,
        });
      });
      return { ok: true };
    },
  },

  // -------------------------------------------------------- Component instances

  "canvases.instanceCreate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      componentId: z.string().cuid(),
      x: z.number(),
      y: z.number(),
      width: z.number().min(1).max(20_000).optional(),
      height: z.number().min(1).max(20_000).optional(),
      parentFrameId: z.string().cuid().nullable().optional(),
      groupId: z.string().cuid().nullable().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        componentId: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
        parentFrameId?: string | null;
        groupId?: string | null;
      },
      ctx: McpContext,
    ) {
      const [canvas, component] = await Promise.all([
        db.workspaceCanvas.findFirst({
          where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        }),
        db.canvasComponent.findFirst({
          where: { id: input.componentId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true, definition: true },
        }),
      ]);
      if (!canvas) throw new Error("Canvas not found.");
      if (!component) throw new Error("Component not found or archived.");
      const def = component.definition as { width?: number; height?: number } | null;
      const fallbackW = typeof def?.width === "number" ? def.width : 320;
      const fallbackH = typeof def?.height === "number" ? def.height : 200;
      if (input.parentFrameId) {
        const frame = await db.canvasFrame.findFirst({
          where: {
            id: input.parentFrameId,
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
          },
          select: { id: true },
        });
        if (!frame) throw new Error("parentFrameId not found on this canvas.");
      }
      if (input.groupId) {
        const group = await db.canvasGroup.findFirst({
          where: { id: input.groupId, workspaceId: ctx.workspaceId, canvasId: input.canvasId },
          select: { id: true },
        });
        if (!group) throw new Error("groupId not found on this canvas.");
      }
      const row = await db.$transaction(async (tx) => {
        const created = await tx.canvasComponentInstance.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            componentId: input.componentId,
            x: input.x,
            y: input.y,
            width: input.width ?? fallbackW,
            height: input.height ?? fallbackH,
            parentFrameId: input.parentFrameId ?? null,
            groupId: input.groupId ?? null,
            overrides: {} as Prisma.InputJsonValue,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "instance_added",
          after: { instanceId: created.id, componentId: input.componentId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
      return { id: row.id };
    },
  },

  "canvases.instancePatch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      instanceId: z.string().cuid(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(1).max(20_000).optional(),
      height: z.number().min(1).max(20_000).optional(),
      overrides: z.record(z.unknown()).nullable().optional(),
      lockedAt: z.union([z.string().datetime(), z.null()]).optional(),
      hiddenAt: z.union([z.string().datetime(), z.null()]).optional(),
    }),
    async run(
      input: {
        instanceId: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        overrides?: Record<string, unknown> | null;
        lockedAt?: string | null;
        hiddenAt?: string | null;
      },
      ctx: McpContext,
    ) {
      const existing = await db.canvasComponentInstance.findFirst({
        where: { id: input.instanceId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!existing) throw new Error("Component instance not found.");
      const data: Prisma.CanvasComponentInstanceUpdateInput = {};
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.overrides !== undefined) {
        data.overrides =
          input.overrides === null ? Prisma.JsonNull : (input.overrides as Prisma.InputJsonValue);
      }
      if (input.lockedAt !== undefined) {
        data.lockedAt = input.lockedAt === null ? null : new Date(input.lockedAt);
      }
      if (input.hiddenAt !== undefined) {
        data.hiddenAt = input.hiddenAt === null ? null : new Date(input.hiddenAt);
      }
      await db.$transaction(async (tx) => {
        await tx.canvasComponentInstance.update({ where: { id: input.instanceId }, data });
        await tx.workspaceCanvas.update({
          where: { id: existing.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: existing.canvasId,
          action: "instance_updated",
          after: { instanceId: input.instanceId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: existing.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.instanceDetach": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ instanceId: z.string().cuid() }),
    async run(input: { instanceId: string }, ctx: McpContext) {
      const instance = await db.canvasComponentInstance.findFirst({
        where: { id: input.instanceId, workspaceId: ctx.workspaceId },
        include: { component: { select: { id: true, definition: true } } },
      });
      if (!instance) throw new Error("Component instance not found.");
      type CompDef = {
        nodes?: unknown[];
        shapes?: unknown[];
        frames?: unknown[];
        edges?: unknown[];
        width?: number;
        height?: number;
      };
      const def = (instance.component.definition ?? {}) as CompDef;
      const overrides = (instance.overrides ?? {}) as Record<string, unknown>;
      const cloned: CompDef = JSON.parse(JSON.stringify(def));
      for (const [path, value] of Object.entries(overrides)) {
        const parts = path.split(".");
        if (parts.length < 2) continue;
        const [bucket, idxStr, ...rest] = parts;
        const idx = Number(idxStr);
        if (!bucket || Number.isNaN(idx)) continue;
        const list = (cloned as unknown as Record<string, unknown[]>)[bucket];
        if (!Array.isArray(list) || idx < 0 || idx >= list.length) continue;
        if (rest.length === 0) {
          list[idx] = value;
          continue;
        }
        let target = list[idx] as Record<string, unknown> | undefined;
        for (let i = 0; i < rest.length - 1; i++) {
          if (!target || typeof target !== "object") {
            target = undefined;
            break;
          }
          const next = target[rest[i]!] as Record<string, unknown> | undefined;
          if (!next || typeof next !== "object") {
            target[rest[i]!] = {};
            target = target[rest[i]!] as Record<string, unknown>;
          } else {
            target = next;
          }
        }
        if (target) target[rest[rest.length - 1]!] = value;
      }
      const created = await db.$transaction(async (tx) => {
        const nodeIds: string[] = [];
        const shapeIds: string[] = [];
        const frameIds: string[] = [];
        const dx = instance.x;
        const dy = instance.y;
        for (const raw of cloned.nodes ?? []) {
          const n = raw as Record<string, unknown>;
          if (typeof n?.targetType !== "string" || typeof n?.targetId !== "string") continue;
          const row = await tx.workspaceCanvasNode.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              targetType: n.targetType,
              targetId: n.targetId,
              x: dx + Number((n.x as number) ?? 0),
              y: dy + Number((n.y as number) ?? 0),
              width: Number((n.width as number) ?? 240),
              height: Number((n.height as number) ?? 160),
              zIndex: Number((n.zIndex as number) ?? 0),
              viewMode: typeof n.viewMode === "string" ? n.viewMode : null,
              meta: (n.meta as Prisma.InputJsonValue | undefined) ?? undefined,
              styleRefs: (n.styleRefs as Prisma.InputJsonValue | undefined) ?? undefined,
              parentFrameId: instance.parentFrameId ?? null,
              groupId: instance.groupId ?? null,
            },
            select: { id: true },
          });
          nodeIds.push(row.id);
        }
        for (const raw of cloned.shapes ?? []) {
          const s = raw as Record<string, unknown>;
          if (typeof s?.kind !== "string") continue;
          const row = await tx.canvasShape.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              kind: s.kind,
              x: dx + Number((s.x as number) ?? 0),
              y: dy + Number((s.y as number) ?? 0),
              width: s.width === undefined || s.width === null ? null : Number(s.width),
              height: s.height === undefined || s.height === null ? null : Number(s.height),
              path: (s.path as Prisma.InputJsonValue | undefined) ?? undefined,
              style: (s.style as Prisma.InputJsonValue | undefined) ?? undefined,
              text: typeof s.text === "string" ? s.text : null,
              zIndex: Number((s.zIndex as number) ?? 0),
              styleRefs: (s.styleRefs as Prisma.InputJsonValue | undefined) ?? undefined,
              parentFrameId: instance.parentFrameId ?? null,
              canvasGroupId: instance.groupId ?? null,
              createdById: ctx.userId ?? null,
            },
            select: { id: true },
          });
          shapeIds.push(row.id);
        }
        for (const raw of cloned.frames ?? []) {
          const f = raw as Record<string, unknown>;
          const row = await tx.canvasFrame.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: instance.canvasId,
              name: typeof f.name === "string" ? f.name : "Frame",
              x: dx + Number((f.x as number) ?? 0),
              y: dy + Number((f.y as number) ?? 0),
              width: Number((f.width as number) ?? 200),
              height: Number((f.height as number) ?? 200),
              isPage: Boolean(f.isPage),
              autoLayout: (f.autoLayout as Prisma.InputJsonValue | undefined) ?? undefined,
              constraints: (f.constraints as Prisma.InputJsonValue | undefined) ?? undefined,
              backgroundFill: (f.backgroundFill as Prisma.InputJsonValue | undefined) ?? undefined,
              z: Number((f.z as number) ?? 0),
              parentFrameId: instance.parentFrameId ?? null,
              createdById: ctx.userId ?? null,
            },
            select: { id: true },
          });
          frameIds.push(row.id);
        }
        await tx.canvasComponentInstance.delete({ where: { id: instance.id } });
        await tx.workspaceCanvas.update({
          where: { id: instance.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: instance.canvasId,
          action: "instance_detached",
          before: { instanceId: instance.id },
          after: {
            nodeCount: nodeIds.length,
            shapeCount: shapeIds.length,
            frameCount: frameIds.length,
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: instance.canvasId,
        });
        return { nodeIds, shapeIds, frameIds };
      });
      return created;
    },
  },

  // -------------------------------------------------------- Layer operations

  "canvases.layerSetLocked": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      kind: z.enum(["node", "shape", "frame", "group", "instance"]),
      id: z.string().cuid(),
      locked: z.boolean(),
    }),
    async run(
      input: {
        kind: "node" | "shape" | "frame" | "group" | "instance";
        id: string;
        locked: boolean;
      },
      ctx: McpContext,
    ) {
      await mcpSetLayerFlag(ctx, "lockedAt", input.kind, input.id, input.locked);
      return { ok: true };
    },
  },

  "canvases.layerSetHidden": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      kind: z.enum(["node", "shape", "frame", "group", "instance"]),
      id: z.string().cuid(),
      hidden: z.boolean(),
    }),
    async run(
      input: {
        kind: "node" | "shape" | "frame" | "group" | "instance";
        id: string;
        hidden: boolean;
      },
      ctx: McpContext,
    ) {
      await mcpSetLayerFlag(ctx, "hiddenAt", input.kind, input.id, input.hidden);
      return { ok: true };
    },
  },

  "canvases.layerRename": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      kind: z.enum(["frame", "group", "component"]),
      id: z.string().cuid(),
      name: z.string().min(1).max(200),
    }),
    async run(
      input: { kind: "frame" | "group" | "component"; id: string; name: string },
      ctx: McpContext,
    ) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error("Name cannot be blank.");
      if (input.kind === "frame") {
        const row = await db.canvasFrame.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true, canvasId: true },
        });
        if (!row) throw new Error("Frame not found.");
        await db.canvasFrame.update({ where: { id: input.id }, data: { name: trimmed } });
        await db.workspaceCanvas.update({
          where: { id: row.canvasId },
          data: { updatedAt: new Date() },
        });
      } else if (input.kind === "group") {
        const row = await db.canvasGroup.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true, canvasId: true },
        });
        if (!row) throw new Error("Group not found.");
        await db.canvasGroup.update({ where: { id: input.id }, data: { name: trimmed } });
        await db.workspaceCanvas.update({
          where: { id: row.canvasId },
          data: { updatedAt: new Date() },
        });
      } else if (input.kind === "component") {
        const row = await db.canvasComponent.findFirst({
          where: { id: input.id, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (!row) throw new Error("Component not found.");
        try {
          await db.canvasComponent.update({ where: { id: input.id }, data: { name: trimmed } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new Error("A component with that name already exists.");
          }
          throw err;
        }
      }
      return { ok: true };
    },
  },

  "canvases.layerReorder": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      parentFrameId: z.string().cuid().nullable().optional(),
      ordered: z
        .array(
          z.object({
            kind: z.enum(["node", "shape", "frame", "group", "instance"]),
            id: z.string().cuid(),
          }),
        )
        .min(1)
        .max(1000),
    }),
    async run(
      input: {
        canvasId: string;
        parentFrameId?: string | null;
        ordered: Array<{ kind: "node" | "shape" | "frame" | "group" | "instance"; id: string }>;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      await db.$transaction(async (tx) => {
        for (let i = 0; i < input.ordered.length; i++) {
          const item = input.ordered[i]!;
          const baseWhere = {
            id: item.id,
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
          };
          if (item.kind === "node") {
            await tx.workspaceCanvasNode.updateMany({ where: baseWhere, data: { zIndex: i } });
          } else if (item.kind === "shape") {
            await tx.canvasShape.updateMany({ where: baseWhere, data: { zIndex: i } });
          } else if (item.kind === "frame") {
            await tx.canvasFrame.updateMany({ where: baseWhere, data: { z: i } });
          } else if (item.kind === "group") {
            await tx.canvasGroup.updateMany({ where: baseWhere, data: { z: i } });
          } else if (item.kind === "instance") {
            await tx.canvasComponentInstance.updateMany({ where: baseWhere, data: { z: i } });
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "layers_reordered",
          after: { count: input.ordered.length },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true, count: input.ordered.length };
    },
  },

  // ------------------------------------------------------------ Canvas frames
  //
  // Minimal MCP wrapper around CanvasFrame rows. Lets agents drop a
  // named bounded region — the primitive the Figma-style layout work
  // is built on. Group / page / align wrappers will follow as the
  // frontend learns to render those, but frames alone unlock the
  // storyboard MCP gestures below.

  "canvases.frameAdd": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      parentFrameId: z.string().cuid().optional(),
      name: z.string().max(200).optional(),
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      isPage: z.boolean().optional(),
      autoLayout: z.unknown().optional(),
      constraints: z.unknown().optional(),
      backgroundFill: z.unknown().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        parentFrameId?: string;
        name?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        isPage?: boolean;
        autoLayout?: unknown;
        constraints?: unknown;
        backgroundFill?: unknown;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      return db.$transaction(async (tx) => {
        const created = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: input.parentFrameId ?? null,
            name: input.name ?? "Frame",
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
            isPage: input.isPage ?? false,
            autoLayout: (input.autoLayout ?? undefined) as Prisma.InputJsonValue | undefined,
            constraints: (input.constraints ?? undefined) as Prisma.InputJsonValue | undefined,
            backgroundFill: (input.backgroundFill ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            createdById: ctx.userId ?? null,
          },
          select: {
            id: true,
            name: true,
            x: true,
            y: true,
            width: true,
            height: true,
            isPage: true,
          },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-frame",
          entityId: created.id,
          action: "created",
          after: { name: created.name, canvasId: input.canvasId, isPage: created.isPage },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return created;
      });
    },
  },

  "canvases.framePatch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      frameId: z.string().cuid(),
      name: z.string().max(200).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(10).max(20_000).optional(),
      height: z.number().min(10).max(20_000).optional(),
      parentFrameId: z.string().cuid().nullable().optional(),
      isPage: z.boolean().optional(),
      autoLayout: z.unknown().optional(),
      constraints: z.unknown().optional(),
      backgroundFill: z.unknown().optional(),
      z: z.number().int().optional(),
    }),
    async run(
      input: {
        frameId: string;
        name?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        parentFrameId?: string | null;
        isPage?: boolean;
        autoLayout?: unknown;
        constraints?: unknown;
        backgroundFill?: unknown;
        z?: number;
      },
      ctx: McpContext,
    ) {
      const frame = await db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, x: true, y: true },
      });
      if (!frame) throw new Error("Frame not found.");
      if (input.parentFrameId) {
        if (input.parentFrameId === input.frameId) {
          throw new Error("A frame cannot be its own parent.");
        }
        const parent = await db.canvasFrame.findFirst({
          where: {
            id: input.parentFrameId,
            canvasId: frame.canvasId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!parent) throw new Error("parentFrameId is not a frame on this canvas.");
      }
      const data: Prisma.CanvasFrameUpdateInput = {};
      if (input.name !== undefined) data.name = input.name.trim() || "Frame";
      if (input.x !== undefined) data.x = input.x;
      if (input.y !== undefined) data.y = input.y;
      if (input.width !== undefined) data.width = input.width;
      if (input.height !== undefined) data.height = input.height;
      if (input.parentFrameId !== undefined) {
        data.parentFrame =
          input.parentFrameId === null
            ? { disconnect: true }
            : { connect: { id: input.parentFrameId } };
      }
      if (input.isPage !== undefined) data.isPage = input.isPage;
      if (input.autoLayout !== undefined) {
        data.autoLayout =
          input.autoLayout === null ? Prisma.JsonNull : (input.autoLayout as Prisma.InputJsonValue);
      }
      if (input.constraints !== undefined) {
        data.constraints =
          input.constraints === null
            ? Prisma.JsonNull
            : (input.constraints as Prisma.InputJsonValue);
      }
      if (input.backgroundFill !== undefined) {
        data.backgroundFill =
          input.backgroundFill === null
            ? Prisma.JsonNull
            : (input.backgroundFill as Prisma.InputJsonValue);
      }
      if (input.z !== undefined) data.z = input.z;

      const dx = input.x !== undefined ? input.x - frame.x : 0;
      const dy = input.y !== undefined ? input.y - frame.y : 0;

      await db.$transaction(async (tx) => {
        await tx.canvasFrame.update({ where: { id: input.frameId }, data });
        if (dx !== 0 || dy !== 0) {
          await tx.workspaceCanvasNode.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasShape.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasComponentInstance.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
          await tx.canvasFrame.updateMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
            data: { x: { increment: dx }, y: { increment: dy } },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: frame.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "frame_updated",
          after: { frameId: input.frameId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.frameRemove": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      frameId: z.string().cuid(),
      cascade: z.boolean().default(false),
    }),
    async run(input: { frameId: string; cascade: boolean }, ctx: McpContext) {
      const frame = await db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true, isPage: true },
      });
      if (!frame) throw new Error("Frame not found.");
      await db.$transaction(async (tx) => {
        if (input.cascade) {
          await tx.workspaceCanvasNode.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasShape.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasComponentInstance.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasGroup.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
          await tx.canvasFrame.deleteMany({
            where: { parentFrameId: input.frameId, workspaceId: ctx.workspaceId },
          });
        }
        await tx.canvasFrame.delete({ where: { id: input.frameId } });
        if (frame.isPage) {
          const canvas = await tx.workspaceCanvas.findUnique({
            where: { id: frame.canvasId },
            select: { activePageId: true },
          });
          if (canvas?.activePageId === input.frameId) {
            const fallback = await tx.canvasFrame.findFirst({
              where: {
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              orderBy: { z: "asc" },
              select: { id: true },
            });
            await tx.workspaceCanvas.update({
              where: { id: frame.canvasId },
              data: { activePageId: fallback?.id ?? null, updatedAt: new Date() },
            });
          } else {
            await tx.workspaceCanvas.update({
              where: { id: frame.canvasId },
              data: { updatedAt: new Date() },
            });
          }
        } else {
          await tx.workspaceCanvas.update({
            where: { id: frame.canvasId },
            data: { updatedAt: new Date() },
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "frame_removed",
          before: { frameId: input.frameId, cascade: input.cascade },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true };
    },
  },

  // Groups — non-visual transform containers.
  "canvases.groupCreate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      parentFrameId: z.string().cuid().nullable().optional(),
      name: z.string().max(200).optional(),
      memberNodeIds: z.array(z.string().cuid()).optional(),
      memberShapeIds: z.array(z.string().cuid()).optional(),
      memberInstanceIds: z.array(z.string().cuid()).optional(),
    }),
    async run(
      input: {
        canvasId: string;
        parentFrameId?: string | null;
        name?: string;
        memberNodeIds?: string[];
        memberShapeIds?: string[];
        memberInstanceIds?: string[];
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const nodeIds = input.memberNodeIds ?? [];
      const shapeIds = input.memberShapeIds ?? [];
      const instanceIds = input.memberInstanceIds ?? [];
      if (nodeIds.length + shapeIds.length + instanceIds.length === 0) {
        throw new Error("groupCreate requires at least one member.");
      }
      const result = await db.$transaction(async (tx) => {
        const group = await tx.canvasGroup.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: input.parentFrameId ?? null,
            name: input.name?.trim() || "Group",
            createdById: ctx.userId ?? null,
          },
        });
        if (nodeIds.length) {
          await tx.workspaceCanvasNode.updateMany({
            where: {
              id: { in: nodeIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { groupId: group.id },
          });
        }
        if (shapeIds.length) {
          await tx.canvasShape.updateMany({
            where: {
              id: { in: shapeIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { canvasGroupId: group.id },
          });
        }
        if (instanceIds.length) {
          await tx.canvasComponentInstance.updateMany({
            where: {
              id: { in: instanceIds },
              canvasId: input.canvasId,
              workspaceId: ctx.workspaceId,
            },
            data: { groupId: group.id },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "group_created",
          after: {
            groupId: group.id,
            memberCounts: {
              nodes: nodeIds.length,
              shapes: shapeIds.length,
              instances: instanceIds.length,
            },
          },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return group;
      });
      return { id: result.id };
    },
  },

  "canvases.groupDissolve": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ groupId: z.string().cuid() }),
    async run(input: { groupId: string }, ctx: McpContext) {
      const group = await db.canvasGroup.findFirst({
        where: { id: input.groupId, workspaceId: ctx.workspaceId },
        select: { id: true, canvasId: true },
      });
      if (!group) throw new Error("Group not found.");
      await db.$transaction(async (tx) => {
        await tx.workspaceCanvasNode.updateMany({
          where: { groupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { groupId: null },
        });
        await tx.canvasShape.updateMany({
          where: { canvasGroupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { canvasGroupId: null },
        });
        await tx.canvasComponentInstance.updateMany({
          where: { groupId: input.groupId, workspaceId: ctx.workspaceId },
          data: { groupId: null },
        });
        await tx.canvasGroup.delete({ where: { id: input.groupId } });
        await tx.workspaceCanvas.update({
          where: { id: group.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: group.canvasId,
          action: "group_dissolved",
          before: { groupId: input.groupId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: group.canvasId,
        });
      });
      return { ok: true };
    },
  },

  // Pages (DESIGN canvases) — page = top-level frame with isPage.
  "canvases.pageAdd": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      name: z.string().min(1).max(200),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(10).max(20_000).optional(),
      height: z.number().min(10).max(20_000).optional(),
      position: z.number().int().optional(),
    }),
    async run(
      input: {
        canvasId: string;
        name: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        position?: number;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, activePageId: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const existingCount = await db.canvasFrame.count({
        where: {
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
      });
      const result = await db.$transaction(async (tx) => {
        const created = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            parentFrameId: null,
            name: input.name.trim() || "Page",
            x: input.x ?? 0,
            y: input.y ?? 0,
            width: input.width ?? 1920,
            height: input.height ?? 1080,
            isPage: true,
            z: input.position ?? existingCount,
            createdById: ctx.userId ?? null,
          },
        });
        const becomesActive = existingCount === 0 || !canvas.activePageId;
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: {
            updatedAt: new Date(),
            ...(becomesActive ? { activePageId: created.id } : {}),
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "page_added",
          after: { pageId: created.id, name: created.name, activated: becomesActive },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return { frameId: created.id, activated: becomesActive };
      });
      return result;
    },
  },

  "canvases.pageRemove": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      frameId: z.string().cuid(),
      reassignActivePage: z.string().cuid().optional(),
    }),
    async run(input: { frameId: string; reassignActivePage?: string }, ctx: McpContext) {
      const frame = await db.canvasFrame.findFirst({
        where: { id: input.frameId, workspaceId: ctx.workspaceId, isPage: true },
        select: { id: true, canvasId: true },
      });
      if (!frame) throw new Error("Page not found.");
      await db.$transaction(async (tx) => {
        await tx.canvasFrame.delete({ where: { id: input.frameId } });
        const canvas = await tx.workspaceCanvas.findUnique({
          where: { id: frame.canvasId },
          select: { activePageId: true },
        });
        let nextActive: string | null | undefined = undefined;
        if (canvas?.activePageId === input.frameId) {
          if (input.reassignActivePage) {
            const target = await tx.canvasFrame.findFirst({
              where: {
                id: input.reassignActivePage,
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              select: { id: true },
            });
            nextActive = target?.id ?? null;
          }
          if (nextActive === undefined) {
            const fallback = await tx.canvasFrame.findFirst({
              where: {
                canvasId: frame.canvasId,
                workspaceId: ctx.workspaceId,
                isPage: true,
              },
              orderBy: { z: "asc" },
              select: { id: true },
            });
            nextActive = fallback?.id ?? null;
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: frame.canvasId },
          data: {
            updatedAt: new Date(),
            ...(nextActive !== undefined ? { activePageId: nextActive } : {}),
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: frame.canvasId,
          action: "page_removed",
          before: { pageId: input.frameId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: frame.canvasId,
        });
      });
      return { ok: true };
    },
  },

  "canvases.pageReorder": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      pageIds: z.array(z.string().cuid()).min(1),
    }),
    async run(input: { canvasId: string; pageIds: string[] }, ctx: McpContext) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const pages = await db.canvasFrame.findMany({
        where: {
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
        select: { id: true },
      });
      const validIds = new Set(pages.map((p) => p.id));
      const reordered = input.pageIds.filter((id) => validIds.has(id));
      if (reordered.length !== input.pageIds.length) {
        throw new Error("pageIds contains ids that are not pages on this canvas.");
      }
      await db.$transaction(async (tx) => {
        for (let i = 0; i < reordered.length; i++) {
          await tx.canvasFrame.update({
            where: { id: reordered[i]! },
            data: { z: i },
          });
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "pages_reordered",
          after: { order: reordered },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true, count: reordered.length };
    },
  },

  "canvases.pageActivate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      frameId: z.string().cuid(),
    }),
    async run(input: { canvasId: string; frameId: string }, ctx: McpContext) {
      const page = await db.canvasFrame.findFirst({
        where: {
          id: input.frameId,
          canvasId: input.canvasId,
          workspaceId: ctx.workspaceId,
          isPage: true,
        },
        select: { id: true },
      });
      if (!page) throw new Error("Page not found on canvas.");
      await db.workspaceCanvas.update({
        where: { id: input.canvasId },
        data: { activePageId: input.frameId, updatedAt: new Date() },
      });
      return { ok: true };
    },
  },

  // Align / distribute / tidy-up.
  "canvases.alignSelection": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      ids: z.object({
        nodeIds: z.array(z.string().cuid()).optional(),
        shapeIds: z.array(z.string().cuid()).optional(),
        frameIds: z.array(z.string().cuid()).optional(),
        groupIds: z.array(z.string().cuid()).optional(),
        instanceIds: z.array(z.string().cuid()).optional(),
      }),
      op: z.enum([
        "alignLeft",
        "alignCenter",
        "alignRight",
        "alignTop",
        "alignMiddle",
        "alignBottom",
        "distributeH",
        "distributeV",
        "tidyUp",
      ]),
    }),
    async run(
      input: {
        canvasId: string;
        ids: {
          nodeIds?: string[];
          shapeIds?: string[];
          frameIds?: string[];
          groupIds?: string[];
          instanceIds?: string[];
        };
        op:
          | "alignLeft"
          | "alignCenter"
          | "alignRight"
          | "alignTop"
          | "alignMiddle"
          | "alignBottom"
          | "distributeH"
          | "distributeV"
          | "tidyUp";
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const {
        nodeIds = [],
        shapeIds = [],
        frameIds = [],
        groupIds = [],
        instanceIds = [],
      } = input.ids;

      const [nodes, shapes, frames, instances, groupRows] = await Promise.all([
        nodeIds.length
          ? db.workspaceCanvasNode.findMany({
              where: {
                id: { in: nodeIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        shapeIds.length
          ? db.canvasShape.findMany({
              where: {
                id: { in: shapeIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{
                id: string;
                x: number;
                y: number;
                width: number | null;
                height: number | null;
              }>,
            ),
        frameIds.length
          ? db.canvasFrame.findMany({
              where: {
                id: { in: frameIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        instanceIds.length
          ? db.canvasComponentInstance.findMany({
              where: {
                id: { in: instanceIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: { id: true, x: true, y: true, width: true, height: true },
            })
          : Promise.resolve(
              [] as Array<{ id: string; x: number; y: number; width: number; height: number }>,
            ),
        groupIds.length
          ? db.canvasGroup.findMany({
              where: {
                id: { in: groupIds },
                canvasId: input.canvasId,
                workspaceId: ctx.workspaceId,
              },
              select: {
                id: true,
                nodes: { select: { id: true, x: true, y: true, width: true, height: true } },
                shapes: { select: { id: true, x: true, y: true, width: true, height: true } },
                instances: {
                  select: { id: true, x: true, y: true, width: true, height: true },
                },
              },
            })
          : Promise.resolve(
              [] as Array<{
                id: string;
                nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
                shapes: Array<{
                  id: string;
                  x: number;
                  y: number;
                  width: number | null;
                  height: number | null;
                }>;
                instances: Array<{
                  id: string;
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                }>;
              }>,
            ),
      ]);

      const items: AlignItem[] = [];
      for (const n of nodes) {
        items.push({
          id: `node:${n.id}`,
          kind: "node",
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
        });
      }
      for (const s of shapes) {
        if (s.width == null || s.height == null) continue;
        items.push({
          id: `shape:${s.id}`,
          kind: "shape",
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
        });
      }
      for (const f of frames) {
        items.push({
          id: `frame:${f.id}`,
          kind: "frame",
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        });
      }
      for (const i of instances) {
        items.push({
          id: `instance:${i.id}`,
          kind: "instance",
          x: i.x,
          y: i.y,
          width: i.width,
          height: i.height,
        });
      }

      const groupBounds = new Map<
        string,
        { x: number; y: number; width: number; height: number }
      >();
      for (const g of groupRows) {
        const members: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const n of g.nodes) members.push({ x: n.x, y: n.y, w: n.width, h: n.height });
        for (const s of g.shapes) {
          if (s.width == null || s.height == null) continue;
          members.push({ x: s.x, y: s.y, w: s.width, h: s.height });
        }
        for (const i of g.instances) members.push({ x: i.x, y: i.y, w: i.width, h: i.height });
        if (members.length === 0) continue;
        const minX = Math.min(...members.map((m) => m.x));
        const minY = Math.min(...members.map((m) => m.y));
        const maxX = Math.max(...members.map((m) => m.x + m.w));
        const maxY = Math.max(...members.map((m) => m.y + m.h));
        const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        groupBounds.set(g.id, bounds);
        items.push({ id: `group:${g.id}`, kind: "group", ...bounds });
      }

      const positions = computeAlignment(items, input.op);
      if (positions.size === 0) {
        return { ok: true, count: 0 };
      }

      let updated = 0;
      await db.$transaction(async (tx) => {
        for (const [key, pos] of positions.entries()) {
          const [kind, rawId] = key.split(":", 2) as [string, string];
          if (kind === "node") {
            await tx.workspaceCanvasNode.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "shape") {
            await tx.canvasShape.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "frame") {
            const frame = frames.find((f) => f.id === rawId);
            if (!frame) continue;
            const dx = pos.x - frame.x;
            const dy = pos.y - frame.y;
            await tx.canvasFrame.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            if (dx !== 0 || dy !== 0) {
              await tx.workspaceCanvasNode.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasShape.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasComponentInstance.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
              await tx.canvasFrame.updateMany({
                where: { parentFrameId: rawId, workspaceId: ctx.workspaceId },
                data: { x: { increment: dx }, y: { increment: dy } },
              });
            }
            updated += 1;
          } else if (kind === "instance") {
            await tx.canvasComponentInstance.update({
              where: { id: rawId },
              data: { x: pos.x, y: pos.y },
            });
            updated += 1;
          } else if (kind === "group") {
            const b = groupBounds.get(rawId);
            if (!b) continue;
            const dx = pos.x - b.x;
            const dy = pos.y - b.y;
            if (dx === 0 && dy === 0) continue;
            await tx.workspaceCanvasNode.updateMany({
              where: { groupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            await tx.canvasShape.updateMany({
              where: { canvasGroupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            await tx.canvasComponentInstance.updateMany({
              where: { groupId: rawId, workspaceId: ctx.workspaceId },
              data: { x: { increment: dx }, y: { increment: dy } },
            });
            updated += 1;
          }
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "workspace-canvas",
          entityId: input.canvasId,
          action: "align_applied",
          after: { op: input.op, count: updated },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
      });
      return { ok: true, count: updated };
    },
  },

  // ------------------------------------------------------------ Storyboard
  //
  // Compound gestures — agents call these so "storyboard this plan" /
  // "storyboard this issue" lands as a labeled frame containing the
  // canonical card + a notes lane + sources column + next-steps lane.
  // One MCP call instead of orchestrating 5 lower-level writes.

  "canvases.storyboardPlan": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      planId: z.string().cuid(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    async run(
      input: { canvasId: string; planId: string; x?: number; y?: number },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const plan = await db.executionPlan.findFirst({
        where: { id: input.planId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, title: true },
      });
      if (!plan) throw new Error("Plan not found.");
      const ox = input.x ?? 0;
      const oy = input.y ?? 0;
      return db.$transaction(async (tx) => {
        const frame = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            name: plan.title,
            x: ox,
            y: oy,
            width: 1040,
            height: 520,
            createdById: ctx.userId ?? null,
          },
          select: { id: true },
        });
        const planNode = await tx.workspaceCanvasNode.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            targetType: "execution-plan",
            targetId: plan.id,
            x: ox + 24,
            y: oy + 56,
            width: 320,
            height: 200,
            parentFrameId: frame.id,
          },
          select: { id: true },
        });
        const notesNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 360,
            y: oy + 56,
            width: 320,
            height: 200,
            text: "Notes\n\n• ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const sourcesNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 696,
            y: oy + 56,
            width: 320,
            height: 200,
            text: "Sources & links\n\n• ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const nextStepsNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 24,
            y: oy + 280,
            width: 992,
            height: 200,
            text: "Next steps\n\n1. ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-frame",
          entityId: frame.id,
          action: "storyboard_plan",
          after: { planId: plan.id, canvasId: input.canvasId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return {
          frameId: frame.id,
          planNodeId: planNode.id,
          notesShapeId: notesNode.id,
          sourcesShapeId: sourcesNode.id,
          nextStepsShapeId: nextStepsNode.id,
        };
      });
    },
  },

  "canvases.storyboardIssue": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      issueId: z.string().cuid(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    async run(
      input: { canvasId: string; issueId: string; x?: number; y?: number },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const issue = await db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true, title: true, number: true, workspace: { select: { key: true } } },
      });
      if (!issue) throw new Error("Issue not found.");
      const ox = input.x ?? 0;
      const oy = input.y ?? 0;
      return db.$transaction(async (tx) => {
        const label = `${issue.workspace.key}-${issue.number} — ${issue.title}`;
        const frame = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            name: label.slice(0, 180),
            x: ox,
            y: oy,
            width: 1040,
            height: 520,
            createdById: ctx.userId ?? null,
          },
          select: { id: true },
        });
        const issueNode = await tx.workspaceCanvasNode.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            targetType: "issue",
            targetId: issue.id,
            x: ox + 24,
            y: oy + 56,
            width: 320,
            height: 200,
            parentFrameId: frame.id,
          },
          select: { id: true },
        });
        const relatedNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 360,
            y: oy + 56,
            width: 320,
            height: 200,
            text: "Related\n\n• ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const commentsNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 696,
            y: oy + 56,
            width: 320,
            height: 200,
            text: "Comments\n\n",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const attachmentsNode = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 24,
            y: oy + 280,
            width: 992,
            height: 200,
            text: "Attachments\n\n",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-frame",
          entityId: frame.id,
          action: "storyboard_issue",
          after: { issueId: issue.id, canvasId: input.canvasId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return {
          frameId: frame.id,
          issueNodeId: issueNode.id,
          relatedShapeId: relatedNode.id,
          commentsShapeId: commentsNode.id,
          attachmentsShapeId: attachmentsNode.id,
        };
      });
    },
  },

  "canvases.storyboardResearch": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      topic: z.string().min(1).max(200),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    async run(input: { canvasId: string; topic: string; x?: number; y?: number }, ctx: McpContext) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const ox = input.x ?? 0;
      const oy = input.y ?? 0;
      return db.$transaction(async (tx) => {
        const frame = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            name: `Research — ${input.topic}`,
            x: ox,
            y: oy,
            width: 1040,
            height: 520,
            createdById: ctx.userId ?? null,
          },
          select: { id: true },
        });
        const scratch = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 24,
            y: oy + 56,
            width: 480,
            height: 200,
            text: `Scratchpad — ${input.topic}\n\n• What do we know?\n• What's missing?\n• Open questions\n`,
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const sources = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 536,
            y: oy + 56,
            width: 480,
            height: 200,
            text: "Sources & links\n\n• ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const nextSteps = await tx.canvasShape.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            kind: "text",
            x: ox + 24,
            y: oy + 280,
            width: 992,
            height: 200,
            text: "Next steps\n\n1. ",
            parentFrameId: frame.id,
            style: { fontSize: 13 } as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-frame",
          entityId: frame.id,
          action: "storyboard_research",
          after: { topic: input.topic, canvasId: input.canvasId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return {
          frameId: frame.id,
          scratchShapeId: scratch.id,
          sourcesShapeId: sources.id,
          nextStepsShapeId: nextSteps.id,
        };
      });
    },
  },

  "canvases.storyboardCustom": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      canvasId: z.string().cuid(),
      name: z.string().min(1).max(200),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().default(1040),
      height: z.number().positive().default(520),
      panels: z
        .array(
          z.object({
            label: z.string().min(1).max(120),
            body: z.string().max(50_000).optional(),
            x: z.number(),
            y: z.number(),
            width: z.number().positive(),
            height: z.number().positive(),
          }),
        )
        .max(12),
    }),
    async run(
      input: {
        canvasId: string;
        name: string;
        x?: number;
        y?: number;
        width: number;
        height: number;
        panels: Array<{
          label: string;
          body?: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
      },
      ctx: McpContext,
    ) {
      const canvas = await db.workspaceCanvas.findFirst({
        where: { id: input.canvasId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!canvas) throw new Error("Canvas not found.");
      const ox = input.x ?? 0;
      const oy = input.y ?? 0;
      return db.$transaction(async (tx) => {
        const frame = await tx.canvasFrame.create({
          data: {
            workspaceId: ctx.workspaceId,
            canvasId: input.canvasId,
            name: input.name,
            x: ox,
            y: oy,
            width: input.width,
            height: input.height,
            createdById: ctx.userId ?? null,
          },
          select: { id: true },
        });
        const panelIds: string[] = [];
        for (const p of input.panels) {
          const shape = await tx.canvasShape.create({
            data: {
              workspaceId: ctx.workspaceId,
              canvasId: input.canvasId,
              kind: "text",
              x: ox + p.x,
              y: oy + p.y,
              width: p.width,
              height: p.height,
              text: p.body ? `${p.label}\n\n${p.body}` : `${p.label}\n\n`,
              parentFrameId: frame.id,
              style: { fontSize: 13 } as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          panelIds.push(shape.id);
        }
        await tx.workspaceCanvas.update({
          where: { id: input.canvasId },
          data: { updatedAt: new Date() },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "canvas-frame",
          entityId: frame.id,
          action: "storyboard_custom",
          after: { name: input.name, panels: input.panels.length, canvasId: input.canvasId },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "workspace-canvas",
          subjectId: input.canvasId,
        });
        return { frameId: frame.id, panelShapeIds: panelIds };
      });
    },
  },

  // ------------------------------------------------------------ ActionRequests
  //
  // Precise, resolvable asks. Agents create ActionRequests to surface
  // blockers ("I need a decision before continuing"); humans create
  // them to assign work to other humans or agents. Resolved /
  // dismissed / snoozed lifecycle keeps the inbox clean.

  "actionRequests.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "SNOOZED"]).optional(),
      assignedAgentId: agentIdSchema.optional(),
      assignedUserId: z.string().cuid().optional(),
      issueId: z.string().cuid().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(
      input: {
        status?: "OPEN" | "RESOLVED" | "DISMISSED" | "SNOOZED";
        assignedAgentId?: string;
        assignedUserId?: string;
        issueId?: string;
        limit: number;
      },
      ctx: McpContext,
    ) {
      return db.actionRequest.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          assignedAgentId: input.assignedAgentId,
          assignedUserId: input.assignedUserId,
          issueId: input.issueId,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    },
  },

  "actionRequests.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(300),
      body: z.string().max(10_000).nullable().optional(),
      severity: z.enum(["INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"]).default("INFO"),
      /**
       * Action kind — discriminates what Forge should do when an
       * authorized operator clicks Accept. FREE_FORM (default) is
       * pure prose with no executable hook. Others dispatch the
       * matching operation against `issueId` using `payload`.
       */
      kind: z
        .enum([
          "FREE_FORM",
          "TRANSITION",
          "SET_LABELS",
          "ASSIGN",
          "ASSIGN_AGENT",
          "ARCHIVE",
          "CLOSE_AS_DUPLICATE",
          "RUNTIME_TOOL_GRANT",
        ])
        .default("FREE_FORM"),
      /**
       * Kind-specific args. Shape:
       *   TRANSITION         → { statusId }
       *   SET_LABELS         → { add?: string[]; remove?: string[] }
       *   ASSIGN             → { userIds: string[] }
       *   ASSIGN_AGENT       → { agentId }
       *   ARCHIVE            → {} (targets `issueId`)
       *   CLOSE_AS_DUPLICATE → { duplicateOfIssueId; statusId? }
       *   RUNTIME_TOOL_GRANT → { agentId; mode; tools; accessLevel; scopePath; reason? }
       */
      payload: z.unknown().optional(),
      /**
       * Optional poll options — when provided, the request renders
       * as a multi-vote poll. Each option carries `key` (stable id),
       * `label`, and an optional `description`. Cap of 8 options.
       * Operators vote via `actionRequests.vote`; the requester
       * closes voting via `actionRequests.closeVoting`.
       */
      options: z
        .array(
          z.object({
            key: z.string().trim().min(1).max(80),
            label: z.string().trim().min(1).max(200),
            description: z.string().trim().max(2_000).optional(),
          }),
        )
        .min(2)
        .max(8)
        .optional(),
      assignedUserId: z.string().cuid().nullable().optional(),
      assignedAgentId: agentIdSchema.nullable().optional(),
      sourceType: z.string().max(40).nullable().optional(),
      sourceId: z.string().max(40).nullable().optional(),
      issueId: z.string().cuid().nullable().optional(),
      dueAt: z.coerce.date().nullable().optional(),
    }),
    async run(
      input: {
        title: string;
        body?: string | null;
        severity: "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";
        kind:
          | "FREE_FORM"
          | "TRANSITION"
          | "SET_LABELS"
          | "ASSIGN"
          | "ASSIGN_AGENT"
          | "ARCHIVE"
          | "CLOSE_AS_DUPLICATE"
          | "RUNTIME_TOOL_GRANT";
        payload?: unknown;
        options?: Array<{ key: string; label: string; description?: string }>;
        assignedUserId?: string | null;
        assignedAgentId?: string | null;
        sourceType?: string | null;
        sourceId?: string | null;
        issueId?: string | null;
        dueAt?: Date | null;
      },
      ctx: McpContext,
    ) {
      const { createActionRequest } = await import("@/server/services/action-request-service");
      return createActionRequest(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity as never,
        kind: input.kind as never,
        payload: input.payload,
        options: input.options ?? null,
        assignedUserId: input.assignedUserId ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        issueId: input.issueId ?? null,
        dueAt: input.dueAt ?? null,
      });
    },
  },

  "actionRequests.transition": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      status: z.enum(["OPEN", "RESOLVED", "DISMISSED", "SNOOZED", "REJECTED"]),
      resolution: z.string().max(10_000).nullable().optional(),
    }),
    async run(
      input: {
        id: string;
        status: "OPEN" | "RESOLVED" | "DISMISSED" | "SNOOZED" | "REJECTED";
        resolution?: string | null;
      },
      ctx: McpContext,
    ) {
      const { transitionActionRequest } = await import("@/server/services/action-request-service");
      await transitionActionRequest(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        requestId: input.id,
        status: input.status as never,
        resolution: input.resolution ?? null,
      });
      return { ok: true };
    },
  },

  /**
   * Accept an action request — runs the bound dispatch (transition /
   * setLabels / etc.) and flips status=RESOLVED in one transaction.
   * Permission-gated to assignee / watcher / OWNER / ADMIN. Agents
   * shouldn't call this directly except in narrow self-service flows
   * (and even then, the caller must be linked to a human account
   * with the requisite role).
   */
  "actionRequests.accept": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      resolution: z.string().max(2_000).nullable().optional(),
    }),
    async run(input: { id: string; resolution?: string | null }, ctx: McpContext) {
      if (!ctx.userId) {
        throw new Error(
          "actionRequests.accept requires a human user context (no anonymous accept).",
        );
      }
      const request = await db.actionRequest.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: { issueId: true },
      });
      if (request?.issueId) {
        await assertAgentIssueMutationAllowed(ctx, request.issueId, "actionRequests.accept");
      }
      const { acceptActionRequest } = await import("@/server/services/action-request-service");
      return acceptActionRequest(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        requestId: input.id,
        resolution: input.resolution ?? null,
      });
    },
  },

  /**
   * Decline an action request — flips status=REJECTED, records the
   * optional reason, and does NOT dispatch the bound action.
   */
  "actionRequests.decline": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      reason: z.string().max(2_000).nullable().optional(),
    }),
    async run(input: { id: string; reason?: string | null }, ctx: McpContext) {
      if (!ctx.userId) {
        throw new Error("actionRequests.decline requires a human user context.");
      }
      const { declineActionRequest } = await import("@/server/services/action-request-service");
      return declineActionRequest(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        requestId: input.id,
        reason: input.reason ?? null,
      });
    },
  },

  /**
   * Cast or update a vote on a poll-style ActionRequest. The calling
   * user (resolved via the API key's linked user) gets one vote per
   * request — re-calling with a different `optionKey` overwrites the
   * previous pick until the requester closes voting. Useful for agent
   * crews where Reviewer agents weigh in alongside humans.
   */
  "actionRequests.vote": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      optionKey: z.string().trim().min(1).max(80),
    }),
    async run(input: { id: string; optionKey: string }, ctx: McpContext) {
      if (!ctx.userId) {
        throw new Error(
          "actionRequests.vote requires a user context (anonymous votes not supported).",
        );
      }
      const { voteOnActionRequest } = await import("@/server/services/action-request-service");
      return voteOnActionRequest(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        requestId: input.id,
        optionKey: input.optionKey,
      });
    },
  },

  /**
   * Return live vote tallies for a poll-style ActionRequest. Read-only;
   * safe to call any time. Includes the caller's current pick and
   * `winningOptionKey` once voting has been closed.
   */
  "actionRequests.results": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      if (!ctx.userId) {
        throw new Error("actionRequests.results requires a user context.");
      }
      const { getActionRequestResults } = await import("@/server/services/action-request-service");
      return getActionRequestResults(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        requestId: input.id,
      });
    },
  },

  /**
   * Close voting on a poll. Only the original requester (human user
   * or the agent linked to the calling key) may call this. Returns
   * the winning `optionKey` so the agent can use it to write its
   * follow-up comment ("going with option X").
   */
  "actionRequests.closeVoting": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      if (!ctx.userId) {
        throw new Error("actionRequests.closeVoting requires a user context.");
      }
      const { closeActionRequestVoting } = await import("@/server/services/action-request-service");
      return closeActionRequestVoting(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        requestId: input.id,
      });
    },
  },

  // --------------------------------------------------------- Notifications
  //
  // Per-user, per-EventKind opt-out. No row = enabled (default), so
  // agents acting on behalf of a user can disable an alert kind they
  // don't want to hear about without affecting other workspace
  // members' inboxes.

  /**
   * Upsert a notification preference for the calling user.
   * `scope: "workspace"` (default) applies to the current workspace
   * only; `scope: "global"` sets the user's cross-workspace default.
   * When both rows exist for the same kind, the workspace-scoped row
   * wins in the materializer.
   */
  "notification.setPreference": {
    scopes: ["READ_USERS"] as const,
    input: z.object({
      eventKind: z.string().min(1).max(80),
      enabled: z.boolean(),
      delivery: z.enum(["INBOX_ONLY", "INBOX_AND_DIGEST"]).optional(),
      scope: z.enum(["workspace", "global"]).default("workspace"),
    }),
    async run(
      input: {
        eventKind: string;
        enabled: boolean;
        delivery?: "INBOX_ONLY" | "INBOX_AND_DIGEST";
        scope: "workspace" | "global";
      },
      ctx: McpContext,
    ) {
      if (!ctx.userId) {
        throw new Error("notification.setPreference requires a user context.");
      }
      const workspaceId = input.scope === "global" ? null : ctx.workspaceId;
      const existing = await db.notificationPreference.findFirst({
        where: {
          userId: ctx.userId,
          workspaceId,
          eventKind: input.eventKind,
        },
        select: { id: true },
      });
      if (existing) {
        return db.notificationPreference.update({
          where: { id: existing.id },
          data: {
            enabled: input.enabled,
            delivery: input.delivery ?? "INBOX_ONLY",
          },
        });
      }
      return db.notificationPreference.create({
        data: {
          userId: ctx.userId,
          workspaceId,
          eventKind: input.eventKind,
          enabled: input.enabled,
          delivery: input.delivery ?? "INBOX_ONLY",
        },
      });
    },
  },

  // --------------------------------------------------------- AgentCrews / Gates
  //
  // Crews bind agents to a plan with roles (planner/worker/reviewer);
  // gates are explicit approval checkpoints attached to any reviewable
  // surface. Agents read pending gates targeting them via
  // `reviewGates.listForMe`; humans + agents resolve via `.resolve`.

  "agentCrews.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(input: { includeArchived: boolean; limit: number }, ctx: McpContext) {
      return db.agentCrew.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: input.includeArchived ? undefined : null,
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
        include: {
          _count: { select: { members: true, executionPlans: true } },
        },
      });
    },
  },

  "reviewGates.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELED"]).optional(),
      targetType: z.string().min(1).max(40).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(
      input: {
        status?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
        targetType?: string;
        limit: number;
      },
      ctx: McpContext,
    ) {
      return db.reviewGate.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          targetType: input.targetType,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
    },
  },

  "reviewGates.open": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      targetType: z.string().min(1).max(40),
      targetId: z.string().min(1).max(40),
      prompt: z.string().min(1).max(10_000),
      requiredRole: z.string().max(40).nullable().optional(),
      crewId: z.string().cuid().nullable().optional(),
    }),
    async run(
      input: {
        targetType: string;
        targetId: string;
        prompt: string;
        requiredRole?: string | null;
        crewId?: string | null;
      },
      ctx: McpContext,
    ) {
      const { openReviewGate } = await import("@/server/services/agent-crew-service");
      return openReviewGate(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        prompt: input.prompt,
        requiredRole: input.requiredRole ?? null,
        crewId: input.crewId ?? null,
      });
    },
  },

  "reviewGates.resolve": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      decision: z.enum(["APPROVED", "REJECTED", "CANCELED"]),
      resolution: z.string().max(10_000).nullable().optional(),
    }),
    async run(
      input: {
        id: string;
        decision: "APPROVED" | "REJECTED" | "CANCELED";
        resolution?: string | null;
      },
      ctx: McpContext,
    ) {
      const { resolveReviewGate } = await import("@/server/services/agent-crew-service");
      await resolveReviewGate(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        gateId: input.id,
        decision: input.decision,
        resolution: input.resolution ?? null,
      });
      return { ok: true };
    },
  },

  // ---------------------------------------------------------------------- Notes
  //
  // Per-(workspace, user) markdown scratchpad. The dashboard's
  // <QuickNotesWidget /> is the human surface; agents use these tools to
  // leave themselves notes (reasoning trails, follow-up reminders,
  // cross-issue context). Each note is owned by exactly one actor —
  // these tools never read or write another user's notes. When the
  // calling API key is agent-linked, "owner" is the agent's linked
  // userId. When it's a personal/session key, "owner" is the human.
  //
  // For shared, conversational notes use `comments.create`. For
  // project-level docs use issue descriptions. These tools are
  // intentionally narrow.

  /**
   * Create a personal note for the calling actor. Markdown body. Notes
   * are private to the actor — agents leave notes for themselves, not
   * for the operator. To leave a note for someone else, use
   * `comments.create` on the relevant issue (their inbox will pick it up
   * via @-mention).
   */
  "notes.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z
        .string()
        .max(200)
        .optional()
        .describe("Optional title (≤200 chars). Body's first line is used as a fallback."),
      body: z.string().min(1).max(50_000).describe("Markdown body. Required."),
      pinned: z.boolean().default(false).describe("Pin to the top of the caller's notes list."),
      status: z
        .nativeEnum(NoteStatus)
        .default(NoteStatus.IDEA)
        .describe(
          "Lifecycle status. Defaults to IDEA (fresh capture). Set to ACTIVE when the note is recording an in-flight thread rather than a pitch.",
        ),
    }),
    async run(
      input: { title?: string; body: string; pinned: boolean; status: NoteStatus },
      ctx: McpContext,
    ) {
      const userId = await resolveActorId(ctx);
      return db.note.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId,
          title: input.title?.trim() || null,
          body: input.body,
          pinned: input.pinned,
          status: input.status,
        },
      });
    },
  },

  /**
   * Transition a note between lifecycle states. Orthogonal to `archivedAt`
   * — the archive UI uses the timestamp, status drives the dashboard chip
   * row + ideas-zone routing. Emits an audit event.
   */
  "notes.setStatus": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      noteId: z.string().describe("Note id (cuid)."),
      status: z
        .nativeEnum(NoteStatus)
        .describe("Target lifecycle status: IDEA | SOMEDAY | ACTIVE | ARCHIVED."),
    }),
    async run(input: { noteId: string; status: NoteStatus }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      return db.$transaction(async (tx) => {
        const before = await tx.note.findFirst({
          where: { id: input.noteId, workspaceId: ctx.workspaceId, userId },
        });
        if (!before) throw new Error("Note not found.");
        if (before.status === input.status) return before;
        const after = await tx.note.update({
          where: { id: before.id },
          data: { status: input.status },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: userId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Note",
          entityId: before.id,
          action: "status.set",
          before: { status: before.status },
          after: { status: after.status },
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "note",
          subjectId: before.id,
          payload: { status: after.status },
        });
        return after;
      });
    },
  },

  /**
   * Promote a note into an Issue / Project / Initiative. The downstream
   * row carries `sourceNoteId` back to the note; the note records
   * `promotedToType` + `promotedToId` and transitions to ACTIVE. Title
   * defaults to `note.title` || first non-empty line of body. The source
   * note is left in place — the caller can archive it separately.
   *
   * Errors out if the note has already been promoted (`promotedToId` set)
   * — the agent should call `notes.create` for a fresh capture instead.
   */
  "notes.promote": {
    scopes: ["WRITE_ISSUES", "WRITE_PROJECTS"] as const,
    input: z.object({
      noteId: z.string().describe("Note id (cuid)."),
      kind: z.enum(["issue", "project", "initiative"]).describe("Downstream entity to create."),
      title: z.string().min(1).max(300).optional().describe("Override the auto-derived title."),
      projectId: z
        .string()
        .cuid()
        .optional()
        .describe("Issue-only — file the new issue under this project."),
      initiativeId: z
        .string()
        .cuid()
        .optional()
        .describe("Project-only — link the new project to this initiative."),
    }),
    async run(
      input: {
        noteId: string;
        kind: "issue" | "project" | "initiative";
        title?: string;
        projectId?: string;
        initiativeId?: string;
      },
      ctx: McpContext,
    ) {
      const userId = await resolveActorId(ctx);
      const note = await db.note.findFirst({
        where: { id: input.noteId, workspaceId: ctx.workspaceId, userId },
      });
      if (!note) throw new Error("Note not found.");
      if (note.promotedToId) {
        throw new Error(
          `Note already promoted to ${note.promotedToType ?? "an entity"} (${note.promotedToId}).`,
        );
      }

      const fallbackTitle =
        note.body
          .split("\n")
          .find((l) => l.trim())
          ?.trim() || "Untitled note";
      const title = (input.title?.trim() || note.title?.trim() || fallbackTitle).slice(0, 300);
      const description = note.body;

      const ws = await db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { key: true },
      });

      if (input.kind === "issue") {
        return db.$transaction(async (tx) => {
          const status = await tx.status.findFirstOrThrow({
            where: { workspaceId: ctx.workspaceId, isDefault: true },
          });
          const last = await tx.issue.findFirst({
            where: { workspaceId: ctx.workspaceId },
            orderBy: { number: "desc" },
            select: { number: true },
          });
          const number = (last?.number ?? 0) + 1;
          const assigneeIds = await resolveDefaultIssueAssigneeIds(tx, {
            workspaceId: ctx.workspaceId,
            authorId: userId,
          });
          const issue = await tx.issue.create({
            data: {
              workspaceId: ctx.workspaceId,
              number,
              title,
              description,
              projectId: input.projectId,
              statusId: status.id,
              priority: Priority.NONE,
              authorId: userId,
              sourceNoteId: note.id,
              assignees: {
                create: assigneeIds.map((assigneeUserId) => ({
                  userId: assigneeUserId,
                })),
              },
            },
            include: { status: true },
          });
          for (const assigneeUserId of assigneeIds) {
            await autoWatchUser(tx, {
              workspaceId: ctx.workspaceId,
              issueId: issue.id,
              userId: assigneeUserId,
            });
          }
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: userId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "create",
            after: issue,
            eventKind: EventKind.ISSUE_CREATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              number: issue.number,
              title: issue.title,
              from: "note",
              noteId: note.id,
            },
          });
          const updatedNote = await tx.note.update({
            where: { id: note.id },
            data: {
              status: NoteStatus.ACTIVE,
              promotedToType: "issue",
              promotedToId: issue.id,
            },
          });
          return {
            note: updatedNote,
            target: {
              kind: "issue" as const,
              id: issue.id,
              number: issue.number,
              key: `${ws.key}-${issue.number}`,
              title: issue.title,
            },
          };
        });
      }

      if (input.kind === "project") {
        const baseKey = mcpGenerateProjectKey(title);
        return db.$transaction(async (tx) => {
          const uniqueKey = await mcpEnsureUniqueProjectKey(tx, ctx.workspaceId, baseKey);
          const project = await tx.project.create({
            data: {
              workspaceId: ctx.workspaceId,
              key: uniqueKey,
              name: title,
              description,
              initiativeId: input.initiativeId,
              createdById: userId,
              sourceNoteId: note.id,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: userId,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Project",
            entityId: project.id,
            action: "create",
            after: project,
            eventKind: EventKind.PROJECT_CREATED,
            subjectType: "project",
            subjectId: project.id,
            payload: {
              name: project.name,
              key: project.key,
              from: "note",
              noteId: note.id,
            },
          });
          const updatedNote = await tx.note.update({
            where: { id: note.id },
            data: {
              status: NoteStatus.ACTIVE,
              promotedToType: "project",
              promotedToId: project.id,
            },
          });
          return {
            note: updatedNote,
            target: {
              kind: "project" as const,
              id: project.id,
              key: project.key,
              title: project.name,
            },
          };
        });
      }

      const slug = mcpSlugifyInitiative(title);
      return db.$transaction(async (tx) => {
        const uniqueSlug = await mcpEnsureUniqueInitiativeSlug(tx, ctx.workspaceId, slug);
        const last = await tx.initiative.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const initiative = await tx.initiative.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: title,
            slug: uniqueSlug,
            description,
            status: InitiativeStatus.PLANNED,
            position: (last?.position ?? -1) + 1,
            createdById: userId,
            sourceNoteId: note.id,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: userId,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Initiative",
          entityId: initiative.id,
          action: "create",
          after: initiative,
          eventKind: EventKind.PROJECT_CREATED,
          subjectType: "initiative",
          subjectId: initiative.id,
          payload: {
            name: initiative.name,
            slug: initiative.slug,
            from: "note",
            noteId: note.id,
          },
        });
        const updatedNote = await tx.note.update({
          where: { id: note.id },
          data: {
            status: NoteStatus.ACTIVE,
            promotedToType: "initiative",
            promotedToId: initiative.id,
          },
        });
        return {
          note: updatedNote,
          target: {
            kind: "initiative" as const,
            id: initiative.id,
            slug: initiative.slug,
            title: initiative.name,
          },
        };
      });
    },
  },

  /**
   * List the caller's own notes in this workspace. Unarchived rows by
   * default; pass `archived: true` to list the archive. Ordered by
   * `(pinned desc, updatedAt desc)`.
   */
  "notes.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      archived: z
        .boolean()
        .default(false)
        .describe("When true, list archived notes instead of active ones."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max rows to return (default 20, max 100)."),
    }),
    async run(input: { archived: boolean; limit: number }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      return db.note.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          archivedAt: input.archived ? { not: null } : null,
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        take: input.limit,
      });
    },
  },

  /**
   * Patch fields on one of the caller's own notes. Pass any subset of
   * `title` / `body` / `pinned`. Cross-actor mutation is blocked — the
   * note must belong to the same actor that owns this API key.
   */
  "notes.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Note id (cuid)."),
      title: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Pass null to clear, omit to leave unchanged."),
      body: z.string().min(1).max(50_000).optional(),
      pinned: z.boolean().optional(),
    }),
    async run(
      input: {
        id: string;
        title?: string | null;
        body?: string;
        pinned?: boolean;
      },
      ctx: McpContext,
    ) {
      const userId = await resolveActorId(ctx);
      const existing = await db.note.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, userId },
      });
      if (!existing) throw new Error("Note not found.");
      return db.note.update({
        where: { id: existing.id },
        data: {
          ...(input.title !== undefined
            ? { title: input.title === null ? null : input.title.trim() || null }
            : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        },
      });
    },
  },

  /**
   * Soft-archive one of the caller's own notes — bumps it out of the
   * default list. Reverse via the human UI's "unarchive" action; there
   * is no `notes.unarchive` MCP tool by design (agents shouldn't be
   * resurrecting archived notes silently).
   */
  "notes.archive": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().describe("Note id (cuid)."),
    }),
    async run(input: { id: string }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const existing = await db.note.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, userId },
      });
      if (!existing) throw new Error("Note not found.");
      return db.note.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      });
    },
  },

  /**
   * Get-or-create today's JOURNAL entry for the calling actor. Date is
   * "today" in the actor's timezone (User.timezone) — falls back to UTC
   * midnight when null. Idempotent across calls in the same day. Use
   * cases for an agent: daily summary, blocker log, decision record.
   * NOT for inter-agent communication — use `comments.create` for that.
   */
  "notes.todayJournal": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({}).default({}),
    async run(_input: Record<string, never>, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      const me = await db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { timezone: true },
      });
      const tz = me.timezone;
      // Mirrors note.todayJournal in the tRPC router. Stored as UTC
      // midnight on the user's wall-clock date.
      const now = new Date();
      let today: Date;
      try {
        if (tz) {
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const [y, m, d] = fmt
            .format(now)
            .split("-")
            .map((p) => parseInt(p, 10));
          today = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
        } else {
          today = new Date(now);
          today.setUTCHours(0, 0, 0, 0);
        }
      } catch {
        today = new Date(now);
        today.setUTCHours(0, 0, 0, 0);
      }
      const existing = await db.note.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          kind: "JOURNAL",
          journalDate: today,
        },
      });
      if (existing) return existing;
      return db.note.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId,
          kind: "JOURNAL",
          journalDate: today,
          title: null,
          body: "",
        },
      });
    },
  },

  /**
   * List recent JOURNAL entries for the caller, ordered by
   * `journalDate desc`. Default 30 (≈one month).
   */
  "notes.listJournal": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.number().int().min(1).max(180).default(30),
    }),
    async run(input: { from?: Date; to?: Date; limit: number }, ctx: McpContext) {
      const userId = await resolveActorId(ctx);
      return db.note.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId,
          kind: "JOURNAL",
          ...(input.from || input.to
            ? {
                journalDate: {
                  ...(input.from ? { gte: input.from } : {}),
                  ...(input.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { journalDate: "desc" },
        take: input.limit,
      });
    },
  },

  // ----------------------------------------------------------- Orchestration
  //
  // Goal → decompose → approve → dispatch → judge → retry loop. See
  // docs/concepts/orchestration.md for the full sequence. Goals own
  // ExecutionPlan attempts; the PLANNER fills a DRAFT plan via
  // plans.addSteps; an operator approves via the ActionRequest the
  // planner raises; activation dispatches root steps; workers post output
  // (step → REVIEW); a REVIEWER judges via plans.recordVerdict.

  "goals.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({
      status: z.enum(["OPEN", "PLANNING", "ACTIVE", "ACHIEVED", "ABANDONED"]).optional(),
      includeArchived: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async run(
      input: {
        status?: "OPEN" | "PLANNING" | "ACTIVE" | "ACHIEVED" | "ABANDONED";
        includeArchived: boolean;
        limit: number;
      },
      ctx: McpContext,
    ) {
      const { listGoals } = await import("@/server/services/orchestration-service");
      return listGoals(db, {
        workspaceId: ctx.workspaceId,
        status: input.status as never,
        includeArchived: input.includeArchived,
        limit: input.limit,
      });
    },
  },

  "goals.get": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const { getGoal } = await import("@/server/services/orchestration-service");
      return getGoal(db, { workspaceId: ctx.workspaceId, id: input.id });
    },
  },

  "goals.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(50_000).nullable().optional(),
      successCriteria: z.string().max(50_000).nullable().optional(),
      outcomeSummary: z.string().max(50_000).nullable().optional(),
      targetDate: z.coerce.date().nullable().optional(),
      issueId: z.string().cuid().nullable().optional(),
      initiativeId: z.string().cuid().nullable().optional(),
      crewId: z.string().cuid().nullable().optional(),
      maxTotalCostUsd: z.number().nonnegative().nullable().optional(),
      maxWallTimeMinutes: z.number().int().positive().nullable().optional(),
    }),
    async run(
      input: {
        title: string;
        description?: string | null;
        successCriteria?: string | null;
        outcomeSummary?: string | null;
        targetDate?: Date | null;
        issueId?: string | null;
        initiativeId?: string | null;
        crewId?: string | null;
        maxTotalCostUsd?: number | null;
        maxWallTimeMinutes?: number | null;
      },
      ctx: McpContext,
    ) {
      const { createGoal } = await import("@/server/services/orchestration-service");
      return createGoal(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        description: input.description ?? null,
        successCriteria: input.successCriteria ?? null,
        outcomeSummary: input.outcomeSummary ?? null,
        targetDate: input.targetDate ?? null,
        issueId: input.issueId ?? null,
        initiativeId: input.initiativeId ?? null,
        crewId: input.crewId ?? null,
        maxTotalCostUsd: input.maxTotalCostUsd ?? null,
        maxWallTimeMinutes: input.maxWallTimeMinutes ?? null,
      });
    },
  },

  "goals.update": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      title: z.string().min(1).max(300).optional(),
      description: z.string().max(50_000).nullable().optional(),
      successCriteria: z.string().max(50_000).nullable().optional(),
      outcomeSummary: z.string().max(50_000).nullable().optional(),
      targetDate: z.coerce.date().nullable().optional(),
      crewId: z.string().cuid().nullable().optional(),
      maxTotalCostUsd: z.number().nonnegative().nullable().optional(),
      maxWallTimeMinutes: z.number().int().positive().nullable().optional(),
    }),
    async run(
      input: {
        id: string;
        title?: string;
        description?: string | null;
        successCriteria?: string | null;
        outcomeSummary?: string | null;
        targetDate?: Date | null;
        crewId?: string | null;
        maxTotalCostUsd?: number | null;
        maxWallTimeMinutes?: number | null;
      },
      ctx: McpContext,
    ) {
      const { updateGoal } = await import("@/server/services/orchestration-service");
      return updateGoal(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        ...input,
      });
    },
  },

  "goals.abandon": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      id: z.string().cuid(),
      reason: z.string().max(2_000).nullable().optional(),
    }),
    async run(input: { id: string; reason?: string | null }, ctx: McpContext) {
      const { abandonGoal } = await import("@/server/services/orchestration-service");
      await abandonGoal(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        id: input.id,
        reason: input.reason ?? null,
      });
      return { ok: true };
    },
  },

  "goals.attachPlan": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      goalId: z.string().cuid(),
      planId: z.string().cuid(),
      makeActive: z.boolean().optional(),
    }),
    async run(input: { goalId: string; planId: string; makeActive?: boolean }, ctx: McpContext) {
      const { attachPlanToGoal } = await import("@/server/services/orchestration-service");
      return attachPlanToGoal(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        goalId: input.goalId,
        planId: input.planId,
        makeActive: input.makeActive,
      });
    },
  },

  "plans.decompose": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      goalId: z.string().cuid(),
      plannerAgentId: agentIdSchema.nullable().optional(),
      contextSetId: z.string().cuid().nullable().optional(),
    }),
    async run(
      input: { goalId: string; plannerAgentId?: string | null; contextSetId?: string | null },
      ctx: McpContext,
    ) {
      const { decomposeGoal } = await import("@/server/services/orchestration-service");
      return decomposeGoal(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        goalId: input.goalId,
        plannerAgentId: input.plannerAgentId ?? null,
        contextSetId: input.contextSetId ?? null,
      });
    },
  },

  "plans.addSteps": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      planId: z.string().cuid(),
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(300),
            body: z.string().max(50_000).nullable().optional(),
            expectedOutput: z.string().max(50_000).nullable().optional(),
            verification: z
              .array(
                z.object({
                  id: z.string().min(1).optional(),
                  label: z.string().min(1).max(500),
                  kind: z.enum(["manual", "command", "artifact"]).optional(),
                  value: z.string().max(2_000).optional(),
                  done: z.boolean().optional(),
                }),
              )
              .max(50)
              .nullable()
              .optional(),
            dependsOnStepIndexes: z.array(z.number().int().min(0)).max(50).optional(),
            assignedAgentId: agentIdSchema.nullable().optional(),
            assignedRole: z.string().max(40).nullable().optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    async run(
      input: {
        planId: string;
        steps: Array<{
          title: string;
          body?: string | null;
          expectedOutput?: string | null;
          verification?: unknown[] | null;
          dependsOnStepIndexes?: number[];
          assignedAgentId?: string | null;
          assignedRole?: string | null;
        }>;
      },
      ctx: McpContext,
    ) {
      const { addStepsToPlan } = await import("@/server/services/orchestration-service");
      return addStepsToPlan(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        planId: input.planId,
        steps: input.steps.map((s) => ({
          title: s.title,
          body: s.body ?? null,
          expectedOutput: s.expectedOutput ?? null,
          verification:
            s.verification === undefined || s.verification === null
              ? null
              : (s.verification as Prisma.InputJsonValue),
          dependsOnStepIndexes: s.dependsOnStepIndexes ?? [],
          assignedAgentId: s.assignedAgentId ?? null,
          assignedRole: s.assignedRole ?? null,
        })),
      });
    },
  },

  "plans.requestApproval": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      planId: z.string().cuid(),
      assignedUserId: z.string().cuid().nullable().optional(),
    }),
    async run(input: { planId: string; assignedUserId?: string | null }, ctx: McpContext) {
      const { requestPlanApproval } = await import("@/server/services/orchestration-service");
      return requestPlanApproval(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        planId: input.planId,
        assignedUserId: input.assignedUserId ?? null,
      });
    },
  },

  "plans.activate": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({ planId: z.string().cuid() }),
    async run(input: { planId: string }, ctx: McpContext) {
      const { activatePlan } = await import("@/server/services/orchestration-service");
      await db.$transaction((tx) =>
        activatePlan(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.userId ?? null,
          planId: input.planId,
        }),
      );
      return { ok: true };
    },
  },

  "plans.judge": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      stepId: z.string().cuid(),
      judgeAgentId: agentIdSchema.nullable().optional(),
    }),
    async run(input: { stepId: string; judgeAgentId?: string | null }, ctx: McpContext) {
      const { dispatchJudge } = await import("@/server/services/orchestration-service");
      return dispatchJudge(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        stepId: input.stepId,
        judgeAgentId: input.judgeAgentId ?? null,
      });
    },
  },

  "plans.recordVerdict": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      stepId: z.string().cuid(),
      verdict: z.enum(["PASS", "FAIL"]),
      feedback: z.string().min(1).max(50_000),
      score: z.number().min(0).max(1).nullable().optional(),
    }),
    async run(
      input: {
        stepId: string;
        verdict: "PASS" | "FAIL";
        feedback: string;
        score?: number | null;
      },
      ctx: McpContext,
    ) {
      const { recordVerdict } = await import("@/server/services/orchestration-service");
      return recordVerdict(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        stepId: input.stepId,
        verdict: input.verdict,
        feedback: input.feedback,
        score: input.score ?? null,
      });
    },
  },

  "plans.comments.list": {
    scopes: ["READ_ISSUES"] as const,
    input: z.object({ stepId: z.string().cuid() }),
    async run(input: { stepId: string }, ctx: McpContext) {
      const { listExecutionStepComments } =
        await import("@/server/services/execution-step-comments");
      return listExecutionStepComments(db, {
        workspaceId: ctx.workspaceId,
        stepId: input.stepId,
      });
    },
  },

  "plans.comments.create": {
    scopes: ["WRITE_ISSUES"] as const,
    input: z.object({
      stepId: z.string().cuid(),
      body: z.string().min(1).max(50_000),
    }),
    async run(input: { stepId: string; body: string }, ctx: McpContext) {
      const { createExecutionStepComment } =
        await import("@/server/services/execution-step-comments");
      return createExecutionStepComment(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        stepId: input.stepId,
        body: input.body,
      });
    },
  },

  // ----------------------------------------------------- AgentCrew CRUD
  //
  // Workspace-scoped crew management. `list` already existed; these add
  // create/update/member-management/archive so a PLANNER (or operator)
  // can stand up a crew before decomposing a goal.

  "agentCrews.create": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2_000).nullable().optional(),
      maxParallel: z.number().int().min(0).max(20).optional(),
      members: z
        .array(
          z.object({
            agentId: agentIdSchema,
            role: z.enum(["PLANNER", "WORKER", "REVIEWER", "OBSERVER", "OPERATOR_PROXY"]),
          }),
        )
        .max(20)
        .optional(),
    }),
    async run(
      input: {
        name: string;
        description?: string | null;
        maxParallel?: number;
        members?: Array<{
          agentId: string;
          role: "PLANNER" | "WORKER" | "REVIEWER" | "OBSERVER" | "OPERATOR_PROXY";
        }>;
      },
      ctx: McpContext,
    ) {
      const { createAgentCrew } = await import("@/server/services/agent-crew-service");
      return createAgentCrew(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        name: input.name,
        description: input.description ?? null,
        maxParallel: input.maxParallel,
        members: input.members,
      });
    },
  },

  "agentCrews.update": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      id: z.string().cuid(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2_000).nullable().optional(),
      maxParallel: z.number().int().min(0).max(20).optional(),
    }),
    async run(
      input: {
        id: string;
        name?: string;
        description?: string | null;
        maxParallel?: number;
      },
      ctx: McpContext,
    ) {
      const { updateAgentCrew } = await import("@/server/services/agent-crew-service");
      await updateAgentCrew(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        crewId: input.id,
        name: input.name,
        description: input.description === undefined ? undefined : input.description,
        maxParallel: input.maxParallel,
      });
      return { ok: true };
    },
  },

  "agentCrews.addMember": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      crewId: z.string().cuid(),
      agentId: agentIdSchema,
      role: z.enum(["PLANNER", "WORKER", "REVIEWER", "OBSERVER", "OPERATOR_PROXY"]),
    }),
    async run(
      input: {
        crewId: string;
        agentId: string;
        role: "PLANNER" | "WORKER" | "REVIEWER" | "OBSERVER" | "OPERATOR_PROXY";
      },
      ctx: McpContext,
    ) {
      const { addCrewMember } = await import("@/server/services/agent-crew-service");
      return addCrewMember(db, {
        workspaceId: ctx.workspaceId,
        crewId: input.crewId,
        agentId: input.agentId,
        role: input.role,
        actorId: ctx.userId ?? null,
      });
    },
  },

  "agentCrews.removeMember": {
    scopes: ["ADMIN"] as const,
    input: z.object({ memberId: z.string().cuid() }),
    async run(input: { memberId: string }, ctx: McpContext) {
      const { removeCrewMember } = await import("@/server/services/agent-crew-service");
      await removeCrewMember(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        memberId: input.memberId,
      });
      return { ok: true };
    },
  },

  "agentCrews.setMemberRole": {
    scopes: ["ADMIN"] as const,
    input: z.object({
      memberId: z.string().cuid(),
      role: z.enum(["PLANNER", "WORKER", "REVIEWER", "OBSERVER", "OPERATOR_PROXY"]),
    }),
    async run(
      input: {
        memberId: string;
        role: "PLANNER" | "WORKER" | "REVIEWER" | "OBSERVER" | "OPERATOR_PROXY";
      },
      ctx: McpContext,
    ) {
      const { setCrewMemberRole } = await import("@/server/services/agent-crew-service");
      return setCrewMemberRole(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        memberId: input.memberId,
        role: input.role,
      });
    },
  },

  "agentCrews.archive": {
    scopes: ["ADMIN"] as const,
    input: z.object({ id: z.string().cuid() }),
    async run(input: { id: string }, ctx: McpContext) {
      const { archiveAgentCrew } = await import("@/server/services/agent-crew-service");
      await archiveAgentCrew(db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId ?? null,
        crewId: input.id,
      });
      return { ok: true };
    },
  },
} as const;

export type McpToolName = keyof typeof mcpTools;

// ---------------------------------------------------------------------------
// Tool selection — profiles & scope filtering for `tools/list` (AXI-82)
// ---------------------------------------------------------------------------
//
// The full registry advertises 200+ tools. Some providers cap the advertised
// tool list (xAI/Grok rejects >200), and a client usually stacks several MCP
// servers, so blasting the whole surface gets requests rejected. The
// `/api/mcp/rpc` route advertises a compact default profile, can narrow further
// via an explicit `?tools=ns1,ns2` namespace list, and can still expose the full
// registry with `?profile=full`. When a key is presented, results are pruned to
// what it can actually call. `tools/call` is unaffected: full capability stays
// reachable for any tool the caller names and is authorized for.

/** Namespace = the segment before the first dot (e.g. "issues.list" → "issues"). */
export function mcpToolNamespace(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/** Every registered tool name. */
export const mcpToolNames = Object.keys(mcpTools) as McpToolName[];

/** Sorted, de-duplicated list of namespaces present in the registry. */
export const mcpNamespaces: string[] = Array.from(
  new Set(mcpToolNames.map((n) => mcpToolNamespace(n))),
).sort();

export const MCP_DEFAULT_PROFILE = "runtime";

/**
 * Curated namespace bundles, selectable via `?profile=`. Each keeps the
 * advertised count well under common provider caps. `runtime` is the default
 * because it leaves room for native client tools and other MCP servers.
 * `full` is intentionally explicit.
 */
export const MCP_TOOL_PROFILES: Record<string, readonly string[]> = {
  // Agent runtime essentials: enough to read/act on issues, chat, runs, and
  // human approval requests while leaving budget for other MCP/native tools.
  runtime: ["issues", "comments", "chat", "runs", "actionRequests", "workspace"],
  // Everyday issue tracking — the smallest useful working set.
  core: [
    "issues",
    "comments",
    "projects",
    "statuses",
    "labels",
    "relations",
    "attachments",
    "agents",
    "workspace",
    "workspaces",
    "events",
    "pins",
    "notes",
  ],
  // core + iteration / roadmap planning + the goal→plan orchestration surface.
  planning: [
    "issues",
    "comments",
    "projects",
    "statuses",
    "labels",
    "relations",
    "cycles",
    "initiatives",
    "goals",
    "plans",
    "executionPlans",
    "reviewGates",
    "contextSets",
    "attachments",
    "agents",
    "workspace",
    "workspaces",
    "events",
  ],
  // core + agent orchestration / runtime ops.
  agents: [
    "issues",
    "comments",
    "agents",
    "agentCrews",
    "runs",
    "runtimes",
    "actionRequests",
    "chat",
    "reviewGates",
    "attachments",
    "workspace",
    "workspaces",
    "events",
  ],
  // Visual canvas tooling (the largest single namespace).
  canvas: ["canvases", "artifacts", "attachments", "notes", "workspace", "workspaces"],
};

/**
 * Resolve which tools `tools/list` should advertise.
 *
 * - `namespaces` (explicit `?tools=`) wins over `profile`.
 * - `"full"` means everything; omitted/unknown profiles fall back to the
 *   compact default profile rather than exposing the full registry by typo.
 * - `scopes` (the calling key's grants, when present) prunes to tools the key
 *   can actually call — mirrors `assertMcpScopes` in mcp-exec so the advertised
 *   set never lies about what's callable. A fully-scoped key still stays within
 *   the selected advertised profile unless `profile: "full"` is requested.
 */
export function selectMcpToolNames(opts: {
  profile?: string | null;
  namespaces?: readonly string[] | null;
  scopes?: readonly PluginScope[] | null;
}): McpToolName[] {
  let names: McpToolName[] = mcpToolNames;

  const nsList =
    opts.namespaces && opts.namespaces.length
      ? opts.namespaces
      : opts.profile === "full"
        ? null
        : (MCP_TOOL_PROFILES[opts.profile || MCP_DEFAULT_PROFILE] ??
          MCP_TOOL_PROFILES[MCP_DEFAULT_PROFILE]);
  if (nsList) {
    const allow = new Set(nsList);
    names = names.filter((n) => allow.has(mcpToolNamespace(n)));
  }

  if (opts.scopes) {
    const granted = new Set<PluginScope>(opts.scopes);
    names = names.filter((n) =>
      (mcpTools[n].scopes as readonly PluginScope[]).every((s) => granted.has(s)),
    );
  }

  return names;
}

/**
 * Lightweight descriptor — used by the legacy REST handler's `describe`
 * endpoint. The JSON-RPC route builds richer descriptors via
 * `zod-to-json-schema` (see `/api/mcp/rpc/route.ts`).
 */
export async function describeMcp() {
  return {
    version: 1,
    serverInfo: await mcpServerInfo(),
    tools: Object.entries(mcpTools).map(([name, t]) => ({
      name,
      scopes: t.scopes,
      policy: mcpToolPolicy(name, t.scopes),
      inputSchema: t.input._def,
    })),
  };
}
