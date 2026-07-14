import "server-only";
import { createGitHubAppJwt } from "@/server/services/github/app-auth";
import { resolveInstallationToken } from "@/server/services/github/installation-token";
import type { GitHubResourceSnapshot } from "@/server/services/github/types";

const GITHUB_API_BASE = "https://api.github.com";

type GitHubUser = { login?: string | null };
type GitHubLabel = { name?: string | null; color?: string | null };

export type GitHubIssueResponse = {
  id: number;
  node_id?: string | null;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  url: string;
  user?: GitHubUser | null;
  labels?: GitHubLabel[];
  assignees?: GitHubUser[];
  pull_request?: { url?: string; html_url?: string } | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  milestone?: { title?: string | null; number?: number | null } | null;
};

export type GitHubPullResponse = {
  id: number;
  node_id?: string | null;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  url: string;
  user?: GitHubUser | null;
  labels?: GitHubLabel[];
  assignees?: GitHubUser[];
  draft?: boolean;
  merged?: boolean;
  mergeable_state?: string | null;
  head?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null };
  base?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null };
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  merged_at?: string | null;
};

export type GitHubRepoResponse = {
  id: number;
  node_id?: string | null;
  full_name: string;
  html_url: string;
  private?: boolean;
};

type GitHubListReposResponse = {
  repositories?: GitHubRepoResponse[];
};

type GitHubCheckSuite = {
  status?: string | null;
  conclusion?: string | null;
};

type GitHubCheckSuitesResponse = {
  total_count?: number;
  check_suites?: GitHubCheckSuite[];
};

type GitHubCombinedStatusResponse = {
  state?: "error" | "failure" | "pending" | "success";
  total_count?: number;
};

export type GitHubChecksSnapshot = {
  status: "completed" | "pending" | "unknown";
  conclusion: string | null;
  suiteCount: number;
  statusCount: number;
  updatedAt: string;
  source: "reconciliation";
  partial: boolean;
  diagnostic: string | null;
  retryAt: string | null;
  headSha: string;
};

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt: Date | null,
    readonly rateLimited: boolean = status === 429,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

export type GitHubInstallationResponse = {
  id: number;
  account?: { login?: string | null; type?: string | null } | null;
  repository_selection?: string | null;
  permissions?: Record<string, string>;
  events?: string[];
};

async function githubAppRequest<T>(path: string): Promise<T> {
  const jwt = await createGitHubAppJwt();
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "forge-github-app",
      "x-github-api-version": "2022-11-28",
    },
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) {
    throw new Error(json.message || `GitHub API returned HTTP ${res.status}.`);
  }
  return json as T;
}

async function githubRequest<T>(
  installationId: string | number,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  // Prefer a configured GithubApp's credentials for this installation, falling
  // back to the global env app — so linking works off the same app a workspace
  // set up in Settings → GitHub Apps.
  const token = await resolveInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "forge-github-app",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text };
    }
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "message" in json && typeof json.message === "string"
        ? json.message
        : `GitHub API returned HTTP ${res.status}.`;
    const retryAfter = Number(res.headers.get("retry-after"));
    const rateLimitReset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAt =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? new Date(Date.now() + retryAfter * 1000)
        : Number.isFinite(rateLimitReset) && rateLimitReset > 0
          ? new Date(rateLimitReset * 1000)
          : null;
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"));
    throw new GitHubRequestError(message, res.status, retryAt, rateLimited);
  }
  return json as T;
}

function dateOrNull(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function labels(labels: GitHubLabel[] | undefined): Array<{ name: string; color: string | null }> {
  return (labels ?? [])
    .map((l) => ({ name: l.name ?? "", color: l.color ?? null }))
    .filter((l) => l.name.length > 0);
}

function assignees(users: GitHubUser[] | undefined): Array<{ login: string }> {
  return (users ?? []).map((u) => ({ login: u.login ?? "" })).filter((u) => u.login.length > 0);
}

export async function getGitHubIssue(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubIssueResponse> {
  return githubRequest<GitHubIssueResponse>(
    args.installationId,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.number}`,
  );
}

export async function getGitHubPullRequest(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullResponse> {
  return githubRequest<GitHubPullResponse>(
    args.installationId,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}`,
  );
}

/**
 * Read both GitHub Checks and legacy commit statuses for a PR head. A passing
 * result is only returned when every discovered signal is complete and green;
 * zero discovered signals stays unknown and cannot certify completion.
 */
export async function getGitHubPullRequestChecks(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  headSha: string;
}): Promise<GitHubChecksSnapshot> {
  const ref = encodeURIComponent(args.headSha);
  const [suiteResult, statusResult] = await Promise.allSettled([
    githubRequest<GitHubCheckSuitesResponse>(
      args.installationId,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits/${ref}/check-suites?filter=latest&per_page=100`,
    ),
    githubRequest<GitHubCombinedStatusResponse>(
      args.installationId,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits/${ref}/status`,
    ),
  ]);
  const suites = suiteResult.status === "fulfilled" ? suiteResult.value : {};
  const statuses = statusResult.status === "fulfilled" ? statusResult.value : {};
  const rows = suites.check_suites ?? [];
  const suiteCount = suites.total_count ?? rows.length;
  const statusCount = statuses.total_count ?? 0;
  const discovered = suiteCount + statusCount;
  const pending =
    rows.some((suite) => suite.status !== "completed") || statuses.state === "pending";
  const failedSuite = rows.find(
    (suite) =>
      suite.status === "completed" &&
      !!suite.conclusion &&
      !["success", "neutral", "skipped"].includes(suite.conclusion),
  );
  const failedStatus = statuses.state === "failure" || statuses.state === "error";
  const conclusion =
    failedSuite?.conclusion ?? (failedStatus ? (statuses.state ?? "failure") : null);
  const failures = [suiteResult, statusResult].filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const incompleteSuites = suiteCount > rows.length;
  const partial = failures.length > 0 || incompleteSuites;
  const retryAt =
    failures
      .map((failure) =>
        failure.reason instanceof GitHubRequestError ? failure.reason.retryAt : null,
      )
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return {
    status:
      conclusion !== null
        ? "completed"
        : partial || discovered === 0
          ? "unknown"
          : pending
            ? "pending"
            : "completed",
    conclusion: conclusion ?? (!partial && discovered > 0 && !pending ? "success" : null),
    suiteCount,
    statusCount,
    updatedAt: new Date().toISOString(),
    source: "reconciliation",
    partial,
    diagnostic: partial
      ? [
          ...failures.map((failure) =>
            failure.reason instanceof Error ? failure.reason.message : "GitHub checks unavailable",
          ),
          ...(incompleteSuites ? ["More than 100 check suites require another page."] : []),
        ]
          .join("; ")
          .slice(0, 2_000)
      : null,
    retryAt: retryAt?.toISOString() ?? null,
    headSha: args.headSha,
  };
}

export async function listGitHubInstallationRepos(args: {
  installationId: string | number;
}): Promise<GitHubRepoResponse[]> {
  const first = await githubRequest<GitHubListReposResponse>(
    args.installationId,
    "/installation/repositories?per_page=100",
  );
  return first.repositories ?? [];
}

export async function getGitHubAppInstallation(args: {
  installationId: string | number;
}): Promise<GitHubInstallationResponse> {
  return githubAppRequest<GitHubInstallationResponse>(`/app/installations/${args.installationId}`);
}

export async function searchGitHubIssuesAndPulls(args: {
  installationId: string | number;
  repoFullName: string;
  query: string;
  type?: "issue" | "pr";
}): Promise<GitHubIssueResponse[]> {
  const typePart = args.type === "pr" ? "type:pr" : args.type === "issue" ? "type:issue" : "";
  const q = [`repo:${args.repoFullName}`, typePart, args.query].filter(Boolean).join(" ");
  const params = new URLSearchParams({ q, per_page: "20" });
  const result = await githubRequest<{ items?: GitHubIssueResponse[] }>(
    args.installationId,
    `/search/issues?${params.toString()}`,
  );
  return result.items ?? [];
}

export function issueSnapshot(
  repoFullName: string,
  issue: GitHubIssueResponse,
): GitHubResourceSnapshot {
  return {
    provider: "GITHUB",
    resourceType: "ISSUE",
    repoFullName,
    externalId: String(issue.id),
    externalNodeId: issue.node_id ?? null,
    number: issue.number,
    url: issue.html_url,
    apiUrl: issue.url,
    title: issue.title,
    state: issue.state,
    authorLogin: issue.user?.login ?? null,
    labels: labels(issue.labels),
    assignees: assignees(issue.assignees),
    metadata: {
      body: issue.body ?? null,
      closedAt: issue.closed_at ?? null,
      milestone: issue.milestone
        ? { title: issue.milestone.title ?? null, number: issue.milestone.number ?? null }
        : null,
    },
    externalCreatedAt: dateOrNull(issue.created_at),
    externalUpdatedAt: dateOrNull(issue.updated_at),
  };
}

export function pullRequestSnapshot(
  repoFullName: string,
  pr: GitHubPullResponse,
): GitHubResourceSnapshot {
  const state = pr.merged ? "merged" : pr.draft ? "draft" : pr.state;
  return {
    provider: "GITHUB",
    resourceType: "PULL_REQUEST",
    repoFullName,
    externalId: String(pr.id),
    externalNodeId: pr.node_id ?? null,
    number: pr.number,
    url: pr.html_url,
    apiUrl: pr.url,
    title: pr.title,
    state,
    authorLogin: pr.user?.login ?? null,
    labels: labels(pr.labels),
    assignees: assignees(pr.assignees),
    metadata: {
      body: pr.body ?? null,
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      mergedAt: pr.merged_at ?? null,
      closedAt: pr.closed_at ?? null,
      mergeableState: pr.mergeable_state ?? null,
      head: {
        ref: pr.head?.ref ?? null,
        sha: pr.head?.sha ?? null,
        repo: pr.head?.repo?.full_name ?? null,
      },
      base: {
        ref: pr.base?.ref ?? null,
        sha: pr.base?.sha ?? null,
        repo: pr.base?.repo?.full_name ?? null,
      },
    },
    externalCreatedAt: dateOrNull(pr.created_at),
    externalUpdatedAt: dateOrNull(pr.updated_at),
  };
}
