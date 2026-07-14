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
      permissionDenied: true,
      statusCount: 1,
    });
    expect(checks.diagnostic).toContain("Checks permission required");
  });

  it("aggregates every check-suite page and ignores empty legacy status pending", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({
      status: "completed",
      conclusion: "success",
    }));
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 101, check_suites: firstPage }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 101,
            check_suites: [{ status: "completed", conclusion: "neutral" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "pending", total_count: 0 }), { status: 200 }),
      );

    const checks = await getGitHubPullRequestChecks({
      installationId: 1,
      owner: "acme",
      repo: "forge",
      headSha: "abc123",
    });

    expect(checks).toMatchObject({
      status: "completed",
      conclusion: "success",
      suiteCount: 101,
      statusCount: 0,
      partial: false,
      source: "api-aggregate",
    });
    const urls = vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url));
    expect(urls[0]).not.toContain("filter=latest");
    expect(urls[1]).toContain("page=2");
  });

  it("keeps a completed suite with a null conclusion untrusted", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 2,
            check_suites: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: null },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "success", total_count: 1 }), { status: 200 }),
      );

    await expect(
      getGitHubPullRequestChecks({
        installationId: 1,
        owner: "acme",
        repo: "forge",
        headSha: "abc123",
      }),
    ).resolves.toMatchObject({ status: "unknown", conclusion: null });
  });

  it("keeps malformed legacy status aggregates untrusted", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 1,
            check_suites: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 1 }), { status: 200 }));

    await expect(
      getGitHubPullRequestChecks({
        installationId: 1,
        owner: "acme",
        repo: "forge",
        headSha: "abc123",
      }),
    ).resolves.toMatchObject({
      status: "unknown",
      conclusion: null,
      diagnostic: "GitHub returned commit statuses without an aggregate state.",
    });
  });

  it("reports partial rate limits accurately even when another checks endpoint succeeds", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "success", total_count: 1 }), { status: 200 }),
      );

    await expect(
      getGitHubPullRequestChecks({
        installationId: 1,
        owner: "acme",
        repo: "forge",
        headSha: "abc123",
      }),
    ).resolves.toMatchObject({
      partial: true,
      rateLimited: true,
      permissionDenied: false,
      conclusion: null,
      retryAt: new Date(reset * 1000).toISOString(),
    });
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

  it("aborts GitHub requests at the configured timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Timed out", "TimeoutError")),
          );
        }),
    );

    await expect(
      getGitHubPullRequest({
        installationId: 1,
        owner: "acme",
        repo: "forge",
        number: 42,
        requestTimeoutMs: 5,
      }),
    ).rejects.toMatchObject({ status: 408, timedOut: true, rateLimited: false });
  });
});
