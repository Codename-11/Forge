import type { EngagementMode } from "@prisma/client";
import {
  parseAgentRequestsFromBody,
  parseAgentRequestTokensFromBody,
} from "@/lib/agent-request-parser";

export type AgentRequestOverrides = Record<string, { mode: EngagementMode; assignIssue?: boolean }>;

/** Update every mode for the selected agent, preserving prose and other agents. */
export function prepareAgentRequestDraft(
  body: string,
  profileKey: string,
  mode: EngagementMode,
  insertion: string,
) {
  const key = profileKey.trim().replace(/^@+/, "").toLowerCase();
  const tokens = parseAgentRequestTokensFromBody(body).filter((token) => token.profileKey === key);
  let next = body;
  if (tokens.length === 0) {
    next = body.trim().length ? `${body.replace(/\s+$/, "")}\n\n${insertion}` : insertion;
  }
  // Include newly inserted mentions and edit right-to-left so offsets stay valid.
  for (const token of parseAgentRequestTokensFromBody(next)
    .filter((item) => item.profileKey === key)
    .reverse()) {
    if (token.modeStart != null && token.modeEnd != null) {
      next = `${next.slice(0, token.modeStart)}/${mode.toLowerCase()}${next.slice(token.modeEnd)}`;
    } else {
      next = `${next.slice(0, token.mentionEnd)} /${mode.toLowerCase()}${next.slice(token.mentionEnd)}`;
    }
  }
  return { body: next, profileKey: key, override: { mode, assignIssue: false } };
}

/** The same explicit requests drive visible chips and the submitted payload. */
export function resolveComposerAgentRequests(body: string, overrides: AgentRequestOverrides) {
  return parseAgentRequestsFromBody(body).map((request) => {
    const override = overrides[request.profileKey.toLowerCase()];
    const mode = override?.mode ?? request.mode;
    return {
      ...request,
      mode,
      assignIssue: mode === "EXECUTE" && (override?.assignIssue ?? request.assignIssue) === true,
    };
  });
}
