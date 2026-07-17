import type { Prisma } from "@prisma/client";

export type ParsedIssueSearch =
  | { kind: "empty" }
  | { kind: "identifier"; number: number; workspaceKey?: string }
  | { kind: "text"; query: string };

/**
 * Normalize operator-entered issue search without turning search into a
 * separate indexing concern. Identifiers are deliberately exact: once a
 * query looks like KEY-N, N, or #N, it never falls back to fuzzy text.
 */
export function parseIssueSearch(raw: string | null | undefined): ParsedIssueSearch {
  const query = raw?.trim().replace(/\s+/g, " ") ?? "";
  if (!query) return { kind: "empty" };

  const fullKey = /^([a-z][a-z0-9]{0,15})-(\d+)$/i.exec(query);
  if (fullKey) {
    const number = Number(fullKey[2]);
    return {
      kind: "identifier",
      workspaceKey: fullKey[1].toUpperCase(),
      number: Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : -1,
    };
  }

  const numberOnly = /^#?(\d+)$/.exec(query);
  if (numberOnly) {
    const number = Number(numberOnly[1]);
    return {
      kind: "identifier",
      number: Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : -1,
    };
  }

  return { kind: "text", query };
}

/**
 * Shared Prisma predicate for every operator-facing issue-search surface.
 * Callers must compose this with their existing workspace, lifecycle,
 * archive, facet, and API-key scope clauses.
 */
export function issueSearchWhere(
  raw: string | null | undefined,
): Prisma.IssueWhereInput | undefined {
  const parsed = parseIssueSearch(raw);
  if (parsed.kind === "empty") return undefined;

  if (parsed.kind === "identifier") {
    return {
      number: parsed.number,
      ...(parsed.workspaceKey
        ? {
            workspace: {
              key: { equals: parsed.workspaceKey, mode: "insensitive" },
            },
          }
        : {}),
    };
  }

  const contains = { contains: parsed.query, mode: "insensitive" as const };
  return {
    OR: [
      { title: contains },
      { description: contains },
      { project: { is: { OR: [{ key: contains }, { name: contains }] } } },
      { labels: { some: { label: { name: contains } } } },
      {
        assignees: {
          some: {
            user: {
              OR: [{ name: contains }, { handle: contains }, { email: contains }],
            },
          },
        },
      },
      {
        assignedAgent: {
          is: { OR: [{ name: contains }, { profileKey: contains }] },
        },
      },
    ],
  };
}
