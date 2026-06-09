import "server-only";
import { Priority, type Connection, type ConnectionMapping } from "@prisma/client";
import { z } from "zod";
import type { CreateIssueWithSideEffectsInput } from "@/server/services/issue-create";
import type { GitHubResourceSnapshot } from "@/server/services/github/types";

const statusRulesSchema = z
  .object({
    issueClosedStatusId: z.string().nullable().optional(),
    issueReopenedStatusId: z.string().nullable().optional(),
    prOpenedStatusId: z.string().nullable().optional(),
    prReadyForReviewStatusId: z.string().nullable().optional(),
    prChangesRequestedStatusId: z.string().nullable().optional(),
    prMergedStatusId: z.string().nullable().optional(),
    checksFailedStatusId: z.string().nullable().optional(),
  })
  .default({});

const githubMappingConfigSchema = z
  .object({
    github: z
      .object({
        autoCreateIssues: z.boolean().default(false),
        syncTitle: z.boolean().default(true),
        syncDescription: z.boolean().default(false),
        syncComments: z.boolean().default(false),
        defaultProjectId: z.string().nullable().optional(),
        defaultLabelIds: z.array(z.string()).default([]),
        labelMap: z.record(z.string()).default({}),
        defaultPriority: z.nativeEnum(Priority).default(Priority.NONE),
        queueOnCreate: z.boolean().default(false),
        assignedAgentId: z.string().nullable().optional(),
        claimedById: z.string().nullable().optional(),
        statusRules: statusRulesSchema,
      })
      .default({}),
  })
  .default({});

const githubConnectionConfigSchema = z.object({
  authKind: z.literal("github_app_installation").optional(),
  installationId: z.union([z.string(), z.number()]).optional(),
  accountLogin: z.string().optional(),
  accountType: z.string().optional(),
  repositorySelection: z.string().optional(),
  permissions: z.record(z.unknown()).optional(),
  events: z.array(z.string()).optional(),
});

export type GitHubMappingConfig = z.infer<typeof githubMappingConfigSchema>["github"];
export type GitHubConnectionConfig = z.infer<typeof githubConnectionConfigSchema>;

export function readGitHubMappingConfig(config: unknown): GitHubMappingConfig {
  return githubMappingConfigSchema.parse(config ?? {}).github;
}

export function readGitHubConnectionConfig(config: unknown): GitHubConnectionConfig {
  return githubConnectionConfigSchema.parse(config ?? {});
}

export function githubInstallationId(connection: Pick<Connection, "config">): string {
  const cfg = readGitHubConnectionConfig(connection.config);
  if (!cfg.installationId) {
    throw new Error("GitHub connection is missing installationId.");
  }
  return String(cfg.installationId);
}

function githubBody(snapshot: GitHubResourceSnapshot): string | null {
  const meta = snapshot.metadata;
  if (!meta || typeof meta !== "object" || !("body" in meta)) return null;
  const body = (meta as { body?: unknown }).body;
  return typeof body === "string" && body.trim() ? body : null;
}

function githubLabelNames(snapshot: GitHubResourceSnapshot): string[] {
  if (!Array.isArray(snapshot.labels)) return [];
  return snapshot.labels
    .map((label) => {
      if (!label || typeof label !== "object" || !("name" in label)) return "";
      const name = (label as { name?: unknown }).name;
      return typeof name === "string" ? name : "";
    })
    .filter(Boolean);
}

function mappedLabelIds(
  mapping: Pick<ConnectionMapping, "labelIds">,
  config: GitHubMappingConfig,
  snapshot: GitHubResourceSnapshot,
  explicitLabelIds?: string[],
): string[] {
  const ids = new Set<string>([
    ...mapping.labelIds,
    ...config.defaultLabelIds,
    ...(explicitLabelIds ?? []),
  ]);
  for (const name of githubLabelNames(snapshot)) {
    const mapped = config.labelMap[name] ?? config.labelMap[name.toLowerCase()];
    if (mapped) ids.add(mapped);
  }
  return [...ids];
}

export function issueCreateInputFromGitHub(args: {
  mapping: Pick<ConnectionMapping, "labelIds" | "config">;
  snapshot: GitHubResourceSnapshot;
  projectId?: string | null;
  labelIds?: string[];
  queue?: boolean;
}): CreateIssueWithSideEffectsInput {
  const config = readGitHubMappingConfig(args.mapping.config);
  const body = githubBody(args.snapshot);
  const description = [
    `GitHub ${args.snapshot.resourceType === "PULL_REQUEST" ? "pull request" : "issue"}: ${args.snapshot.url}`,
    `Repository: ${args.snapshot.repoFullName}`,
    args.snapshot.authorLogin ? `Author: @${args.snapshot.authorLogin}` : null,
    body ? `\n${body}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    title: args.snapshot.title,
    description,
    projectId: args.projectId ?? config.defaultProjectId ?? undefined,
    priority: config.defaultPriority,
    labelIds: mappedLabelIds(args.mapping, config, args.snapshot, args.labelIds),
    queued: args.queue ?? config.queueOnCreate,
    assignedAgentId: config.assignedAgentId ?? undefined,
    claimedById: config.claimedById ?? undefined,
    eventPayload: {
      source: "github",
      repo: args.snapshot.repoFullName,
      number: args.snapshot.number,
      resourceType: args.snapshot.resourceType,
    },
  };
}

export function statusRuleForGitHubEvent(
  config: GitHubMappingConfig,
  rule: keyof GitHubMappingConfig["statusRules"],
): string | null {
  return config.statusRules?.[rule] ?? null;
}
