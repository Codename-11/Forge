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
import {
  getGitHubIssue,
  getGitHubPullRequest,
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
import {
  parseGitHubUrl,
  sameRepo,
  splitRepoFullName,
} from "@/server/services/github/url";

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
): Promise<GitHubResourceSnapshot> {
  const installationId = githubInstallationId(mapping.connection);
  if (parsed.type === "PULL_REQUEST") {
    const pr = await getGitHubPullRequest({
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
    });
    return pullRequestSnapshot(parsed.repoFullName, pr);
  }
  const issue = await getGitHubIssue({
    installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
  });
  if (issue.pull_request) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That GitHub issue URL points to a pull request. Use the pull request URL instead.",
    });
  }
  return issueSnapshot(parsed.repoFullName, issue);
}

export async function fetchGitHubSnapshot(args: {
  mapping: GitHubMappingWithConnection;
  repoFullName: string;
  resourceType: GitHubResourceType;
  number: number;
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
      metadata: jsonOrNull(args.snapshot.metadata),
      externalCreatedAt: args.snapshot.externalCreatedAt ?? undefined,
      externalUpdatedAt: args.snapshot.externalUpdatedAt ?? undefined,
      lastSyncedAt: now,
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
      metadata: jsonOrNull(args.snapshot.metadata),
      externalCreatedAt: args.snapshot.externalCreatedAt ?? undefined,
      externalUpdatedAt: args.snapshot.externalUpdatedAt ?? undefined,
      lastSyncedAt: now,
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
      select: { id: true, title: true, url: true, resourceType: true, repoFullName: true, number: true },
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
  const snapshot = await fetchGitHubSnapshotForParsed(parsed, mapping);
  return args.db.$transaction(async (tx) => {
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
  repoFullName?: string | null;
  number: number;
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
  const mapping = await resolveGitHubRepoMapping({
    db: args.db,
    workspaceId: args.workspaceId,
    mappingId: args.mappingId,
    repoFullName: args.repoFullName,
  });
  const snapshot = await fetchGitHubSnapshot({
    mapping,
    repoFullName: args.repoFullName ?? mapping.target,
    resourceType: "ISSUE",
    number: args.number,
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
}): Promise<ExternalResource> {
  const existing = await args.db.externalResource.findFirst({
    where: { id: args.externalResourceId, workspaceId: args.workspaceId, provider: GITHUB_PROVIDER },
    include: {
      connectionMapping: {
        include: { connection: { select: { id: true, provider: true, config: true } } },
      },
    },
  });
  if (!existing || !existing.connectionMapping) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Linked GitHub resource with mapping not found.",
    });
  }
  const mapping = existing.connectionMapping as GitHubMappingWithConnection;
  const snapshot = await fetchGitHubSnapshot({
    mapping,
    repoFullName: existing.repoFullName,
    resourceType: existing.resourceType as GitHubResourceType,
    number: existing.number,
  });
  return args.db.$transaction(async (tx) => {
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
}
