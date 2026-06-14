import { describe, it, expect } from "vitest";
import { deriveRepoPath } from "@/server/services/repo-path";

describe("deriveRepoPath", () => {
  it("takes the repo name from https URLs, dropping .git", () => {
    expect(deriveRepoPath("https://github.com/acme/forge.git")).toBe("forge");
    expect(deriveRepoPath("https://github.com/acme/forge")).toBe("forge");
    expect(deriveRepoPath("https://example.com/x/y/repo")).toBe("repo");
  });

  it("handles scp-style ssh URLs", () => {
    expect(deriveRepoPath("git@github.com:acme/forge.git")).toBe("forge");
    expect(deriveRepoPath("ssh://git@github.com/acme/forge.git")).toBe("forge");
  });

  it("strips trailing slashes and unsafe chars", () => {
    expect(deriveRepoPath("https://github.com/acme/forge/")).toBe("forge");
    expect(deriveRepoPath("https://github.com/acme/we ird!.git")).toBe("weird");
  });

  it("returns empty for unusable input", () => {
    expect(deriveRepoPath("")).toBe("");
    expect(deriveRepoPath("   ")).toBe("");
  });
});
