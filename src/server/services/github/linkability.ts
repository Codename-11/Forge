import "server-only";
import { TRPCError } from "@trpc/server";
import { ConnectionProvider, ConnectionStatus, type PrismaClient } from "@prisma/client";
import { listGitHubInstallationRepos, type GitHubRepoResponse } from "@/server/services/github/client";
import { githubInstallationId } from "@/server/services/github/mapping-policy";
import { normalizeRepoFullName, sameRepo } from "@/server/services/github/url";

/**
 * "Can this workspace link a PR/issue from `owner/repo` right now, and if
 * not, what's the cheapest path to fixing it?" — resolved for the issue-page
 * link modal so the operator gets a remediation step instead of a raw
 * "No active GitHub mapping" error.
 *
 * Linking depends on an **active repo `ConnectionMapping`** (a per-workspace
 * binding of a GitHub `Connection` to `owner/repo`). Installing the GitHub
 * App only creates the `Connection`; the repo mapping is a separate,
 * admin-gated step that nothing previously surfaced from the issue view.
 */

/** A GitHub connection the operator could map this repo onto. */
export type LinkConnectionRef = {
  connectionId: string;
  account: string | null;
  label: string;
};

export type GitHubLinkability =
  /** An active mapping already covers this repo — link directly. */
  | { status: "ready"; repoFullName: string; mappingId: string; account: string | null }
  /** A mapping exists but is paused — resume it (admin) to link. */
  | { status: "paused"; repoFullName: string; mappingId: string; account: string | null }
  /** No mapping, but an installed App can reach the repo — map it (admin). */
  | { status: "mappable"; repoFullName: string; connections: LinkConnectionRef[] }
  /** Connected, but no installation includes this repo — grant access on GitHub. */
  | { status: "needs_repo_access"; repoFullName: string; connections: LinkConnectionRef[] }
  /** No GitHub connection at all — install/connect the App first. */
  | { status: "no_connection"; repoFullName: string }
  /**
   * No active mapping, and the caller isn't an admin — so we deliberately do
   * NOT probe installations (that would leak a private-repo access oracle to
   * non-privileged members). The remediation here is "ask an admin".
   */
  | { status: "not_ready"; repoFullName: string };

type ConnectionConsidered = {
  connectionId: string;
  account: string | null;
  label: string;
  /** The installation backing this connection includes the target repo. */
  hasRepo: boolean;
};

/** True if `repoFullName` appears (case-insensitively) in the installation list. */
export function repoInInstallation(repos: GitHubRepoResponse[], repoFullName: string): boolean {
  return repos.some((r) => r.full_name && sameRepo(r.full_name, repoFullName));
}

/**
 * Pure decision step — given the workspace's GitHub repo mappings and the set
 * of candidate connections (each already probed for repo access), pick the
 * linkability status. Network/DB-free so it's unit-testable.
 */
export function classifyLinkability(args: {
  repoFullName: string;
  mappings: Array<{ id: string; target: string; status: string; account: string | null }>;
  connections: ConnectionConsidered[];
}): GitHubLinkability {
  const { repoFullName } = args;
  const matches = args.mappings.filter((m) => sameRepo(m.target, repoFullName));
  const active = matches.find((m) => m.status === "active");
  if (active) {
    return { status: "ready", repoFullName, mappingId: active.id, account: active.account };
  }
  const paused = matches.find((m) => m.status === "paused");
  if (paused) {
    return { status: "paused", repoFullName, mappingId: paused.id, account: paused.account };
  }

  const withRepo = args.connections.filter((c) => c.hasRepo);
  if (withRepo.length > 0) {
    return {
      status: "mappable",
      repoFullName,
      connections: withRepo.map(({ connectionId, account, label }) => ({ connectionId, account, label })),
    };
  }
  if (args.connections.length > 0) {
    return {
      status: "needs_repo_access",
      repoFullName,
      connections: args.connections.map(({ connectionId, account, label }) => ({ connectionId, account, label })),
    };
  }
  return { status: "no_connection", repoFullName };
}

/** How many connections we'll probe against the GitHub API per resolve. */
const MAX_PROBE_CONNECTIONS = 8;

type RepoLister = (args: { installationId: string | number }) => Promise<GitHubRepoResponse[]>;

/**
 * Resolve {@link GitHubLinkability} for a repo: cheap mapping lookup first
 * (the common "ready" path makes no GitHub API calls), then probe candidate
 * connections (owned by the caller or already mapped into this workspace)
 * only when no active mapping exists.
 */
export async function resolveRepoLinkability(args: {
  db: PrismaClient;
  workspaceId: string;
  userId: string | null;
  /**
   * Whether the caller is a workspace OWNER/ADMIN. Only admins get the
   * installation-probing branches (mappable / needs_repo_access / no_connection)
   * and the `connections[]` payload — they're the only ones who can act on the
   * remediation, and probing arbitrary repos is a private-repo access oracle
   * we must not expose to ordinary members.
   */
  isAdmin: boolean;
  repoFullName: string;
  listRepos?: RepoLister;
}): Promise<GitHubLinkability> {
  const repoFullName = normalizeRepoFullName(args.repoFullName);
  const listRepos = args.listRepos ?? listGitHubInstallationRepos;

  const mappings = await args.db.connectionMapping.findMany({
    where: {
      workspaceId: args.workspaceId,
      kind: "repo",
      connection: { provider: ConnectionProvider.GITHUB },
    },
    select: {
      id: true,
      target: true,
      status: true,
      connectionId: true,
      connection: { select: { id: true, account: true, label: true, status: true, config: true } },
    },
  });

  const mappingViews = mappings.map((m) => ({
    id: m.id,
    target: m.target,
    status: m.status,
    account: m.connection.account,
  }));

  // Fast path: an active or paused mapping already covers the repo. This is
  // safe for any member — repo mappings are already visible via
  // `connectionMapping.list` — and makes no GitHub API call.
  const decidedByMapping = classifyLinkability({ repoFullName, mappings: mappingViews, connections: [] });
  if (decidedByMapping.status === "ready" || decidedByMapping.status === "paused") {
    return decidedByMapping;
  }

  // Non-admins never probe installations: the mappable-vs-needs_repo_access
  // answer is a private-repo access oracle, and the remediation is admin-only
  // anyway. Collapse everything else to an opaque "ask an admin".
  if (!args.isAdmin) {
    return { status: "not_ready", repoFullName };
  }

  // Candidate connections (admins only): connected identities already trusted
  // into this workspace (via any mapping) plus the caller's own connected
  // GitHub identities. Only CONNECTED connections can be probed.
  const candidates = new Map<string, { account: string | null; label: string; config: unknown }>();
  for (const m of mappings) {
    if (m.connection.status !== ConnectionStatus.CONNECTED) continue;
    candidates.set(m.connection.id, {
      account: m.connection.account,
      label: m.connection.label,
      config: m.connection.config,
    });
  }
  if (args.userId) {
    const owned = await args.db.connection.findMany({
      where: {
        ownerId: args.userId,
        provider: ConnectionProvider.GITHUB,
        status: ConnectionStatus.CONNECTED,
      },
      select: { id: true, account: true, label: true, config: true },
    });
    for (const c of owned) {
      if (!candidates.has(c.id)) candidates.set(c.id, { account: c.account, label: c.label, config: c.config });
    }
  }

  const probeList = [...candidates.entries()].slice(0, MAX_PROBE_CONNECTIONS);
  const considered = await Promise.all(
    probeList.map(async ([connectionId, c]): Promise<ConnectionConsidered> => {
      let hasRepo = false;
      try {
        const installationId = githubInstallationId({ config: c.config as never });
        const repos = await listRepos({ installationId });
        hasRepo = repoInInstallation(repos, repoFullName);
      } catch (err) {
        // Unreachable installation (revoked, missing id, API error) — still a
        // candidate connection, just can't confirm repo access. Log so a
        // misconfig (missing App key, GitHub outage) isn't silently rendered
        // as a "grant repo access" dead-end.
        console.warn(
          `[github] linkability probe failed for connection ${connectionId}:`,
          err instanceof Error ? err.message : err,
        );
        hasRepo = false;
      }
      return { connectionId, account: c.account, label: c.label, hasRepo };
    }),
  );

  return classifyLinkability({ repoFullName, mappings: mappingViews, connections: considered });
}

/**
 * Create (or re-activate) an active repo mapping so the issue page can link
 * `owner/repo`. Admin-gated at the router; the trust check here requires the
 * caller to own the connection **or** the connection to already be mapped
 * into this workspace (so a second admin can extend repo coverage for an App
 * the first admin introduced). Verifies the App can actually reach the repo
 * before writing the row.
 */
export async function mapGitHubRepo(args: {
  db: PrismaClient;
  workspaceId: string;
  userId: string;
  connectionId: string;
  repoFullName: string;
  direction?: string;
  labelIds?: string[];
  listRepos?: RepoLister;
}): Promise<{ id: string; target: string; reactivated: boolean }> {
  const repoFullName = normalizeRepoFullName(args.repoFullName);
  const listRepos = args.listRepos ?? listGitHubInstallationRepos;

  const connection = await args.db.connection.findFirst({
    where: { id: args.connectionId, provider: ConnectionProvider.GITHUB },
    select: { id: true, ownerId: true, config: true },
  });
  if (!connection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "GitHub connection not found." });
  }
  const owns = connection.ownerId === args.userId;
  const inWorkspace =
    !owns &&
    // Scope to repo mappings: a connection introduced only for a webhook /
    // channel shouldn't implicitly authorize repurposing it as a repo source.
    (await args.db.connectionMapping.count({
      where: { connectionId: args.connectionId, workspaceId: args.workspaceId, kind: "repo" },
    })) > 0;
  if (!owns && !inWorkspace) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Map only connections you own or that this workspace already uses for a repo.",
    });
  }

  // Don't write a mapping the App can't serve — surfaces as a clean error.
  let installationId: string;
  try {
    installationId = githubInstallationId(connection);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This GitHub connection has no installation. Reinstall the GitHub App.",
    });
  }
  let repos: GitHubRepoResponse[];
  try {
    repos = await listRepos({ installationId });
  } catch (err) {
    // A transient GitHub failure shouldn't surface as an opaque 500 — make it
    // a retryable upstream error.
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `Couldn't reach GitHub to verify repository access${
        err instanceof Error ? ` (${err.message})` : ""
      }. Try again.`,
    });
  }
  if (!repoInInstallation(repos, repoFullName)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The GitHub App installation can't access ${repoFullName}. Grant it access on GitHub, then retry.`,
    });
  }

  // Idempotent: reuse an existing mapping for THIS repo, re-activating if
  // paused. Match by repo (a connection can map several repos), not just by
  // connection — else a second repo on the same connection would falsely look
  // like a non-match and create duplicates, or collide with another repo's row.
  const repoMappings = await args.db.connectionMapping.findMany({
    where: { workspaceId: args.workspaceId, connectionId: args.connectionId, kind: "repo" },
    select: { id: true, target: true, status: true },
  });
  const match = repoMappings.find((m) => sameRepo(m.target, repoFullName)) ?? null;
  if (match) {
    if (match.status === "active") return { id: match.id, target: match.target, reactivated: false };
    const updated = await args.db.connectionMapping.update({
      where: { id: match.id },
      data: { status: "active" },
      select: { id: true, target: true },
    });
    return { id: updated.id, target: updated.target, reactivated: true };
  }

  const created = await args.db.connectionMapping.create({
    data: {
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      kind: "repo",
      target: repoFullName,
      direction: args.direction ?? "inbound+outbound",
      labelIds: args.labelIds ?? [],
      status: "active",
    },
    select: { id: true, target: true },
  });
  return { id: created.id, target: created.target, reactivated: false };
}

/** Active repo mappings in a workspace — for the browse picker + agent discovery. */
export async function listGitHubRepoMappings(args: {
  db: PrismaClient;
  workspaceId: string;
  includePaused?: boolean;
}): Promise<Array<{ id: string; repoFullName: string; account: string | null; status: string }>> {
  const rows = await args.db.connectionMapping.findMany({
    where: {
      workspaceId: args.workspaceId,
      kind: "repo",
      connection: { provider: ConnectionProvider.GITHUB },
      ...(args.includePaused ? {} : { status: "active" }),
    },
    orderBy: { target: "asc" },
    select: {
      id: true,
      target: true,
      status: true,
      connection: { select: { account: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    repoFullName: r.target,
    account: r.connection.account,
    status: r.status,
  }));
}
