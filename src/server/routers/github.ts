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
import { parseGitHubUrl, splitRepoFullName } from "@/server/services/github/url";
import { EXTERNAL_LINK_KINDS } from "@/server/services/github/types";

const linkKindSchema = z.enum(EXTERNAL_LINK_KINDS);

export const githubRouter = router({
  parseUrl: workspaceProcedure
    .input(z.object({ url: z.string().url().max(2048) }))
    .query(({ input }) => parseGitHubUrl(input.url)),

  preview: workspaceProcedure
    .input(
      z.object({
        url: z.string().url().max(2048),
        mappingId: z.string().cuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const parsed = parseGitHubUrl(input.url);
      const mapping = await resolveGitHubRepoMapping({
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        mappingId: input.mappingId,
        repoFullName: parsed.repoFullName,
      });
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
      return issueSnapshot(parsed.repoFullName, issue);
    }),

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
        repoFullName: z.string().min(3).max(200).optional(),
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
