import type { ExternalLinkKind } from "@/server/services/github/types";

const IMPLEMENTS_PATTERN = /\bimplements?\s*[:#-]?\s*$/i;
const FIXES_PATTERN = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*[:#-]?\s*$/i;
const RELEASE_TITLE_PATTERN = /^\s*release\s+v?\d/i;
const RELEASE_BRANCH_PATTERN = /(?:^|\/)release(?:[-/]|$)/i;
const GROUPED_REFERENCE_SEPARATOR = /^\s*(?:,\s*(?:(?:and|&)\s*)?|(?:and|&)\s*)$/i;

function relationRank(kind: ExternalLinkKind): number {
  if (kind === "FIXES") return 3;
  if (kind === "IMPLEMENTS") return 2;
  return 1;
}

export function isReleasePullRequest(input: { title: string; headRef?: string | null }): boolean {
  return (
    RELEASE_TITLE_PATTERN.test(input.title) || RELEASE_BRANCH_PATTERN.test(input.headRef ?? "")
  );
}

/**
 * Derive native issue-to-PR relations from explicit Forge issue references.
 * Bare mentions are related work; implementation and closing keywords upgrade
 * that relation, while release assembly PRs remain release containment.
 */
export function derivePullRequestIssueRelations(input: {
  workspaceKey: string;
  title: string;
  body?: string | null;
  headRef?: string | null;
}): Map<number, ExternalLinkKind> {
  const escaped = input.workspaceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const issuePattern = new RegExp(`\\b${escaped}-(\\d+)\\b`, "gi");
  const release = isReleasePullRequest(input);
  const relations = new Map<number, ExternalLinkKind>();

  for (const text of [input.title, input.body ?? ""]) {
    let match: RegExpExecArray | null;
    let previousMatchEnd: number | null = null;
    let previousKind: ExternalLinkKind | null = null;
    while ((match = issuePattern.exec(text))) {
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number <= 0) continue;
      const prefix = text.slice(Math.max(0, match.index - 48), match.index);
      const directKind: ExternalLinkKind | null = FIXES_PATTERN.test(prefix)
        ? "FIXES"
        : IMPLEMENTS_PATTERN.test(prefix)
          ? "IMPLEMENTS"
          : null;
      const groupedKind: ExternalLinkKind | null =
        previousMatchEnd !== null &&
        previousKind !== null &&
        GROUPED_REFERENCE_SEPARATOR.test(text.slice(previousMatchEnd, match.index))
          ? previousKind
          : null;
      const kind: ExternalLinkKind = release
        ? "RELEASES"
        : (directKind ?? groupedKind ?? "RELATES_TO");
      const current = relations.get(number);
      if (!current || release || relationRank(kind) > relationRank(current)) {
        relations.set(number, kind);
      }
      previousMatchEnd = issuePattern.lastIndex;
      previousKind = kind;
    }
  }
  return relations;
}
