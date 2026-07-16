import "server-only";

export const GITHUB_PROVIDER = "GITHUB" as const;

export const GITHUB_RESOURCE_TYPES = ["ISSUE", "PULL_REQUEST"] as const;
export type GitHubResourceType = (typeof GITHUB_RESOURCE_TYPES)[number];

export const EXTERNAL_LINK_KINDS = [
  "SOURCE",
  "IMPLEMENTS",
  "FIXES",
  "RELEASES",
  "REVIEWS",
  "RELATES_TO",
] as const;
export type ExternalLinkKind = (typeof EXTERNAL_LINK_KINDS)[number];

export const IMPLEMENTATION_LINK_KINDS = [
  "IMPLEMENTS",
  "FIXES",
] as const satisfies readonly ExternalLinkKind[];

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  repoFullName: string;
};

export type ParsedGitHubUrl = GitHubRepoRef & {
  type: GitHubResourceType;
  number: number;
  url: string;
};

export type GitHubResourceSnapshot = {
  provider: typeof GITHUB_PROVIDER;
  resourceType: GitHubResourceType;
  repoFullName: string;
  externalId?: string | null;
  externalNodeId?: string | null;
  number: number;
  url: string;
  apiUrl?: string | null;
  title: string;
  state: string;
  authorLogin?: string | null;
  labels?: unknown;
  assignees?: unknown;
  metadata?: unknown;
  externalCreatedAt?: Date | null;
  externalUpdatedAt?: Date | null;
};
