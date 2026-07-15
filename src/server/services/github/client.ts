import "server-only";
import { createGitHubAppJwt } from "@/server/services/github/app-auth";
import { resolveInstallationToken } from "@/server/services/github/installation-token";
import type { GitHubResourceSnapshot } from "@/server/services/github/types";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CHECK_SUITE_PAGES = 10;
const MAX_REVIEW_PAGES = 10;

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
  requested_reviewers?: GitHubUser[];
  requested_teams?: Array<{ slug?: string | null }>;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  merged_at?: string | null;
};

type GitHubPullReviewResponse = {
  id: number;
  state?: string | null;
  submitted_at?: string | null;
  user?: GitHubUser | null;
};

export type GitHubReviewSummary = {
  decision: "CHANGES_REQUESTED" | "APPROVED" | "REVIEW_REQUESTED" | null;
  approvedCount: number;
  changesRequestedCount: number;
  requestedCount: number;
  reviewCount: number;
  updatedAt: string;
  source: "api-aggregate";
  partial: boolean;
  diagnostic: string | null;
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
  source: "api-aggregate";
  partial: boolean;
  rateLimited: boolean;
  timedOut: boolean;
  permissionDenied: boolean;
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
    readonly timedOut: boolean = status === 408,
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

function requestSignal(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function timeoutError(timeoutMs: number): GitHubRequestError {
  return new GitHubRequestError(
    `GitHub API request timed out after ${timeoutMs}ms.`,
    408,
    null,
    false,
    true,
  );
}

async function githubAppRequest<T>(
  path: string,
  timeoutMs = DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const jwt = await createGitHubAppJwt();
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      signal: requestSignal(null, timeoutMs),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "forge-github-app",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw timeoutError(timeoutMs);
    }
    throw error;
  }
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
  timeoutMs = DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
): Promise<T> {
  // Prefer a configured GithubApp's credentials for this installation, falling
  // back to the global env app — so linking works off the same app a workspace
  // set up in Settings → GitHub Apps.
  const token = await resolveInstallationToken(installationId);
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      signal: requestSignal(init.signal, timeoutMs),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "forge-github-app",
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw timeoutError(timeoutMs);
    }
    throw error;
  }
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
    throw new GitHubRequestError(message, res.status, retryAt, rateLimited, false);
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
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubIssueResponse> {
  return githubRequest<GitHubIssueResponse>(
    args.installationId,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.number}`,
    { signal: args.signal },
    args.requestTimeoutMs,
  );
}

export async function getGitHubPullRequest(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  number: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubPullResponse> {
  return githubRequest<GitHubPullResponse>(
    args.installationId,
    `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}`,
    { signal: args.signal },
    args.requestTimeoutMs,
  );
}

/**
 * Aggregate the latest decisive review from each reviewer. GitHub's pull REST
 * payload does not expose a review decision, and a single review webhook is
 * not an aggregate: a later approval from the same reviewer supersedes their
 * earlier changes request, while COMMENTED reviews do not erase approvals.
 */
export async function getGitHubPullRequestReviewSummary(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  number: number;
  requestedReviewers?: number;
  requestedTeams?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubReviewSummary> {
  const reviews: GitHubPullReviewResponse[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const rows = await githubRequest<GitHubPullReviewResponse[]>(
      args.installationId,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.number}/reviews?per_page=100&page=${page}`,
      { signal: args.signal },
      args.requestTimeoutMs,
    );
    reviews.push(...rows);
    if (rows.length < 100) break;
    if (page === MAX_REVIEW_PAGES) truncated = true;
  }

  const ordered = [...reviews].sort((a, b) => {
    const at = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const bt = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return at === bt ? a.id - b.id : at - bt;
  });
  const latest = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of ordered) {
    const login = review.user?.login?.toLowerCase();
    if (!login) continue;
    const state = review.state?.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
      latest.set(login, state);
    } else if (state === "DISMISSED") {
      latest.delete(login);
    }
  }
  const approvedCount = [...latest.values()].filter((state) => state === "APPROVED").length;
  const changesRequestedCount = [...latest.values()].filter(
    (state) => state === "CHANGES_REQUESTED",
  ).length;
  const requestedCount = (args.requestedReviewers ?? 0) + (args.requestedTeams ?? 0);
  return {
    decision:
      changesRequestedCount > 0
        ? "CHANGES_REQUESTED"
        : approvedCount > 0
          ? "APPROVED"
          : requestedCount > 0
            ? "REVIEW_REQUESTED"
            : null,
    approvedCount,
    changesRequestedCount,
    requestedCount,
    reviewCount: reviews.length,
    updatedAt: new Date().toISOString(),
    source: "api-aggregate",
    partial: truncated,
    diagnostic: truncated
      ? `More than ${MAX_REVIEW_PAGES * 100} pull-request reviews require another page.`
      : null,
  };
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
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubChecksSnapshot> {
  const ref = encodeURIComponent(args.headSha);
  const suiteResult = await settle(() => listAllCheckSuites({ ...args, ref }));
  // Deliberately serial: GitHub recommends avoiding concurrent REST requests
  // to reduce secondary-rate-limit pressure.
  const statusResult = await settle(() =>
    githubRequest<GitHubCombinedStatusResponse>(
      args.installationId,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits/${ref}/status`,
      { signal: args.signal },
      args.requestTimeoutMs,
    ),
  );
  const suites: GitHubCheckSuitesResponse & { truncated?: boolean } =
    suiteResult.status === "fulfilled" ? suiteResult.value : {};
  const statuses: GitHubCombinedStatusResponse =
    statusResult.status === "fulfilled" ? statusResult.value : {};
  const rows = suites.check_suites ?? [];
  const suiteCount = suites.total_count ?? rows.length;
  const statusCount = statuses.total_count ?? 0;
  const discovered = suiteCount + statusCount;
  const pending = rows.some((suite) => suite.status !== "completed");
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
    (result): result is { status: "rejected"; reason: unknown } => result.status === "rejected",
  );
  const incompleteSuites = suiteResult.status === "fulfilled" && suiteResult.value.truncated;
  const partial = failures.length > 0 || incompleteSuites;
  const rateLimited = failures.some(
    (failure) => failure.reason instanceof GitHubRequestError && failure.reason.rateLimited,
  );
  const timedOut = failures.some(
    (failure) => failure.reason instanceof GitHubRequestError && failure.reason.timedOut,
  );
  const permissionDenied = failures.some(
    (failure) =>
      failure.reason instanceof GitHubRequestError &&
      !failure.reason.rateLimited &&
      [401, 403].includes(failure.reason.status),
  );
  const retryAt =
    failures
      .map((failure) =>
        failure.reason instanceof GitHubRequestError ? failure.reason.retryAt : null,
      )
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const nullConclusion = rows.some(
    (suite) => suite.status === "completed" && suite.conclusion == null,
  );
  const statusPending = statusCount > 0 && statuses.state === "pending";
  const statusUnknown = statusCount > 0 && statuses.state == null;
  const unresolved = pending || nullConclusion || statusPending || statusUnknown;

  return {
    status:
      conclusion !== null
        ? "completed"
        : partial || discovered === 0 || nullConclusion || statusUnknown
          ? "unknown"
          : unresolved
            ? "pending"
            : "completed",
    conclusion: conclusion ?? (!partial && discovered > 0 && !unresolved ? "success" : null),
    suiteCount,
    statusCount,
    updatedAt: new Date().toISOString(),
    source: "api-aggregate",
    partial,
    rateLimited,
    timedOut,
    permissionDenied,
    diagnostic:
      partial || nullConclusion || statusUnknown
        ? [
            ...failures.map((failure) =>
              failure.reason instanceof Error
                ? failure.reason.message
                : "GitHub checks unavailable",
            ),
            ...(incompleteSuites
              ? [`More than ${MAX_CHECK_SUITE_PAGES * 100} check suites require another page.`]
              : []),
            ...(nullConclusion ? ["A completed check suite has no conclusion."] : []),
            ...(statusUnknown
              ? ["GitHub returned commit statuses without an aggregate state."]
              : []),
          ]
            .join("; ")
            .slice(0, 2_000)
        : null,
    retryAt: retryAt?.toISOString() ?? null,
    headSha: args.headSha,
  };
}

type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await fn() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function listAllCheckSuites(args: {
  installationId: string | number;
  owner: string;
  repo: string;
  ref: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<GitHubCheckSuitesResponse & { truncated: boolean }> {
  const check_suites: GitHubCheckSuite[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_CHECK_SUITE_PAGES; page += 1) {
    const response = await githubRequest<GitHubCheckSuitesResponse>(
      args.installationId,
      `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits/${args.ref}/check-suites?per_page=100&page=${page}`,
      { signal: args.signal },
      args.requestTimeoutMs,
    );
    const rows = response.check_suites ?? [];
    check_suites.push(...rows);
    total = response.total_count ?? check_suites.length;
    if (check_suites.length >= total || rows.length < 100) {
      return { total_count: total, check_suites, truncated: false };
    }
  }
  return { total_count: total, check_suites, truncated: check_suites.length < total };
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
      requestedReviewers: (pr.requested_reviewers ?? [])
        .map((reviewer) => reviewer.login ?? "")
        .filter(Boolean),
      requestedTeams: (pr.requested_teams ?? []).map((team) => team.slug ?? "").filter(Boolean),
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
