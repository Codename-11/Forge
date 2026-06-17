import type { EngagementMode } from "@prisma/client";

/**
 * First-class agent request parsed from a comment body or supplied
 * explicitly by the composer.
 */
export interface ParsedAgentRequest {
  /** The agent profile key as typed by the user, e.g. "victor" */
  profileKey: string;
  /** Resolved EngagementMode — always uppercase */
  mode: EngagementMode;
  /** Only meaningful when mode === EXECUTE; signals the caller wants
   *  to assign the issue to this agent. */
  assignIssue?: boolean;
}

const MENTION_RE = /@([a-zA-Z0-9_-]+)(?:[: ] *(\/?(?:execute|research|review|discuss)))?/g;
const SLASH_MODE_RE = /^\/(execute|research|review|discuss)$/i;

/**
 * Scan raw markdown for `@agent /mode` or `@agent:mode` tokens.
 * Returns one ParsedAgentRequest per unique agent mention (first mode wins).
 */
export function parseAgentRequestsFromBody(body: string): ParsedAgentRequest[] {
  const out: ParsedAgentRequest[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const key = m[1].toLowerCase();
    const modeToken = m[2]?.toLowerCase().replace(/^\//, "");
    const mode = normMode(modeToken) ?? "DISCUSS";
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ profileKey: key, mode: mode as EngagementMode });
    }
  }
  return out;
}

/**
 * Given an explicit structured list (from the composer chips) and a raw
 * body, return the canonical list to persist.
 * - If explicit is non-empty, trust it (composer is source of truth).
 * - Otherwise fall back to text-parse.
 */
export function resolveAgentRequests(
  explicit: ParsedAgentRequest[],
  body: string,
): ParsedAgentRequest[] {
  if (explicit.length > 0) return explicit;
  return parseAgentRequestsFromBody(body);
}

function normMode(token: string | undefined): EngagementMode | null {
  if (!token) return null;
  const up = token.toUpperCase();
  if (up === "EXECUTE" || up === "RESEARCH" || up === "REVIEW" || up === "DISCUSS") {
    return up as EngagementMode;
  }
  return null;
}

/** Detect a stand-alone /mode line (our older “power-user” syntax). */
export function isAgentRequestSlashCommand(body: string): EngagementMode | null {
  const first = body.trimStart().split(/\s/)[0];
  const m = SLASH_MODE_RE.exec(first);
  return m ? (m[1].toUpperCase() as EngagementMode) : null;
}

/** Build a readable line like "Victor · Review" for timeline rendering. */
export function formatAgentRequestLine(agentName: string, mode: EngagementMode): string {
  const labels: Record<string, string> = {
    EXECUTE: "Execute",
    RESEARCH: "Research",
    REVIEW: "Review",
    DISCUSS: "Discuss",
  };
  return `${agentName} · ${labels[mode] ?? mode}`;
}
