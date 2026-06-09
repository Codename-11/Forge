import "server-only";
import { z } from "zod";
import {
  GITHUB_RESOURCE_TYPES,
  type GitHubRepoRef,
  type GitHubResourceType,
  type ParsedGitHubUrl,
} from "@/server/services/github/types";

const pathSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  kind: z.enum(["issues", "pull"]),
  number: z.coerce.number().int().positive(),
});

export function normalizeRepoFullName(raw: string): string {
  const [owner, repo] = raw.trim().split("/");
  if (!owner || !repo || raw.trim().split("/").length !== 2) {
    throw new Error("Repository must be in owner/name format.");
  }
  return `${owner}/${repo}`;
}

export function splitRepoFullName(raw: string): GitHubRepoRef {
  const repoFullName = normalizeRepoFullName(raw);
  const [owner, repo] = repoFullName.split("/") as [string, string];
  return { owner, repo, repoFullName };
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function parseGitHubUrl(rawUrl: string): ParsedGitHubUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("GitHub URL is not valid.");
  }
  if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("Only github.com URLs are supported.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const parsed = pathSchema.safeParse({
    owner: parts[0],
    repo: parts[1],
    kind: parts[2],
    number: parts[3],
  });
  if (!parsed.success) {
    throw new Error("URL must point to a GitHub issue or pull request.");
  }

  const type: GitHubResourceType =
    parsed.data.kind === "pull" ? "PULL_REQUEST" : "ISSUE";
  if (!GITHUB_RESOURCE_TYPES.includes(type)) {
    throw new Error("Unsupported GitHub resource type.");
  }
  const repoFullName = `${parsed.data.owner}/${parsed.data.repo}`;
  return {
    owner: parsed.data.owner,
    repo: parsed.data.repo,
    repoFullName,
    type,
    number: parsed.data.number,
    url: `https://github.com/${repoFullName}/${parsed.data.kind}/${parsed.data.number}`,
  };
}
