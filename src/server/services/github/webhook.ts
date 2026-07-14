import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CommentKind, Prisma, type PrismaClient } from "@prisma/client";
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
  linkExternalResourceToIssue,
  upsertExternalResource,
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
  installation?: GitHubWebhookInstallation;
  repository?: GitHubWebhookRepository;
  issue?: GitHubIssueResponse;
  pull_request?: GitHubPullResponse;
  review?: { state?: string | null };
  check_suite?: {
    conclusion?: string | null;
    status?: string | null;
    pull_requests?: Array<{ number?: number | null; url?: string | null }>;
  };
  check_run?: {
    conclusion?: string | null;
    status?: string | null;
    pull_requests?: Array<{ number?: number | null; url?: string | null }>;
  };
  comment?: {
    html_url?: string | null;
    body?: string | null;
    user?: { login?: string | null } | null;
  };
};

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
    if (!cfg || typeof cfg !== "object" || !("installationId" in cfg)) return true;
    return (
      String((cfg as { installationId?: unknown }).installationId) === String(args.installationId)
    );
  });
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
  actor: ActorMeta;
}) {
  const resource = await upsertExternalResource(args.db, {
    workspaceId: args.workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot: args.snapshot,
  });
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
  let resource = await upsertExternalResource(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
  });

  if (args.payload.action === "opened" && config.autoCreateIssues) {
    const created = await ensureSourceIssueForSnapshot({
      db: args.db,
      workspaceId,
      mapping: args.mapping,
      snapshot,
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

  await args.db.$transaction((tx) =>
    applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot,
      actor: args.actor,
      statusRuleId: rule,
    }),
  );
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
  const resource = await upsertExternalResource(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
  });

  const keyNumbers = [
    ...forgeIssueKeys(args.payload.pull_request.title, args.mapping.workspace.key),
    ...forgeIssueKeys(args.payload.pull_request.body, args.mapping.workspace.key),
  ];
  if (keyNumbers.length > 0) {
    const issues = await args.db.issue.findMany({
      where: { workspaceId, number: { in: keyNumbers }, deletedAt: null },
      select: { id: true },
    });
    await args.db.$transaction(async (tx) => {
      for (const issue of issues) {
        await linkExternalResourceToIssue(tx, {
          workspaceId,
          issueId: issue.id,
          externalResourceId: resource.id,
          kind: "IMPLEMENTS",
          actor: args.actor,
        });
      }
    });
  }

  const rule =
    args.payload.action === "opened"
      ? statusRuleForGitHubEvent(config, "prOpenedStatusId")
      : args.payload.action === "ready_for_review"
        ? statusRuleForGitHubEvent(config, "prReadyForReviewStatusId")
        : args.payload.action === "closed" && args.payload.pull_request.merged
          ? statusRuleForGitHubEvent(config, "prMergedStatusId")
          : null;

  await args.db.$transaction((tx) =>
    applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot,
      actor: args.actor,
      statusRuleId: rule,
    }),
  );
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
  const config = readGitHubMappingConfig(args.mapping.config);
  const snapshot = pullRequestSnapshot(args.mapping.target, args.payload.pull_request);
  snapshot.metadata = {
    ...(snapshot.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : {}),
    reviewDecision: args.payload.review?.state?.toUpperCase() ?? null,
  };
  const resource = await upsertExternalResource(args.db, {
    workspaceId: args.mapping.workspace.id,
    connectionMappingId: args.mapping.id,
    snapshot,
  });
  const rule =
    args.payload.review?.state === "changes_requested"
      ? statusRuleForGitHubEvent(config, "prChangesRequestedStatusId")
      : null;
  await args.db.$transaction((tx) =>
    applyGitHubSnapshotToLinkedIssues({
      tx,
      workspaceId: args.mapping.workspace.id,
      resourceId: resource.id,
      mapping: args.mapping,
      snapshot,
      actor: args.actor,
      statusRuleId: rule,
    }),
  );
  return 1;
}

function completedCheckPullRequestNumbers(payload: GitHubWebhookPayload): number[] {
  const check = payload.check_suite ?? payload.check_run;
  if (!check || check.status !== "completed") return [];

  const out = new Set<number>();
  for (const pr of check.pull_requests ?? []) {
    const number = pr.number ?? null;
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      out.add(number);
    }
  }
  return [...out];
}

export function aggregateGitHubCheckConclusion(args: {
  event: "check_suite" | "check_run";
  conclusion: string | null;
  existingConclusion: unknown;
}): string | null {
  const successful =
    args.conclusion !== null && ["success", "neutral", "skipped"].includes(args.conclusion);
  if (args.event === "check_suite" || !successful) return args.conclusion;
  return typeof args.existingConclusion === "string" ? args.existingConclusion : null;
}

async function processCheckEvent(args: {
  db: PrismaClient;
  mapping: Awaited<ReturnType<typeof activeMappingsForPayload>>[number];
  payload: GitHubWebhookPayload;
  actor: ActorMeta;
}): Promise<number> {
  if (!args.mapping.workspace?.id) return 0;
  const numbers = completedCheckPullRequestNumbers(args.payload);
  if (numbers.length === 0) return 0;

  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  const conclusion =
    args.payload.check_suite?.conclusion ?? args.payload.check_run?.conclusion ?? null;
  const successfulConclusion =
    conclusion !== null && ["success", "neutral", "skipped"].includes(conclusion);
  const failedConclusion = conclusion !== null && !successfulConclusion;
  const statusRuleId = failedConclusion
    ? statusRuleForGitHubEvent(config, "checksFailedStatusId")
    : null;
  const status = statusRuleId
    ? await args.db.status.findFirst({
        where: { id: statusRuleId, workspaceId },
        select: { id: true, category: true },
      })
    : null;

  const resources = await args.db.externalResource.findMany({
    where: {
      workspaceId,
      provider: GITHUB_PROVIDER,
      repoFullName: args.mapping.target,
      resourceType: "PULL_REQUEST",
      number: { in: numbers },
    },
    select: { id: true, number: true, metadata: true },
  });
  if (resources.length === 0) return 0;

  let processed = 0;
  await args.db.$transaction(async (tx) => {
    for (const resource of resources) {
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
      // A check_suite conclusion is aggregate. A successful check_run only
      // proves one job passed, so it must not certify the whole PR; failures
      // remain safe to persist immediately.
      const aggregateConclusion = aggregateGitHubCheckConclusion({
        event: args.payload.check_suite ? "check_suite" : "check_run",
        conclusion,
        existingConclusion: existingChecks.conclusion,
      });
      await tx.externalResource.update({
        where: { id: resource.id },
        data: {
          metadata: {
            ...metadata,
            checks: {
              ...existingChecks,
              status: "completed",
              conclusion: aggregateConclusion,
              updatedAt: new Date().toISOString(),
              event: args.payload.check_suite ? "check_suite" : "check_run",
              ...(args.payload.check_run ? { lastRunConclusion: conclusion } : {}),
            },
          } as Prisma.InputJsonValue,
        },
      });
      processed += 1;
      if (!status) continue;
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

        const after = await tx.issue.update({
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
          after,
          eventKind: "ISSUE_STATUS_CHANGED",
          subjectType: "issue",
          subjectId: before.id,
          payload: {
            source: "github",
            change: "checks-failed",
            externalResourceId: resource.id,
            repo: args.mapping.target,
            number: resource.number,
            event: args.payload.check_suite ? "check_suite" : "check_run",
            conclusion,
          },
          ip: args.actor.ip ?? null,
          userAgent: args.actor.userAgent ?? null,
        });
      }
    }
  });
  for (const resource of resources) {
    await reconcileGitHubPullRequestCompletion(args.db, {
      workspaceId,
      externalResourceId: resource.id,
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
}): Promise<number> {
  if (args.payload.action !== "created" || !args.payload.issue || !args.payload.comment) return 0;
  if (!args.mapping.workspace?.id) return 0;
  const workspaceId = args.mapping.workspace.id;
  const config = readGitHubMappingConfig(args.mapping.config);
  if (!config.syncComments) return 0;
  const snapshot = issueSnapshot(args.mapping.target, args.payload.issue);
  const resource = await upsertExternalResource(args.db, {
    workspaceId,
    connectionMappingId: args.mapping.id,
    snapshot,
  });
  const links = await args.db.externalResourceLink.findMany({
    where: { workspaceId, externalResourceId: resource.id, kind: "SOURCE" },
    select: { issueId: true },
  });
  for (const link of links) {
    await args.db.$transaction(async (tx) => {
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

  try {
    await args.db.externalWebhookEvent.create({
      data: {
        provider: GITHUB_PROVIDER,
        deliveryId: args.deliveryId,
        event: args.event,
        action,
        repoFullName,
        status: "RECEIVED",
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: true, duplicate: true, processed: 0 };
    }
    throw err;
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
      } else if (args.event === "check_suite" || args.event === "check_run") {
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
        workspaceId: mappings[0]?.workspaceId ?? null,
        status: processed > 0 ? "PROCESSED" : "SKIPPED",
        processedAt: new Date(),
      },
    });
    return { ok: true, processed };
  } catch (err) {
    await args.db.externalWebhookEvent.update({
      where: { provider_deliveryId: { provider: GITHUB_PROVIDER, deliveryId: args.deliveryId } },
      data: {
        workspaceId: mappings[0]?.workspaceId ?? null,
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
