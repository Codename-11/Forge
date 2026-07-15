import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CommentKind, type ExternalResource, type Prisma, type PrismaClient } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { createIssueWithSideEffects } from "@/server/services/issue-create";
import { reconcileGitHubPullRequestCompletion } from "@/server/services/completion-candidate";
import {
  issueSnapshot,
  pullRequestSnapshot,
  type GitHubIssueResponse,
  type GitHubPullResponse,
} from "@/server/services/github/client";
import {
  issueCreateInputFromGitHub,
  readGitHubMappingConfig,
  statusRuleForGitHubEvent,
} from "@/server/services/github/mapping-policy";
import {
  applyGitHubSnapshotToLinkedIssues,
  acquireGitHubResourceOrderLock,
  canonicalizeGitHubResourceIdentity,
  gitHubResourceVersionMatches,
  linkExternalResourceToIssue,
  recordGitHubResourceChangeToLinkedIssues,
  upsertExternalResource,
  upsertExternalResourceFromWebhook,
  type ActorMeta,
} from "@/server/services/github/resource-sync";
import { GITHUB_PROVIDER, type GitHubResourceSnapshot } from "@/server/services/github/types";

type GitHubWebhookRepository = {
  full_name?: string;
};

type GitHubWebhookInstallation = {
  id?: number;
};

type GitHubWebhookPayload = {
  action?: string;
  sha?: string | null;
  state?: string | null;
  installation?: GitHubWebhookInstallation;
  repository?: GitHubWebhookRepository;
  issue?: GitHubIssueResponse;
  pull_request?: GitHubPullResponse;
  review?: {
    id?: number | null;
    state?: string | null;
    submitted_at?: string | null;
    user?: { login?: string | null } | null;
  };
  check_suite?: {
    head_sha?: string | null;
    conclusion?: string | null;
    status?: string | null;
    pull_requests?: Array<{ number?: number | null; url?: string | null }>;
  };
  check_run?: {
    head_sha?: string | null;
    conclusion?: string | null;
    status?: string | null;
    pull_requests?: Array<{ number?: number | null; url?: string | null }>;
  };
  comment?: {
    id?: number | null;
    html_url?: string | null;
    body?: string | null;
    user?: { login?: string | null } | null;
  };
};

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export type GitHubWebhookResult = {
  ok: true;
  duplicate?: boolean;
  processed: number;
  skipped?: string;
};

function webhookSecret(): string {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_APP_WEBHOOK_SECRET is not configured.");
  return secret;
}

export function verifyGitHubWebhookSignature(args: {
  secret: string;
  rawBody: string | Buffer;
  signature: string | null;
}): boolean {
  if (!args.signature?.startsWith("sha256=")) return false;
  const body = typeof args.rawBody === "string" ? Buffer.from(args.rawBody, "utf8") : args.rawBody;
  const expected = `sha256=${createHmac("sha256", args.secret).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function repoFromPayload(payload: GitHubWebhookPayload): string | null {
  return payload.repository?.full_name ?? null;
}

async function activeMappingsForPayload(args: {
  db: PrismaClient;
  repoFullName: string;
  installationId?: number | null;
}) {
  const rows = await args.db.connectionMapping.findMany({
    where: {
      kind: "repo",
      status: "active",
      connection: { provider: "GITHUB" },
    },
    include: {
      connection: { select: { id: true, provider: true, config: true } },
      workspace: { select: { id: true, key: true } },
    },
  });
  return rows.filter((row) => {
    if (row.target.toLowerCase() !== args.repoFullName.toLowerCase()) return false;
    if (!args.installationId) return true;
    const cfg = row.connection.config;
    if (!cfg || typeof cfg !== "object" || !("installationId" in cfg)) return false;
    return (
      String((cfg as { installationId?: unknown }).installationId) === String(args.installationId)
    );
  });
}

/** Claim a new, failed, or abandoned delivery without racing an in-flight request. */
export async function claimGitHubWebhookDelivery(args: {
  db: PrismaClient;
  deliveryId: string;
  event: string;
  action: string | null;
  repoFullName: string | null;
  now?: Date;
}): Promise<"CLAIMED" | "DUPLICATE"> {
  const now = args.now ?? new Date();
  const inserted = await args.db.externalWebhookEvent.createMany({
    data: [
      {
        provider: GITHUB_PROVIDER,
        deliveryId: args.deliveryId,
        event: args.event,
        action: args.action,
        repoFullName: args.repoFullName,
        status: "RECEIVED",
        processingStartedAt: now,
        attemptCount: 1,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 1) return "CLAIMED";

  const staleBefore = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  const reclaimed = await args.db.externalWebhookEvent.updateMany({
    where: {
      provider: GITHUB_PROVIDER,
      deliveryId: args.deliveryId,
      OR: [
        { status: "FAILED" },
        {
          status: "RECEIVED",
          OR: [{ processingStartedAt: null }, { processingStartedAt: { lte: staleBefore } }],
        },
      ],
    },
    data: {
      event: args.event,
      action: args.action,
      repoFullName: args.repoFullName,
      status: "RECEIVED",
      error: null,
      processedAt: null,
      processingStartedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  return reclaimed.count === 1 ? "CLAIMED" : "DUPLICATE";
}

function forgeIssueKeys(text: string | null | undefined, workspaceKey: string): number[] {
  if (!text) return [];
  const escaped = workspaceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}-(\\d+)\\b`, "gi");
  const out = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

async function ensureSourceIssueForSnapshot(args: {
  db: PrismaClient;
  workspaceId: string;
  mapping: Parameters<typeof issueCreateInputFromGitHub>[0]["mapping"] & { id: string };
  snapshot: GitHubResourceSnapshot;
  resource: ExternalResource;
  actor: ActorMeta;
}) {
  const resource = args.resource;
  const existing = await args.db.externalResourceLink.findFirst({
    where: {
      workspaceId: args.workspaceId,
      externalResourceId: resource.id,
      kind: "SOURCE",
    },
    select: { issueId: true, id: true },
  });
  if (existing) return { resource, issueId: existing.issueId, created: false };

  const issue = await createIssueWithSideEffects({
    db: args.db,
    workspaceId: args.workspaceId,
    actorId: args.actor.actorId,
    actorAgentId: args.actor.actorAgentId ?? null,
    ip: args.actor.ip ?? null,
    userAgent: args.actor.userAgent ?? null,
    input: issueCreateInputFromGitHub({
      mapping: args.mapping,
      snapshot: args.snapshot,
    }),
  });
  await args.db.$transaction((tx) =>
    linkExternalResourceToIssue(tx, {
      workspaceId: args.workspaceId,
      issueId: issue.id,
      externalResourceId: resource.id,
      kind: "SOURCE",
      actor: args.actor,
    }),
  );
  return { resource, issueId: issue.id, created: true };
}

async function processIssueEvent(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
}): Promise<number> {
  if (!args.payload.issue || !args.mapping.workspace?.id) return 0;
  if (args.payload.issue.pull_request) return 0;
  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  const snapshot = issueSnapshot(args.mapping.target, args.payload.issue);
  const persisted = await upsertExternalResourceFromWebhook(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
    allowEqualTimestampReopen: args.payload.action === "reopened",
  });
  if (!persisted.applied) return 0;
  let resource = persisted.resource;

  if (args.payload.action === "opened" && config.autoCreateIssues) {
    const created = await ensureSourceIssueForSnapshot({
      db: args.db,
      workspaceId,
      mapping: args.mapping,
      snapshot,
      resource,
      actor: args.actor,
    });
    resource = created.resource;
  }

  const rule =
    args.payload.action === "closed"
      ? statusRuleForGitHubEvent(config, "issueClosedStatusId")
      : args.payload.action === "reopened"
        ? statusRuleForGitHubEvent(config, "issueReopenedStatusId")
        : null;

  await args.db.$transaction(async (tx) => {
    await acquireGitHubResourceOrderLock(tx, {
      workspaceId,
      repoFullName: resource.repoFullName,
      resourceType: resource.resourceType,
      number: resource.number,
    });
    const current = await tx.externalResource.findUnique({ where: { id: resource.id } });
    if (!current || !gitHubResourceVersionMatches(current, resource)) return;
    const appliedSnapshot = {
      ...snapshot,
      title: current.title,
      state: current.state,
      metadata: current.metadata,
    };
    const changedIssueIds = await applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot: appliedSnapshot,
      actor: args.actor,
      statusRuleId: rule,
    });
    await recordGitHubResourceChangeToLinkedIssues({
      db: tx,
      workspaceId,
      before: persisted.previous,
      after: current,
      actor: args.actor,
      source: "github-webhook",
      skipIssueIds: changedIssueIds,
    });
  });
  return 1;
}

async function processPullRequestEvent(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
}): Promise<number> {
  if (!args.payload.pull_request || !args.mapping.workspace?.id) return 0;
  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  const snapshot = pullRequestSnapshot(args.mapping.target, args.payload.pull_request);
  const actionNeedsAggregateRefresh = [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "review_requested",
    "review_request_removed",
    "closed",
  ].includes(args.payload.action ?? "");
  if (
    args.payload.action === "review_requested" ||
    args.payload.action === "review_request_removed"
  ) {
    snapshot.metadata = {
      ...(snapshot.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : {}),
      reviewHint: {
        dirty: true,
        event: args.payload.action,
        source: "webhook-hint",
        updatedAt: args.payload.pull_request.updated_at ?? new Date().toISOString(),
      },
    };
  }
  const persisted = await upsertExternalResourceFromWebhook(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
    invalidateSync: actionNeedsAggregateRefresh,
    allowEqualTimestampReopen: args.payload.action === "reopened",
  });
  if (!persisted.applied) return 0;
  const resource = persisted.resource;

  const keyNumbers = [
    ...forgeIssueKeys(args.payload.pull_request.title, args.mapping.workspace.key),
    ...forgeIssueKeys(args.payload.pull_request.body, args.mapping.workspace.key),
  ];
  const issues =
    keyNumbers.length > 0
      ? await args.db.issue.findMany({
          where: { workspaceId, number: { in: keyNumbers }, deletedAt: null },
          select: { id: true },
        })
      : [];

  const rule =
    args.payload.action === "opened"
      ? statusRuleForGitHubEvent(config, "prOpenedStatusId")
      : args.payload.action === "ready_for_review"
        ? statusRuleForGitHubEvent(config, "prReadyForReviewStatusId")
        : args.payload.action === "closed" && args.payload.pull_request.merged
          ? statusRuleForGitHubEvent(config, "prMergedStatusId")
          : null;

  await args.db.$transaction(async (tx) => {
    await acquireGitHubResourceOrderLock(tx, {
      workspaceId,
      repoFullName: resource.repoFullName,
      resourceType: resource.resourceType,
      number: resource.number,
    });
    const current = await tx.externalResource.findUnique({ where: { id: resource.id } });
    if (!current || !gitHubResourceVersionMatches(current, resource)) return;
    for (const issue of issues) {
      await linkExternalResourceToIssue(tx, {
        workspaceId,
        issueId: issue.id,
        externalResourceId: resource.id,
        kind: "IMPLEMENTS",
        actor: args.actor,
      });
    }
    const changedIssueIds = await applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot: {
        ...snapshot,
        title: current.title,
        state: current.state,
        metadata: current.metadata,
      },
      actor: args.actor,
      statusRuleId: rule,
    });
    await recordGitHubResourceChangeToLinkedIssues({
      db: tx,
      workspaceId,
      before: persisted.previous,
      after: current,
      actor: args.actor,
      source: "github-webhook",
      skipIssueIds: changedIssueIds,
    });
  });
  await reconcileGitHubPullRequestCompletion(args.db, {
    workspaceId,
    externalResourceId: resource.id,
    actorId: args.actor.actorId,
    actorAgentId: args.actor.actorAgentId,
  });
  return 1;
}

async function processReviewEvent(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
}): Promise<number> {
  if (!args.payload.pull_request || !args.mapping.workspace?.id) return 0;
  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  const snapshot = pullRequestSnapshot(args.mapping.target, args.payload.pull_request);
  const submittedAt = args.payload.review?.submitted_at ?? null;
  const reviewState = args.payload.review?.state?.toUpperCase() ?? null;
  const decision =
    reviewState === "APPROVED" || reviewState === "CHANGES_REQUESTED" ? reviewState : null;
  const rule =
    decision === "CHANGES_REQUESTED"
      ? statusRuleForGitHubEvent(config, "prChangesRequestedStatusId")
      : null;
  const persisted = await args.db.$transaction(async (tx) => {
    await acquireGitHubResourceOrderLock(tx, {
      workspaceId,
      repoFullName: snapshot.repoFullName,
      resourceType: snapshot.resourceType,
      number: snapshot.number,
    });
    await canonicalizeGitHubResourceIdentity(tx, { workspaceId, snapshot });
    const previous = await tx.externalResource.findUnique({
      where: {
        workspaceId_provider_repoFullName_resourceType_number: {
          workspaceId,
          provider: GITHUB_PROVIDER,
          repoFullName: snapshot.repoFullName,
          resourceType: "PULL_REQUEST",
          number: snapshot.number,
        },
      },
    });
    const existingMetadata =
      previous?.metadata &&
      typeof previous.metadata === "object" &&
      !Array.isArray(previous.metadata)
        ? (previous.metadata as Record<string, unknown>)
        : {};
    const existingReview =
      existingMetadata.review &&
      typeof existingMetadata.review === "object" &&
      !Array.isArray(existingMetadata.review)
        ? (existingMetadata.review as Record<string, unknown>)
        : {};
    const existingTimes = [existingReview.updatedAt, existingReview.lastEventAt]
      .filter((value): value is string => typeof value === "string")
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    const existingUpdatedAt = existingTimes.length > 0 ? Math.max(...existingTimes) : NaN;
    const incomingUpdatedAt = submittedAt ? Date.parse(submittedAt) : NaN;
    if (
      decision &&
      Number.isFinite(existingUpdatedAt) &&
      Number.isFinite(incomingUpdatedAt) &&
      existingUpdatedAt > incomingUpdatedAt
    ) {
      return null;
    }
    // One review webhook is never the repository-wide decision: another
    // reviewer may still have changes requested. Preserve the last provider
    // aggregate and make every individual event a refresh hint.
    const persistedDecision =
      typeof existingMetadata.reviewDecision === "string" ? existingMetadata.reviewDecision : null;
    const review = {
      ...existingReview,
      source: "webhook-hint",
      dirty: true,
      lastEventDecision: decision,
      lastEventState: reviewState,
      lastEventAt: submittedAt ?? new Date().toISOString(),
      lastReviewId: args.payload.review?.id ?? null,
      lastReviewer: args.payload.review?.user?.login ?? null,
    };
    let resource;
    if (previous) {
      resource = await tx.externalResource.update({
        where: { id: previous.id },
        data: {
          connectionMappingId: args.mapping.id,
          lastSyncedAt: null,
          metadata: {
            ...existingMetadata,
            reviewDecision: persistedDecision,
            review,
          } as Prisma.InputJsonValue,
        },
      });
    } else {
      snapshot.metadata = {
        ...(snapshot.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : {}),
        reviewDecision: persistedDecision,
        review,
      };
      resource = await upsertExternalResource(tx, {
        workspaceId,
        connectionMappingId: args.mapping.id,
        snapshot,
      });
      if (resource.syncTerminalAt === null) {
        resource = await tx.externalResource.update({
          where: { id: resource.id },
          data: { lastSyncedAt: null },
        });
      }
    }
    const appliedSnapshot = {
      ...snapshot,
      title: resource.title,
      state: resource.state,
      metadata: resource.metadata,
    };
    const changedIssueIds = await applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot: appliedSnapshot,
      actor: args.actor,
      statusRuleId: rule,
    });
    await recordGitHubResourceChangeToLinkedIssues({
      db: tx,
      workspaceId,
      before: previous,
      after: resource,
      actor: args.actor,
      source: "github-webhook",
      skipIssueIds: changedIssueIds,
    });
    return resource;
  });
  if (!persisted) return 0;
  return 1;
}

function checkPullRequestNumbers(payload: GitHubWebhookPayload): number[] {
  const check = payload.check_suite ?? payload.check_run;
  if (!check) return [];

  const out = new Set<number>();
  for (const pr of check.pull_requests ?? []) {
    const number = pr.number ?? null;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      out.add(number);
    }
  }
  return [...out];
}

export function githubCheckWebhookHint(args: {
  event: "check_suite" | "check_run" | "status";
  conclusion: string | null;
  headSha?: string | null;
}) {
  return {
    status: "dirty",
    conclusion: null,
    source: "webhook-hint",
    updatedAt: new Date().toISOString(),
    event: args.event,
    observedConclusion: args.conclusion,
    ...(args.headSha ? { headSha: args.headSha } : {}),
  } as const;
}

async function processCheckEvent(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
}): Promise<number> {
  if (!args.mapping.workspace?.id) return 0;
  const numbers = checkPullRequestNumbers(args.payload);
  const eventHeadSha =
    args.payload.check_suite?.head_sha ?? args.payload.check_run?.head_sha ?? args.payload.sha;
  if (numbers.length === 0 && !eventHeadSha) return 0;

  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  const conclusion =
    args.payload.check_suite?.conclusion ??
    args.payload.check_run?.conclusion ??
    args.payload.state ??
    null;
  const successfulConclusion =
    conclusion !== null && ["success", "neutral", "skipped"].includes(conclusion);
  const checkStatus =
    args.payload.check_suite?.status ??
    args.payload.check_run?.status ??
    (args.payload.state ? (args.payload.state === "pending" ? "pending" : "completed") : null);
  const failedConclusion =
    checkStatus === "completed" && conclusion !== null && !successfulConclusion;
  const statusRuleId = failedConclusion
    ? statusRuleForGitHubEvent(config, "checksFailedStatusId")
    : null;
  const status = statusRuleId
    ? await args.db.status.findFirst({
        where: { id: statusRuleId, workspaceId },
        select: { id: true, category: true },
      })
    : null;

  const candidates = await args.db.externalResource.findMany({
    where: {
      workspaceId,
      provider: GITHUB_PROVIDER,
      repoFullName: { equals: args.mapping.target, mode: "insensitive" },
      resourceType: "PULL_REQUEST",
      ...(numbers.length > 0
        ? { number: { in: numbers } }
        : { metadata: { path: ["head", "sha"], equals: eventHeadSha! } }),
    },
  });
  const resources = candidates;
  if (resources.length === 0) return 0;

  let processed = 0;
  const processedResourceIds: string[] = [];
  await args.db.$transaction(async (tx) => {
    for (const candidate of resources) {
      await acquireGitHubResourceOrderLock(tx, {
        workspaceId,
        repoFullName: candidate.repoFullName,
        resourceType: candidate.resourceType,
        number: candidate.number,
      });
      const resource = await tx.externalResource.findUnique({ where: { id: candidate.id } });
      if (!resource) continue;
      const metadata =
        resource.metadata &&
        typeof resource.metadata === "object" &&
        !Array.isArray(resource.metadata)
          ? (resource.metadata as Record<string, unknown>)
          : {};
      const existingChecks =
        metadata.checks && typeof metadata.checks === "object" && !Array.isArray(metadata.checks)
          ? (metadata.checks as Record<string, unknown>)
          : {};
      const head =
        metadata.head && typeof metadata.head === "object" && !Array.isArray(metadata.head)
          ? (metadata.head as Record<string, unknown>)
          : {};
      if (eventHeadSha && typeof head.sha === "string" && head.sha !== eventHeadSha) {
        continue;
      }
      // A webhook check_suite is only one suite, not repository-wide CI.
      // Persist it as a dirty hint; the worker must fetch every suite plus the
      // combined commit status before completion can trust a conclusion.
      const webhookHint = githubCheckWebhookHint({
        event: args.payload.check_suite
          ? "check_suite"
          : args.payload.check_run
            ? "check_run"
            : "status",
        conclusion,
        headSha: eventHeadSha,
      });
      const after = await tx.externalResource.update({
        where: { id: resource.id },
        data: {
          metadata: {
            ...metadata,
            checks: {
              ...existingChecks,
              ...webhookHint,
              ...(args.payload.check_run ? { lastRunConclusion: conclusion } : {}),
              ...(args.payload.state ? { lastStatusState: args.payload.state } : {}),
            },
          } as Prisma.InputJsonValue,
          lastSyncedAt: null,
          syncTerminalAt: null,
        },
      });
      processed += 1;
      processedResourceIds.push(resource.id);
      const changedIssueIds = new Set<string>();
      if (status) {
        const links = await tx.externalResourceLink.findMany({
          where: { workspaceId, externalResourceId: resource.id },
          select: { issueId: true },
        });
        for (const link of links) {
          const before = await tx.issue.findFirst({
            where: { id: link.issueId, workspaceId, deletedAt: null },
            include: { status: true },
          });
          if (!before || before.statusId === status.id) continue;

          const issueAfter = await tx.issue.update({
            where: { id: before.id },
            data: {
              status: { connect: { id: status.id } },
              ...(status.category === "IN_PROGRESS" && !before.startedAt
                ? { startedAt: new Date() }
                : {}),
              completedAt: status.category === "DONE" ? new Date() : null,
              canceledAt: status.category === "CANCELED" ? new Date() : null,
            },
            include: { status: true },
          });
          await recordChange(tx, {
            workspaceId,
            actorId: args.actor.actorId,
            actorAgentId: args.actor.actorAgentId ?? null,
            entity: "Issue",
            entityId: before.id,
            action: "github-checks-failed",
            before,
            after: issueAfter,
            eventKind: "ISSUE_STATUS_CHANGED",
            subjectType: "issue",
            subjectId: before.id,
            payload: {
              source: "github",
              change: "checks-failed",
              externalResourceId: resource.id,
              repo: args.mapping.target,
              number: resource.number,
              event: args.payload.check_suite
                ? "check_suite"
                : args.payload.check_run
                  ? "check_run"
                  : "status",
              conclusion,
            },
            ip: args.actor.ip ?? null,
            userAgent: args.actor.userAgent ?? null,
          });
          changedIssueIds.add(before.id);
        }
      }
      await recordGitHubResourceChangeToLinkedIssues({
        db: tx,
        workspaceId,
        before: resource,
        after,
        actor: args.actor,
        source: "github-webhook",
        skipIssueIds: changedIssueIds,
      });
    }
  });
  for (const externalResourceId of processedResourceIds) {
    await reconcileGitHubPullRequestCompletion(args.db, {
      workspaceId,
      externalResourceId,
      actorId: args.actor.actorId,
      actorAgentId: args.actor.actorAgentId,
    });
  }
  return processed;
}

async function processIssueComment(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
  deliveryId: string;
}): Promise<number> {
  if (args.payload.action !== "created" || !args.payload.issue || !args.payload.comment) return 0;
  // PR conversation comments and review bodies remain on GitHub. Forge only
  // mirrors issue discussion when syncComments is explicitly enabled; review
  // webhooks update bounded state metadata, never Forge BODY comments.
  if (args.payload.issue.pull_request) return 0;
  if (!args.mapping.workspace?.id) return 0;
  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  if (!config.syncComments) return 0;
  const snapshot = issueSnapshot(args.mapping.target, args.payload.issue);
  // issue.updated_at on an issue_comment payload reflects the comment, not an
  // issue lifecycle transition. Persisting it as the resource version could
  // make a later opened/closed/reopened delivery look stale and suppress its
  // Forge side effects. A comment may seed the native resource identity, but
  // lifecycle webhooks (or provider reconciliation) own its freshness clock.
  snapshot.externalUpdatedAt = null;
  const persisted = await upsertExternalResourceFromWebhook(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
  });
  const resource = persisted.resource;
  const links = await args.db.externalResourceLink.findMany({
    where: { workspaceId, externalResourceId: resource.id, kind: "SOURCE" },
    select: { issueId: true },
  });
  for (const link of links) {
    await args.db.$transaction(async (tx) => {
      await acquireGitHubResourceOrderLock(tx, {
        workspaceId,
        repoFullName: resource.repoFullName,
        resourceType: resource.resourceType,
        number: resource.number,
      });
      const sourceCommentId = args.payload.comment?.id
        ? String(args.payload.comment.id)
        : args.deliveryId;
      const dedupeKey = `${sourceCommentId}:${link.issueId}`;
      const duplicate = await tx.activityEvent.findFirst({
        where: {
          workspaceId,
          kind: "COMMENT_CREATED",
          payload: { path: ["githubCommentDedupeKey"], equals: dedupeKey },
        },
        select: { id: true },
      });
      if (duplicate) return;
      const comment = await tx.comment.create({
        data: {
          workspaceId,
          issueId: link.issueId,
          kind: CommentKind.SYSTEM,
          body: [
            `GitHub comment from @${args.payload.comment?.user?.login ?? "unknown"}`,
            args.payload.comment?.html_url ? args.payload.comment.html_url : null,
            "",
            args.payload.comment?.body ?? "",
          ]
            .filter((v) => v !== null)
            .join("\n"),
        },
      });
      await recordChange(tx, {
        workspaceId,
        actorId: args.actor.actorId,
        actorAgentId: args.actor.actorAgentId ?? null,
        entity: "Comment",
        entityId: comment.id,
        action: "create",
        after: comment,
        eventKind: "COMMENT_CREATED",
        subjectType: "comment",
        subjectId: comment.id,
        payload: {
          issueId: link.issueId,
          source: "github",
          externalResourceId: resource.id,
          commentUrl: args.payload.comment?.html_url ?? null,
          githubCommentId: args.payload.comment?.id ?? null,
          githubDeliveryId: args.deliveryId,
          githubCommentDedupeKey: dedupeKey,
        },
        ip: args.actor.ip ?? null,
        userAgent: args.actor.userAgent ?? null,
      });
    });
  }
  return links.length;
}

export async function processGitHubWebhook(args: {
  db: PrismaClient;
  deliveryId: string;
  event: string;
  payload: GitHubWebhookPayload;
  actor?: ActorMeta;
}): Promise<GitHubWebhookResult> {
  const repoFullName = repoFromPayload(args.payload);
  const action = args.payload.action ?? null;
  const actor = args.actor ?? { actorId: null };

  const claim = await claimGitHubWebhookDelivery({
    db: args.db,
    deliveryId: args.deliveryId,
    event: args.event,
    action,
    repoFullName,
  });
  if (claim === "DUPLICATE") {
    return { ok: true, duplicate: true, processed: 0 };
  }

  if (!repoFullName) {
    await args.db.externalWebhookEvent.update({
      where: { provider_deliveryId: { provider: GITHUB_PROVIDER, deliveryId: args.deliveryId } },
      data: { status: "SKIPPED", error: "Missing repository.full_name.", processedAt: new Date() },
    });
    return { ok: true, processed: 0, skipped: "missing-repository" };
  }

  const mappings = await activeMappingsForPayload({
    db: args.db,
    repoFullName,
    installationId: args.payload.installation?.id ?? null,
  });
  if (mappings.length === 0) {
    await args.db.externalWebhookEvent.update({
      where: { provider_deliveryId: { provider: GITHUB_PROVIDER, deliveryId: args.deliveryId } },
      data: {
        status: "SKIPPED",
        error: "No active Forge mapping matched.",
        processedAt: new Date(),
      },
    });
    return { ok: true, processed: 0, skipped: "no-mapping" };
  }
  const mappedWorkspaceIds = [...new Set(mappings.map((mapping) => mapping.workspaceId))];
  // A delivery can fan into several tenants. Keep the provider-global dedupe
  // row unowned in that case so deleting one workspace cannot erase replay
  // protection for the others.
  const eventWorkspaceId = mappedWorkspaceIds.length === 1 ? mappedWorkspaceIds[0] : null;

  let processed = 0;
  try {
    for (const mapping of mappings) {
      if (args.event === "issues") {
        processed += await processIssueEvent({
          db: args.db,
          mapping,
          payload: args.payload,
          actor,
        });
      } else if (args.event === "issue_comment") {
        processed += await processIssueComment({
          db: args.db,
          mapping,
          payload: args.payload,
          actor,
          deliveryId: args.deliveryId,
        });
      } else if (args.event === "pull_request") {
        processed += await processPullRequestEvent({
          db: args.db,
          mapping,
          payload: args.payload,
          actor,
        });
      } else if (args.event === "pull_request_review") {
        processed += await processReviewEvent({
          db: args.db,
          mapping,
          payload: args.payload,
          actor,
        });
      } else if (
        args.event === "check_suite" ||
        args.event === "check_run" ||
        args.event === "status"
      ) {
        processed += await processCheckEvent({
          db: args.db,
          mapping,
          payload: args.payload,
          actor,
        });
      }
    }
    await args.db.externalWebhookEvent.update({
      where: { provider_deliveryId: { provider: GITHUB_PROVIDER, deliveryId: args.deliveryId } },
      data: {
        workspaceId: eventWorkspaceId,
        status: processed > 0 ? "PROCESSED" : "SKIPPED",
        processedAt: new Date(),
      },
    });
    return { ok: true, processed };
  } catch (err) {
    await args.db.externalWebhookEvent.update({
      where: { provider_deliveryId: { provider: GITHUB_PROVIDER, deliveryId: args.deliveryId } },
      data: {
        workspaceId: eventWorkspaceId,
        status: "FAILED",
        error: err instanceof Error ? err.message.slice(0, 2000) : "Unknown error.",
        processedAt: new Date(),
      },
    });
    throw err;
  }
}

export async function handleGitHubWebhookRequest(args: {
  db: PrismaClient;
  rawBody: string;
  signature: string | null;
  deliveryId: string | null;
  event: string | null;
}): Promise<GitHubWebhookResult> {
  if (
    !verifyGitHubWebhookSignature({
      secret: webhookSecret(),
      rawBody: args.rawBody,
      signature: args.signature,
    })
  ) {
    throw new Error("Bad GitHub webhook signature.");
  }
  if (!args.deliveryId) throw new Error("Missing X-GitHub-Delivery header.");
  if (!args.event) throw new Error("Missing X-GitHub-Event header.");

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(args.rawBody) as GitHubWebhookPayload;
  } catch {
    throw new Error("GitHub webhook body is not valid JSON.");
  }
  return processGitHubWebhook({
    db: args.db,
    deliveryId: args.deliveryId,
    event: args.event,
    payload,
    actor: { actorId: null },
  });
}
