import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/services/github/installation-token", () => ({
  resolveInstallationToken: vi.fn().mockResolvedValue("installation-token"),
}));

import {
  getGitHubPullRequest,
  getGitHubPullRequestChecks,
  GitHubRequestError,
} from "@/server/services/github/client";

describe("GitHub REST client resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps partial check data unavailable instead of failing a readable PR", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Checks permission required" }), { status: 403 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "success", total_count: 1 }), { status: 200 }),
      );

    const checks = await getGitHubPullRequestChecks({
      installationId: 1,
      owner: "acme",
      repo: "forge",
      headSha: "abc123",
    });

    expect(checks).toMatchObject({
      status: "unknown",
      conclusion: null,
      partial: true,
      statusCount: 1,
    });
    expect(checks.diagnostic).toContain("Checks permission required");
  });

  it("preserves GitHub rate-limit reset timing on request errors", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 429,
        headers: { "x-ratelimit-reset": String(reset) },
      }),
    );

    await expect(
      getGitHubPullRequest({ installationId: 1, owner: "acme", repo: "forge", number: 42 }),
    ).rejects.toMatchObject({
      name: "GitHubRequestError",
      status: 429,
      retryAt: new Date(reset * 1000),
    } satisfies Partial<GitHubRequestError>);
  });
});
