import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ConnectionProvider } from "@prisma/client";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";
import {
  getGitHubIssue,
  getGitHubPullRequest,
  issueSnapshot,
  listGitHubInstallationRepos,
  pullRequestSnapshot,
  searchGitHubIssuesAndPulls,
} from "@/server/services/github/client";
import { githubInstallationId } from "@/server/services/github/mapping-policy";
import {
  importGitHubIssue,
  linkGitHubUrlToIssue,
  listLinkedGitHubResources,
  resolveGitHubRepoMapping,
  syncGitHubExternalResource,
} from "@/server/services/github/resource-sync";
import {
  connectGithubAppAsConnection,
  listGitHubRepoMappings,
  mapGitHubRepo,
  resolveRepoLinkability,
} from "@/server/services/github/linkability";
import { parseGitHubUrl, splitRepoFullName } from "@/server/services/github/url";
import { EXTERNAL_LINK_KINDS, type GitHubResourceSnapshot } from "@/server/services/github/types";

const linkKindSchema = z.enum(EXTERNAL_LINK_KINDS);

/** `owner/repo` shape guard — keeps malformed input a clean 400, not a 500. */
const repoFullNameSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, "Repository must be in owner/name format.");

export const githubRouter = router({
  parseUrl: workspaceProcedure
    .input(z.object({ url: z.string().url().max(2048) }))
    .query(({ input }) => parseGitHubUrl(input.url)),

  /**
   * Preview a GitHub issue/PR before linking. Accepts either a full `url`
   * or a `repoFullName` + `number` (so `owner/repo#123` works). When the
   * number turns out to be a PR (the issues endpoint returns it with a
   * `pull_request` marker), this auto-resolves it as a PR so the snapshot —
   * and its canonical `url`/`resourceType` used by `link` — are correct.
   */
  preview: workspaceProcedure
    .input(
      z
        .object({
          url: z.string().url().max(2048).optional(),
          repoFullName: repoFullNameSchema.optional(),
          number: z.number().int().positive().optional(),
          mappingId: z.string().cuid().optional(),
        })
        .refine((v) => !!v.url || (!!v.repoFullName && !!v.number), {
          message: "Provide a url, or repoFullName + number.",
        }),
    )
    .query(async ({ ctx, input }): Promise<GitHubResourceSnapshot> => {
      const ref = input.url
        ? parseGitHubUrl(input.url)
        : (() => {
            const repo = splitRepoFullName(input.repoFullName!);
            return { ...repo, type: "ISSUE" as const, number: input.number! };
          })();
      const mapping = await resolveGitHubRepoMapping({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
        repoFullName: ref.repoFullName,
      });
      const installationId = githubInstallationId(mapping.connection);
      if (ref.type === "PULL_REQUEST") {
        const pr = await getGitHubPullRequest({
          installationId,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
        });
        return pullRequestSnapshot(ref.repoFullName, pr);
      }
      const issue = await getGitHubIssue({
        installationId,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
      });
      // An "issue" number that's actually a PR — resolve it as one so the
      // link carries the right resourceType + /pull/ url.
      if (issue.pull_request) {
        const pr = await getGitHubPullRequest({
          installationId,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
        });
        return pullRequestSnapshot(ref.repoFullName, pr);
      }
      return issueSnapshot(ref.repoFullName, issue);
    }),

  /**
   * "Can this workspace link `owner/repo` right now — and if not, what's the
   * fix?" Drives the issue-page link modal's remediation states instead of a
   * raw "No active GitHub mapping" error. The common ready/paused answers
   * make no GitHub API call.
   */
  linkability: workspaceProcedure
    .input(z.object({ repoFullName: repoFullNameSchema }))
    .query(({ ctx, input }) =>
      resolveRepoLinkability({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        isAdmin: ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN",
        repoFullName: input.repoFullName,
      }),
    ),

  /** Active repo mappings — browse-mode repo picker + agent discovery. */
  listMappings: workspaceProcedure
    .input(z.object({ includePaused: z.boolean().default(false) }).default({ includePaused: false }))
    .query(({ ctx, input }) =>
      listGitHubRepoMappings({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        includePaused: input.includePaused,
      }),
    ),

  /**
   * Bind `owner/repo` to a GitHub connection so the issue page can link it —
   * the one-click remediation behind the modal's "Map & link". Admin-gated;
   * verifies the App can reach the repo before writing the mapping.
   */
  mapRepo: adminProcedure
    .input(
      z.object({
        connectionId: z.string().cuid(),
        repoFullName: repoFullNameSchema,
        labelIds: z.array(z.string().cuid()).default([]),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapGitHubRepo({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        connectionId: input.connectionId,
        repoFullName: input.repoFullName,
        labelIds: input.labelIds,
      }),
    ),

  /**
   * One-click "use the workspace's installed GitHub App for linking": creates a
   * GitHub Connection from a `GithubApp` (the kind set up in Settings → GitHub
   * Apps) so issue/PR linking works without a separate global env app or a
   * GitHub re-install. Optionally maps `repoFullName` in the same call.
   */
  connectApp: adminProcedure
    .input(
      z.object({
        githubAppId: z.string().cuid().optional(),
        repoFullName: repoFullNameSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      connectGithubAppAsConnection({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        githubAppId: input.githubAppId,
        repoFullName: input.repoFullName,
      }),
    ),

  listLinked: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found." });
      return listLinkedGitHubResources({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        issueId: input.issueId,
      });
    }),

  link: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        url: z.string().url().max(2048),
        kind: linkKindSchema.default("RELATES_TO"),
        mappingId: z.string().cuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      linkGitHubUrlToIssue({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        issueId: input.issueId,
        url: input.url,
        kind: input.kind,
        mappingId: input.mappingId,
        actor: {
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ),

  importIssue: workspaceProcedure
    .input(
      z.object({
        mappingId: z.string().cuid().optional(),
        repoFullName: repoFullNameSchema.optional(),
        number: z.number().int().positive(),
        projectId: z.string().cuid().nullable().optional(),
        labelIds: z.array(z.string().cuid()).default([]),
        queue: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      importGitHubIssue({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
        repoFullName: input.repoFullName,
        number: input.number,
        projectId: input.projectId,
        labelIds: input.labelIds,
        queue: input.queue,
        actor: {
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ),

  sync: workspaceProcedure
    .input(z.object({ externalResourceId: z.string().cuid() }))
    .mutation(({ ctx, input }) =>
      syncGitHubExternalResource({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        externalResourceId: input.externalResourceId,
        actor: {
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ),

  search: workspaceProcedure
    .input(
      z.object({
        mappingId: z.string().cuid(),
        query: z.string().min(1).max(200),
        type: z.enum(["issue", "pr"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const mapping = await resolveGitHubRepoMapping({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
      });
      return searchGitHubIssuesAndPulls({
        installationId: githubInstallationId(mapping.connection),
        repoFullName: mapping.target,
        query: input.query,
        type: input.type,
      });
    }),

  listInstallationRepos: adminProcedure
    .input(z.object({ connectionId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const connection = await ctx.db.connection.findFirst({
        where: {
          id: input.connectionId,
          ownerId: ctx.session.user.id,
          provider: ConnectionProvider.GITHUB,
        },
        select: { id: true, config: true },
      });
      if (!connection) {
        throw new TRPCError({ code: "NOT_FOUND", message: "GitHub connection not found." });
      }
      return listGitHubInstallationRepos({
        installationId: githubInstallationId(connection),
      });
    }),

  testMapping: adminProcedure
    .input(z.object({ mappingId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const mapping = await resolveGitHubRepoMapping({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
        requireActive: false,
      });
      const repo = splitRepoFullName(mapping.target);
      return {
        ok: true,
        repo,
        installationId: githubInstallationId(mapping.connection),
        status: mapping.status,
      };
    }),
});
