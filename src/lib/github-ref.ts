export type GitHubIssueOrPrRef = {
  repoFullName: string;
  number: number;
  type?: "ISSUE" | "PULL_REQUEST";
  url?: string;
};

/** Parse a GitHub issue/PR URL or shorthand owner/repo#123. */
export function parseGitHubIssueOrPrRef(raw: string): GitHubIssueOrPrRef | null {
  const s = raw.trim();
  if (!s) return null;

  if (s.includes("://") || s.startsWith("github.com") || s.startsWith("www.github.com")) {
    try {
      const u = new URL(s.startsWith("http") ? s : `https://${s}`);
      if (!["github.com", "www.github.com"].includes(u.hostname.toLowerCase())) return null;
      const [owner, repo, kind, num] = u.pathname.split("/").filter(Boolean);
      if (!owner || !repo || (kind !== "issues" && kind !== "pull") || !/^\d+$/.test(num ?? "")) {
        return null;
      }
      return {
        repoFullName: `${owner}/${repo}`,
        number: Number(num),
        type: kind === "pull" ? "PULL_REQUEST" : "ISSUE",
        url: `https://github.com/${owner}/${repo}/${kind}/${num}`,
      };
    } catch {
      return null;
    }
  }

  const hash = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (hash) {
    return { repoFullName: `${hash[1]}/${hash[2]}`, number: Number(hash[3]) };
  }
  return null;
}
