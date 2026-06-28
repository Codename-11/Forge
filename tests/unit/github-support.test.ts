import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Priority } from "@prisma/client";
import { issueCreateInputFromGitHub } from "@/server/services/github/mapping-policy";
import { parseGitHubUrl } from "@/server/services/github/url";
import { verifyGitHubWebhookSignature } from "@/server/services/github/webhook";

describe("GitHub support utilities", () => {
  it("parses GitHub issue and pull request URLs", () => {
    expect(parseGitHubUrl("https://github.com/acme/api/issues/42")).toMatchObject({
      owner: "acme",
      repo: "api",
      repoFullName: "acme/api",
      type: "ISSUE",
      number: 42,
      url: "https://github.com/acme/api/issues/42",
    });

    expect(parseGitHubUrl("https://github.com/acme/api/pull/99")).toMatchObject({
      owner: "acme",
      repo: "api",
      repoFullName: "acme/api",
      type: "PULL_REQUEST",
      number: 99,
      url: "https://github.com/acme/api/pull/99",
    });

    expect(() => parseGitHubUrl("https://example.com/acme/api/issues/1")).toThrow(/github/i);
    expect(() => parseGitHubUrl("https://github.com/acme/api/actions/runs/1")).toThrow(/issue/i);
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const secret = "test-secret";
    const rawBody = JSON.stringify({ action: "opened", issue: { number: 1 } });
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature({ secret, rawBody, signature })).toBe(true);
    expect(verifyGitHubWebhookSignature({ secret, rawBody: `${rawBody} `, signature })).toBe(false);
    expect(verifyGitHubWebhookSignature({ secret, rawBody, signature: "sha1=bad" })).toBe(false);
  });

  it("maps GitHub labels and repo defaults into Forge issue-create input", () => {
    const input = issueCreateInputFromGitHub({
      mapping: {
        labelIds: ["lbl_default"],
        config: {
          github: {
            defaultProjectId: "prj_support",
            defaultLabelIds: ["lbl_github"],
            labelMap: { bug: "lbl_bug" },
            defaultPriority: Priority.HIGH,
            queueOnCreate: true,
          },
        },
      },
      snapshot: {
        provider: "GITHUB",
        resourceType: "ISSUE",
        repoFullName: "acme/api",
        externalId: "123",
        externalNodeId: "node",
        number: 42,
        url: "https://github.com/acme/api/issues/42",
        apiUrl: "https://api.github.com/repos/acme/api/issues/42",
        title: "API throws 500",
        state: "open",
        authorLogin: "octo",
        labels: [{ name: "bug", color: "ff0000" }],
        assignees: [],
        metadata: { body: "Steps to reproduce" },
      },
    });

    expect(input.title).toBe("API throws 500");
    expect(input.projectId).toBe("prj_support");
    expect(input.priority).toBe(Priority.HIGH);
    expect(input.queued).toBe(true);
    expect(input.labelIds?.sort()).toEqual(["lbl_bug", "lbl_default", "lbl_github"].sort());
    expect(input.description).toContain("GitHub issue: https://github.com/acme/api/issues/42");
    expect(input.description).toContain("Steps to reproduce");
    expect(input.eventPayload).toMatchObject({
      source: "github",
      repo: "acme/api",
      number: 42,
      resourceType: "ISSUE",
    });
  });

  it("maps GitHub pull requests into Forge issue-create input", () => {
    const input = issueCreateInputFromGitHub({
      mapping: { labelIds: [], config: {} },
      snapshot: {
        provider: "GITHUB",
        resourceType: "PULL_REQUEST",
        repoFullName: "acme/api",
        number: 99,
        url: "https://github.com/acme/api/pull/99",
        title: "Fix flaky import",
        state: "open",
        authorLogin: "octo",
        labels: [],
        assignees: [],
        metadata: { body: "PR body" },
      },
    });

    expect(input.title).toBe("Fix flaky import");
    expect(input.description).toContain("GitHub pull request: https://github.com/acme/api/pull/99");
    expect(input.eventPayload).toMatchObject({
      source: "github",
      repo: "acme/api",
      number: 99,
      resourceType: "PULL_REQUEST",
    });
  });
});
