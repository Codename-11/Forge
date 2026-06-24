import { describe, it, expect } from "vitest";
import { classifyLinkability, repoInInstallation } from "@/server/services/github/linkability";
import type { GitHubRepoResponse } from "@/server/services/github/client";

function repo(full_name: string): GitHubRepoResponse {
  return { id: 1, full_name, html_url: `https://github.com/${full_name}` };
}

describe("repoInInstallation", () => {
  it("matches case-insensitively", () => {
    const repos = [repo("Forge-Platform/Forge"), repo("bailey/axiom")];
    expect(repoInInstallation(repos, "forge-platform/forge")).toBe(true);
    expect(repoInInstallation(repos, "BAILEY/AXIOM")).toBe(true);
    expect(repoInInstallation(repos, "other/repo")).toBe(false);
  });

  it("is empty-safe", () => {
    expect(repoInInstallation([], "a/b")).toBe(false);
  });
});

describe("classifyLinkability", () => {
  const repoFullName = "octocat/hello";

  it("returns ready when an active mapping covers the repo", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [{ id: "m1", target: "octocat/hello", status: "active", account: "octocat" }],
      connections: [],
    });
    expect(result).toEqual({ status: "ready", repoFullName, mappingId: "m1", account: "octocat" });
  });

  it("matches the mapping case-insensitively", () => {
    const result = classifyLinkability({
      repoFullName: "OctoCat/Hello",
      mappings: [{ id: "m1", target: "octocat/hello", status: "active", account: null }],
      connections: [],
    });
    expect(result.status).toBe("ready");
  });

  it("prefers an active mapping over a paused one for the same repo", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [
        { id: "paused", target: "octocat/hello", status: "paused", account: null },
        { id: "active", target: "octocat/hello", status: "active", account: null },
      ],
      connections: [],
    });
    expect(result).toMatchObject({ status: "ready", mappingId: "active" });
  });

  it("returns paused when only a paused mapping covers the repo", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [{ id: "m1", target: "octocat/hello", status: "paused", account: "octocat" }],
      connections: [],
    });
    expect(result).toEqual({ status: "paused", repoFullName, mappingId: "m1", account: "octocat" });
  });

  it("returns mappable when a connection's installation can reach the repo", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [],
      connections: [
        { connectionId: "c1", account: "octocat", label: "GitHub", hasRepo: true },
        { connectionId: "c2", account: "other", label: "GitHub", hasRepo: false },
      ],
    });
    expect(result).toEqual({
      status: "mappable",
      repoFullName,
      connections: [{ connectionId: "c1", account: "octocat", label: "GitHub" }],
    });
  });

  it("returns needs_repo_access when connections exist but none reach the repo", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [],
      connections: [{ connectionId: "c1", account: "octocat", label: "GitHub", hasRepo: false }],
    });
    expect(result.status).toBe("needs_repo_access");
    if (result.status === "needs_repo_access") {
      expect(result.connections).toEqual([{ connectionId: "c1", account: "octocat", label: "GitHub" }]);
    }
  });

  it("returns no_connection when there are no GitHub connections at all", () => {
    const result = classifyLinkability({ repoFullName, mappings: [], connections: [] });
    expect(result).toEqual({ status: "no_connection", repoFullName });
  });

  it("ignores mappings for unrelated repos", () => {
    const result = classifyLinkability({
      repoFullName,
      mappings: [{ id: "m1", target: "someone/else", status: "active", account: null }],
      connections: [{ connectionId: "c1", account: null, label: "GitHub", hasRepo: true }],
    });
    expect(result.status).toBe("mappable");
  });
});
