import "server-only";
import { TRPCError } from "@trpc/server";
import {
  ConnectionProvider,
  EventKind,
  Prisma,
  type ConnectionMapping,
  type ExternalResource,
  type ExternalResourceLink,
  type PrismaClient,
  type StatusCategory,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import { createIssueWithSideEffects } from "@/server/services/issue-create";
import { reconcileGitHubPullRequestCompletion } from "@/server/services/completion-candidate";
import {
  getGitHubIssue,
  getGitHubPullRequest,
  getGitHubPullRequestChecks,
  GitHubRequestError,
  issueSnapshot,
  pullRequestSnapshot,
} from "@/server/services/github/client";
import {
  githubInstallationId,
  issueCreateInputFromGitHub,
  readGitHubMappingConfig,
} from "@/server/services/github/mapping-policy";
import {
  EXTERNAL_LINK_KINDS,
  GITHUB_PROVIDER,
  type ExternalLinkKind,
  type GitHubResourceSnapshot,
  type GitHubResourceType,
  type ParsedGitHubUrl,
} from "@/server/services/github/types";
import { parseGitHubUrl, sameRepo, splitRepoFullName } from "@/server/services/github/url";

type DbClient = PrismaClient | Prisma.TransactionClient;

type GitHubMappingWithConnection = ConnectionMapping & {
  connection: { id: string; provider: ConnectionProvider; config: Prisma.JsonValue | null };
};

export type ActorMeta = {
  actorId: string | null;
  actorAgentId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function assertLinkKind(kind: string): asserts kind is ExternalLinkKind {
  if (!EXTERNAL_LINK_KINDS.includes(kind as ExternalLinkKind)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Unsupported external link kind.",
    });
  }
}

function publicResource(row: ExternalResource) {
  return row;
}

export function gitHubPartialChecksError(metadata: unknown): GitHubRequestError | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const checks = (metadata as Record<string, unknown>).checks;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return null;
  const values = checks as Record<string, unknown>;
  if (values.partial !== true) return null;
  const retryAt =
    typeof values.retryAt === "string" && Number.isFinite(Date.parse(values.retryAt))
      ? new Date(values.retryAt)
      : null;
  const rateLimited = values.rateLimited === true;
  const timedOut = values.timedOut === true;
  const permissionDenied = values.permissionDenied === true;
  const message =
    typeof values.diagnostic === "string" && values.diagnostic.trim()
      ? values.diagnostic
      : "GitHub returned partial checks data.";
  return new GitHubRequestError(
    message,
    rateLimited ? 429 : timedOut ? 408 : permissionDenied ? 403 : 503,
    retryAt,
    rateLimited,
    timedOut,
  );
}

export async function resolveGitHubRepoMapping(args: {
  db: PrismaClient;
  workspaceId: string;
  mappingId?: string | null;
  repoFullName?: string | null;
  requireActive?: boolean;
}): Promise<GitHubMappingWithConnection> {
  const { db, workspaceId, mappingId, repoFullName, requireActive = true } = args;
  if (mappingId) {
    const mapping = await db.connectionMapping.findFirst({
      where: {
        id: mappingId,
        workspaceId,
        kind: "repo",
        ...(requireActive ? { status: "active" } : {}),
        connection: { provider: ConnectionProvider.GITHUB },
      },
      include: { connection: { select: { id: true, provider: true, config: true } } },
    });
    if (!mapping) {
      throw new TRPCError({ code: "NOT_FOUND", message: "GitHub repo mapping not found." });
    }
    return mapping;
  }

  if (!repoFullName) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "mappingId or repoFullName is required.",
    });
  }

  const mappings = await db.connectionMapping.findMany({
    where: {
      workspaceId,
      kind: "repo",
      ...(requireActive ? { status: "active" } : {}),
      connection: { provider: ConnectionProvider.GITHUB },
    },
    include: { connection: { select: { id: true, provider: true, config: true } } },
  });
  const mapping = mappings.find((m) => sameRepo(m.target, repoFullName));
  if (!mapping) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "No active GitHub mapping exists for this repository.",
    });
  }
  return mapping;
}

export async function fetchGitHubSnapshotForParsed(
  parsed: ParsedGitHubUrl,
  mapping: GitHubMappingWithConnection,
  options: { requestTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GitHubResourceSnapshot> {
  const installationId = githubInstallationId(mapping.connection);
  if (parsed.type === "PULL_REQUEST") {
    const pr = await getGitHubPullRequest({
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    });
    const snapshot = pullRequestSnapshot(parsed.repoFullName, pr);
    if (pr.head?.sha) {
      snapshot.metadata = {
        ...(snapshot.metadata as Record<string, unknown>),
        checks: await getGitHubPullRequestChecks({
          installationId,
          owner: parsed.owner,
          repo: parsed.repo,
          headSha: pr.head.sha,
          requestTimeoutMs: options.requestTimeoutMs,
          signal: options.signal,
        }),
      };
    }
    return snapshot;
  }
  const issue = await getGitHubIssue({
    installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    requestTimeoutMs: options.requestTimeoutMs,
    signal: options.signal,
  });
  if (issue.pull_request) {
    const pr = await getGitHubPullRequest({
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    });
    const snapshot = pullRequestSnapshot(parsed.repoFullName, pr);
    if (pr.head?.sha) {
      snapshot.metadata = {
        ...(snapshot.metadata as Record<string, unknown>),
        checks: await getGitHubPullRequestChecks({
          installationId,
          owner: parsed.owner,
          repo: parsed.repo,
          headSha: pr.head.sha,
          requestTimeoutMs: options.requestTimeoutMs,
          signal: options.signal,
        }),
      };
    }
    return snapshot;
  }
  return issueSnapshot(parsed.repoFullName, issue);
}

export async function fetchGitHubSnapshot(args: {
  mapping: GitHubMappingWithConnection;
  repoFullName: string;
  resourceType: GitHubResourceType;
  number: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubResourceSnapshot> {
  const repo = splitRepoFullName(args.repoFullName);
  return fetchGitHubSnapshotForParsed(
    {
      ...repo,
      type: args.resourceType,
      number: args.number,
      url:
        args.resourceType === "PULL_REQUEST"
          ? `https://github.com/${repo.repoFullName}/pull/${args.number}`
          : `https://github.com/${repo.repoFullName}/issues/${args.number}`,
    },
    args.mapping,
    { requestTimeoutMs: args.requestTimeoutMs, signal: args.signal },
  );
}

export async function upsertExternalResource(
  db: DbClient,
  args: {
    workspaceId: string;
    connectionMappingId?: string | null;
    snapshot: GitHubResourceSnapshot;
  },
): Promise<ExternalResource> {
  const now = new Date();
  const existing = await db.externalResource.findUnique({
    where: {
      workspaceId_provider_repoFullName_resourceType_number: {
        workspaceId: args.workspaceId,
        provider: args.snapshot.provider,
        repoFullName: args.snapshot.repoFullName,
        resourceType: args.snapshot.resourceType,
        number: args.snapshot.number,
      },
    },
    select: { metadata: true, syncFailureCount: true },
  });
  const existingMetadata =
    existing?.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const snapshotMetadata =
    args.snapshot.metadata &&
    typeof args.snapshot.metadata === "object" &&
    !Array.isArray(args.snapshot.metadata)
      ? (args.snapshot.metadata as Record<string, unknown>)
      : {};
  const metadata = {
    ...existingMetadata,
    ...snapshotMetadata,
  };
  const existingHead =
    existingMetadata.head &&
    typeof existingMetadata.head === "object" &&
    !Array.isArray(existingMetadata.head)
      ? (existingMetadata.head as Record<string, unknown>)
      : {};
  const snapshotHead =
    snapshotMetadata.head &&
    typeof snapshotMetadata.head === "object" &&
    !Array.isArray(snapshotMetadata.head)
      ? (snapshotMetadata.head as Record<string, unknown>)
      : {};
  if (
    typeof existingHead.sha === "string" &&
    typeof snapshotHead.sha === "string" &&
    existingHead.sha !== snapshotHead.sha &&
    !("checks" in snapshotMetadata)
  ) {
    delete metadata.checks;
  }
  const checks =
    metadata.checks && typeof metadata.checks === "object" && !Array.isArray(metadata.checks)
      ? (metadata.checks as Record<string, unknown>)
      : {};
  const passingChecks =
    checks.source === "api-aggregate" &&
    checks.status === "completed" &&
    typeof checks.conclusion === "string" &&
    ["success", "neutral", "skipped"].includes(checks.conclusion);
  const checksDiagnostic =
    checks.partial === true && typeof checks.diagnostic === "string"
      ? checks.diagnostic.slice(0, 2_000)
      : null;
  const checksRetryAt =
    typeof checks.retryAt === "string" && Number.isFinite(Date.parse(checks.retryAt))
      ? new Date(checks.retryAt)
      : null;
  const terminal =
    args.snapshot.resourceType === "PULL_REQUEST" &&
    (args.snapshot.state === "closed" || (args.snapshot.state === "merged" && passingChecks));
  const row = await db.externalResource.upsert({
    where: {
      workspaceId_provider_repoFullName_resourceType_number: {
        workspaceId: args.workspaceId,
        provider: args.snapshot.provider,
        repoFullName: args.snapshot.repoFullName,
        resourceType: args.snapshot.resourceType,
        number: args.snapshot.number,
      },
    },
    create: {
      workspaceId: args.workspaceId,
      provider: args.snapshot.provider,
      connectionMappingId: args.connectionMappingId ?? undefined,
      resourceType: args.snapshot.resourceType,
      repoFullName: args.snapshot.repoFullName,
      externalId: args.snapshot.externalId ?? undefined,
      externalNodeId: args.snapshot.externalNodeId ?? undefined,
      number: args.snapshot.number,
      url: args.snapshot.url,
      apiUrl: args.snapshot.apiUrl ?? undefined,
      title: args.snapshot.title,
      state: args.snapshot.state,
      authorLogin: args.snapshot.authorLogin ?? undefined,
      labels: jsonOrNull(args.snapshot.labels),
      assignees: jsonOrNull(args.snapshot.assignees),
      metadata: jsonOrNull(metadata),
      externalCreatedAt: args.snapshot.externalCreatedAt ?? undefined,
      externalUpdatedAt: args.snapshot.externalUpdatedAt ?? undefined,
      lastSyncedAt: now,
      syncAttemptedAt: now,
      syncRetryAt: checksDiagnostic ? checksRetryAt : null,
      syncFailureCount: checksDiagnostic ? 1 : 0,
      syncLastError: checksDiagnostic,
      syncTerminalAt: terminal ? now : undefined,
    },
    update: {
      connectionMappingId: args.connectionMappingId ?? undefined,
      externalId: args.snapshot.externalId ?? undefined,
      externalNodeId: args.snapshot.externalNodeId ?? undefined,
      url: args.snapshot.url,
      apiUrl: args.snapshot.apiUrl ?? undefined,
      title: args.snapshot.title,
      state: args.snapshot.state,
      authorLogin: args.snapshot.authorLogin ?? undefined,
      labels: jsonOrNull(args.snapshot.labels),
      assignees: jsonOrNull(args.snapshot.assignees),
      metadata: jsonOrNull(metadata),
      externalCreatedAt: args.snapshot.externalCreatedAt ?? undefined,
      externalUpdatedAt: args.snapshot.externalUpdatedAt ?? undefined,
      lastSyncedAt: now,
      syncAttemptedAt: now,
      syncRetryAt: checksDiagnostic ? checksRetryAt : null,
      syncFailureCount: checksDiagnostic ? (existing?.syncFailureCount ?? 0) + 1 : 0,
      syncLastError: checksDiagnostic,
      syncTerminalAt: terminal ? now : null,
    },
  });
  return row;
}

export async function linkExternalResourceToIssue(
  db: DbClient,
  args: {
    workspaceId: string;
    issueId: string;
    externalResourceId: string;
    kind: ExternalLinkKind;
    actor: ActorMeta;
    recordActivity?: boolean;
  },
): Promise<ExternalResourceLink> {
  const [issue, resource] = await Promise.all([
    db.issue.findFirst({
      where: { id: args.issueId, workspaceId: args.workspaceId, deletedAt: null },
      select: { id: true },
    }),
    db.externalResource.findFirst({
      where: { id: args.externalResourceId, workspaceId: args.workspaceId },
      select: {
        id: true,
        title: true,
        url: true,
        resourceType: true,
        repoFullName: true,
        number: true,
      },
    }),
  ]);
  if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });
  if (!resource) {
    throw new TRPCError({ code: "NOT_FOUND", message: "External resource not found." });
  }

  const link = await db.externalResourceLink.upsert({
    where: {
      issueId_externalResourceId_kind: {
        issueId: args.issueId,
        externalResourceId: args.externalResourceId,
        kind: args.kind,
      },
    },
    create: {
      workspaceId: args.workspaceId,
      issueId: args.issueId,
      externalResourceId: args.externalResourceId,
      kind: args.kind,
      createdById: args.actor.actorId ?? undefined,
    },
    update: {},
  });

  if (args.recordActivity ?? true) {
    await recordChange(db, {
      workspaceId: args.workspaceId,
      actorId: args.actor.actorId,
      actorAgentId: args.actor.actorAgentId ?? null,
      entity: "Issue",
      entityId: args.issueId,
      action: "external-resource.link",
      after: link,
      eventKind: EventKind.ISSUE_UPDATED,
      subjectType: "issue",
      subjectId: args.issueId,
      payload: {
        source: "github",
        change: "external-resource-linked",
        externalResourceId: args.externalResourceId,
        linkKind: args.kind,
        resourceType: resource.resourceType,
        repo: resource.repoFullName,
        number: resource.number,
        url: resource.url,
      },
      ip: args.actor.ip ?? null,
      userAgent: args.actor.userAgent ?? null,
    });
  }

  return link;
}

export async function linkGitHubUrlToIssue(args: {
  db: PrismaClient;
  workspaceId: string;
  issueId: string;
  url: string;
  kind: string;
  actor: ActorMeta;
  mappingId?: string | null;
}): Promise<{ resource: ExternalResource; link: ExternalResourceLink }> {
  const kind = args.kind;
  assertLinkKind(kind);
  const parsed = parseGitHubUrl(args.url);
  const mapping = await resolveGitHubRepoMapping({
    db: args.db,
    workspaceId: args.workspaceId,
    mappingId: args.mappingId,
    repoFullName: parsed.repoFullName,
  });
  const workspace = await args.db.workspace.findUniqueOrThrow({
    where: { id: args.workspaceId },
    select: { githubRequestTimeoutSeconds: true },
  });
  const snapshot = await fetchGitHubSnapshotForParsed(parsed, mapping, {
    requestTimeoutMs: workspace.githubRequestTimeoutSeconds * 1000,
  });
  const result = await args.db.$transaction(async (tx) => {
    const resource = await upsertExternalResource(tx, {
      workspaceId: args.workspaceId,
      connectionMappingId: mapping.id,
      snapshot,
    });
    const link = await linkExternalResourceToIssue(tx, {
      workspaceId: args.workspaceId,
      issueId: args.issueId,
      externalResourceId: resource.id,
      kind,
      actor: args.actor,
    });
    return { resource, link };
  });
  if (result.resource.resourceType === "PULL_REQUEST") {
    await reconcileGitHubPullRequestCompletion(args.db, {
      workspaceId: args.workspaceId,
      externalResourceId: result.resource.id,
      actorId: args.actor.actorId,
      actorAgentId: args.actor.actorAgentId,
    });
  }
  return result;
}

export async function listLinkedGitHubResources(args: {
  db: PrismaClient;
  workspaceId: string;
  issueId: string;
}): Promise<Array<ExternalResourceLink & { externalResource: ExternalResource }>> {
  return args.db.externalResourceLink.findMany({
    where: {
      workspaceId: args.workspaceId,
      issueId: args.issueId,
      externalResource: { provider: GITHUB_PROVIDER },
    },
    include: { externalResource: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function importGitHubIssue(args: {
  db: PrismaClient;
  workspaceId: string;
  mappingId?: string | null;
  url?: string | null;
  repoFullName?: string | null;
  resourceType?: GitHubResourceType;
  number?: number | null;
  actor: ActorMeta;
  projectId?: string | null;
  labelIds?: string[];
  queue?: boolean;
}): Promise<{
  issueId: string;
  created: boolean;
  resource: ExternalResource;
  link: ExternalResourceLink;
}> {
  const parsed = args.url ? parseGitHubUrl(args.url) : null;
  const repoFullName = parsed?.repoFullName ?? args.repoFullName;
  const number = parsed?.number ?? args.number;
  if (!repoFullName || !number) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Provide a GitHub URL, or repoFullName + number.",
    });
  }
  const mapping = await resolveGitHubRepoMapping({
    db: args.db,
    workspaceId: args.workspaceId,
    mappingId: args.mappingId,
    repoFullName,
  });
  const workspace = await args.db.workspace.findUniqueOrThrow({
    where: { id: args.workspaceId },
    select: { githubRequestTimeoutSeconds: true },
  });
  const requestTimeoutMs = workspace.githubRequestTimeoutSeconds * 1000;
  const snapshot = parsed
    ? await fetchGitHubSnapshotForParsed(parsed, mapping, { requestTimeoutMs })
    : await fetchGitHubSnapshot({
        mapping,
        repoFullName,
        resourceType: args.resourceType ?? "ISSUE",
        number,
        requestTimeoutMs,
      });
  const resource = await upsertExternalResource(args.db, {
    workspaceId: args.workspaceId,
    connectionMappingId: mapping.id,
    snapshot,
  });

  const existing = await args.db.externalResourceLink.findFirst({
    where: {
      workspaceId: args.workspaceId,
      externalResourceId: resource.id,
      kind: "SOURCE",
    },
    select: { id: true, issueId: true },
  });
  if (existing) {
    return {
      issueId: existing.issueId,
      created: false,
      resource,
      link: await args.db.externalResourceLink.findUniqueOrThrow({ where: { id: existing.id } }),
    };
  }

  const issue = await createIssueWithSideEffects({
    db: args.db,
    workspaceId: args.workspaceId,
    actorId: args.actor.actorId,
    actorAgentId: args.actor.actorAgentId ?? null,
    ip: args.actor.ip ?? null,
    userAgent: args.actor.userAgent ?? null,
    input: issueCreateInputFromGitHub({
      mapping,
      snapshot,
      projectId: args.projectId,
      labelIds: args.labelIds,
      queue: args.queue,
    }),
  });

  const link = await args.db.$transaction((tx) =>
    linkExternalResourceToIssue(tx, {
      workspaceId: args.workspaceId,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "SOURCE",
      actor: args.actor,
    }),
  );

  return { issueId: issue.id, created: true, resource, link };
}

async function applyIssuePatchFromGitHub(args: {
  tx: DbClient;
  workspaceId: string;
  issueId: string;
  title?: string;
  statusId?: string | null;
  actor: ActorMeta;
  payload: Prisma.InputJsonObject;
}): Promise<void> {
  const before = await args.tx.issue.findFirst({
    where: { id: args.issueId, workspaceId: args.workspaceId, deletedAt: null },
    include: { status: true },
  });
  if (!before) return;

  const patch: Prisma.IssueUpdateInput = {};
  if (args.title && args.title !== before.title) patch.title = args.title;

  let nextCategory: StatusCategory | null = null;
  if (args.statusId && args.statusId !== before.statusId) {
    const status = await args.tx.status.findFirst({
      where: { id: args.statusId, workspaceId: args.workspaceId },
      select: { id: true, category: true },
    });
    if (!status) return;
    patch.status = { connect: { id: status.id } };
    nextCategory = status.category;
    if (status.category === "IN_PROGRESS" && !before.startedAt) patch.startedAt = new Date();
    if (status.category === "DONE") patch.completedAt = new Date();
    if (status.category === "CANCELED") patch.canceledAt = new Date();
    if (status.category !== "DONE") patch.completedAt = null;
    if (status.category !== "CANCELED") patch.canceledAt = null;
  }

  if (Object.keys(patch).length === 0) return;

  const after = await args.tx.issue.update({
    where: { id: before.id },
    data: patch,
    include: { status: true },
  });
  await recordChange(args.tx, {
    workspaceId: args.workspaceId,
    actorId: args.actor.actorId,
    actorAgentId: args.actor.actorAgentId ?? null,
    entity: "Issue",
    entityId: before.id,
    action: "github-sync",
    before,
    after,
    eventKind: nextCategory ? EventKind.ISSUE_STATUS_CHANGED : EventKind.ISSUE_UPDATED,
    subjectType: "issue",
    subjectId: before.id,
    payload: args.payload,
    ip: args.actor.ip ?? null,
    userAgent: args.actor.userAgent ?? null,
  });
}

export async function applyGitHubSnapshotToLinkedIssues(args: {
  tx: DbClient;
  workspaceId: string;
  resourceId: string;
  mapping: Pick<ConnectionMapping, "config">;
  snapshot: GitHubResourceSnapshot;
  actor: ActorMeta;
  statusRuleId?: string | null;
}): Promise<void> {
  const config = readGitHubMappingConfig(args.mapping.config);
  const links = await args.tx.externalResourceLink.findMany({
    where: { workspaceId: args.workspaceId, externalResourceId: args.resourceId },
    select: { issueId: true, kind: true },
  });
  for (const link of links) {
    await applyIssuePatchFromGitHub({
      tx: args.tx,
      workspaceId: args.workspaceId,
      issueId: link.issueId,
      title: config.syncTitle && link.kind === "SOURCE" ? args.snapshot.title : undefined,
      statusId: args.statusRuleId ?? null,
      actor: args.actor,
      payload: {
        source: "github",
        change: "github-sync",
        externalResourceId: args.resourceId,
        resourceType: args.snapshot.resourceType,
        repo: args.snapshot.repoFullName,
        number: args.snapshot.number,
        state: args.snapshot.state,
      },
    });
  }
}

export async function syncGitHubExternalResource(args: {
  db: PrismaClient;
  workspaceId: string;
  externalResourceId: string;
  actor: ActorMeta;
  skipCollisionGuard?: boolean;
  signal?: AbortSignal;
}): Promise<ExternalResource> {
  const workspace = await args.db.workspace.findFirst({
    where: { id: args.workspaceId, deletedAt: null },
    select: {
      githubRequestTimeoutSeconds: true,
      githubManualCooldownSeconds: true,
      githubSyncBackoffMinutes: true,
      githubSyncMaxBackoffMinutes: true,
    },
  });
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
  const now = new Date();
  const existing = await args.db.externalResource.findFirst({
    where: {
      id: args.externalResourceId,
      workspaceId: args.workspaceId,
      provider: GITHUB_PROVIDER,
    },
    include: {
      connectionMapping: {
        include: { connection: { select: { id: true, provider: true, config: true } } },
      },
    },
  });
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Linked GitHub resource not found.",
    });
  }
  if (!args.skipCollisionGuard) {
    const leaseMs = workspace.githubRequestTimeoutSeconds * 12_000 + 5_000;
    const claimed = await claimGitHubManualSync({
      db: args.db,
      workspaceId: args.workspaceId,
      externalResourceId: args.externalResourceId,
      now,
      cooldownSeconds: workspace.githubManualCooldownSeconds,
      leaseUntil: new Date(now.getTime() + leaseMs),
    });
    if (!claimed) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "This GitHub link was refreshed recently or is already being refreshed.",
      });
    }
  }
  const mapping =
    existing.connectionMapping?.status === "active"
      ? (existing.connectionMapping as GitHubMappingWithConnection)
      : await resolveGitHubRepoMapping({
          db: args.db,
          workspaceId: args.workspaceId,
          repoFullName: existing.repoFullName,
        });
  let snapshot: GitHubResourceSnapshot;
  try {
    snapshot = await fetchGitHubSnapshot({
      mapping,
      repoFullName: existing.repoFullName,
      resourceType: existing.resourceType as GitHubResourceType,
      number: existing.number,
      requestTimeoutMs: workspace.githubRequestTimeoutSeconds * 1000,
      signal: args.signal,
    });
  } catch (error) {
    // Scheduled reconciliation owns its own retry accounting. Manual/MCP
    // refreshes must persist the provider reset/backoff before returning the
    // error so a short collision lease cannot accidentally become the retry
    // policy and the issue panel retains the real diagnostic.
    if (!args.skipCollisionGuard) {
      await persistGitHubManualSyncFailure({
        db: args.db,
        workspaceId: args.workspaceId,
        externalResourceId: existing.id,
        connectionMappingId: mapping.id,
        currentFailureCount: existing.syncFailureCount,
        // Anchor retry timing after the provider call finishes. A request may
        // consume the entire configured timeout, which could otherwise make a
        // short backoff expire before the failure is persisted.
        now: new Date(),
        baseMinutes: workspace.githubSyncBackoffMinutes,
        maxMinutes: workspace.githubSyncMaxBackoffMinutes,
        error,
      });
    }
    throw error;
  }
  let resource = await args.db.$transaction(async (tx) => {
    const resource = await upsertExternalResource(tx, {
      workspaceId: args.workspaceId,
      connectionMappingId: mapping.id,
      snapshot,
    });
    await applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId: args.workspaceId,
      resourceId: resource.id,
      mapping,
      snapshot,
      actor: args.actor,
    });
    return publicResource(resource);
  });
  const partialChecksError = gitHubPartialChecksError(snapshot.metadata);
  if (!args.skipCollisionGuard && partialChecksError) {
    const failureNow = new Date();
    const failure = await persistGitHubManualSyncFailure({
      db: args.db,
      workspaceId: args.workspaceId,
      externalResourceId: existing.id,
      connectionMappingId: mapping.id,
      currentFailureCount: existing.syncFailureCount,
      now: failureNow,
      baseMinutes: workspace.githubSyncBackoffMinutes,
      maxMinutes: workspace.githubSyncMaxBackoffMinutes,
      error: partialChecksError,
      incrementFailureCount: false,
    });
    resource = {
      ...resource,
      syncAttemptedAt: failureNow,
      syncRetryAt: failure.retryAt,
      syncFailureCount: failure.failureCount,
      syncLastError: partialChecksError.message.slice(0, 2_000),
    };
  }
  if (resource.resourceType === "PULL_REQUEST") {
    await reconcileGitHubPullRequestCompletion(args.db, {
      workspaceId: args.workspaceId,
      externalResourceId: resource.id,
      actorId: args.actor.actorId,
      actorAgentId: args.actor.actorAgentId,
    });
  }
  return resource;
}

export async function claimGitHubManualSync(args: {
  db: PrismaClient;
  workspaceId: string;
  externalResourceId: string;
  now: Date;
  cooldownSeconds: number;
  leaseUntil: Date;
}): Promise<boolean> {
  const cooldownBefore = new Date(args.now.getTime() - args.cooldownSeconds * 1000);
  const claimed = await args.db.externalResource.updateMany({
    where: {
      id: args.externalResourceId,
      workspaceId: args.workspaceId,
      provider: GITHUB_PROVIDER,
      OR: [{ syncAttemptedAt: null }, { syncAttemptedAt: { lte: cooldownBefore } }],
      AND: [{ OR: [{ syncRetryAt: null }, { syncRetryAt: { lte: args.now } }] }],
    },
    data: { syncAttemptedAt: args.now, syncRetryAt: args.leaseUntil },
  });
  return claimed.count === 1;
}

export async function persistGitHubManualSyncFailure(args: {
  db: PrismaClient;
  workspaceId: string;
  externalResourceId: string;
  connectionMappingId: string | null;
  currentFailureCount: number;
  now: Date;
  baseMinutes: number;
  maxMinutes: number;
  error: unknown;
  incrementFailureCount?: boolean;
}): Promise<{ retryAt: Date; failureCount: number; mappingWide: boolean }> {
  const failureCount = args.currentFailureCount + 1;
  const exponentialMinutes = Math.min(
    Math.max(1, args.maxMinutes),
    Math.max(1, args.baseMinutes) * 2 ** Math.max(0, failureCount - 1),
  );
  const fallbackRetryAt = new Date(args.now.getTime() + exponentialMinutes * 60_000);
  const providerRetryAt = args.error instanceof GitHubRequestError ? args.error.retryAt : null;
  const retryAt =
    providerRetryAt && providerRetryAt > fallbackRetryAt ? providerRetryAt : fallbackRetryAt;
  const message =
    args.error instanceof Error ? args.error.message.slice(0, 2_000) : "Unknown GitHub sync error";
  const mappingWide =
    args.error instanceof GitHubRequestError &&
    (args.error.rateLimited || args.error.timedOut || [401, 403].includes(args.error.status));

  await args.db.$transaction(async (tx) => {
    await tx.externalResource.updateMany({
      where: {
        id: args.externalResourceId,
        workspaceId: args.workspaceId,
        provider: GITHUB_PROVIDER,
      },
      data: {
        syncAttemptedAt: args.now,
        ...(args.incrementFailureCount === false ? {} : { syncFailureCount: { increment: 1 } }),
        syncLastError: message,
      },
    });
    await tx.externalResource.updateMany({
      where: {
        id: args.externalResourceId,
        workspaceId: args.workspaceId,
        provider: GITHUB_PROVIDER,
        OR: [{ syncRetryAt: null }, { syncRetryAt: { lt: retryAt } }],
      },
      data: { syncRetryAt: retryAt },
    });
    if (mappingWide && args.connectionMappingId) {
      await tx.externalResource.updateMany({
        where: {
          id: { not: args.externalResourceId },
          workspaceId: args.workspaceId,
          provider: GITHUB_PROVIDER,
          connectionMappingId: args.connectionMappingId,
          OR: [{ syncRetryAt: null }, { syncRetryAt: { lt: retryAt } }],
        },
        data: { syncRetryAt: retryAt, syncLastError: message },
      });
    }
  });

  const persisted = await args.db.externalResource.findFirst({
    where: {
      id: args.externalResourceId,
      workspaceId: args.workspaceId,
      provider: GITHUB_PROVIDER,
    },
    select: { syncRetryAt: true, syncFailureCount: true },
  });
  return {
    retryAt: persisted?.syncRetryAt ?? retryAt,
    failureCount: persisted?.syncFailureCount ?? failureCount,
    mappingWide,
  };
}
