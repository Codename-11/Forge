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

export interface AgentRequestToken extends ParsedAgentRequest {
  /** Span of the full mention token, including `@`. */
  mentionStart: number;
  mentionEnd: number;
  /** Span of the typed mode marker (`/review`, `review`, `execute`, ...), when present. */
  modeStart: number | null;
  modeEnd: number | null;
  /** The exact typed mode marker, useful for composer highlighting. */
  rawMode: string | null;
}

const MENTION_TOKEN_RE = /(^|[\s(,.;:!?])@([a-zA-Z0-9_-]+)/g;
const WORD_RE = /^[a-zA-Z]+/;
const SLASH_MODE_RE = /^\/(execute|research|review|discuss)$/i;
const MODE_VALUES = new Set(["EXECUTE", "RESEARCH", "REVIEW", "DISCUSS"]);

/**
 * Scan raw markdown for `@agent`, `@agent /mode`, `@agent:mode`, or
 * `@agent mode` tokens. The richer token form is shared by server-side
 * persistence and the composer highlight layer so "what lights up" and
 * "what gets submitted" stay in sync.
 */
export function parseAgentRequestTokensFromBody(body: string): AgentRequestToken[] {
  const out: AgentRequestToken[] = [];
  const re = new RegExp(MENTION_TOKEN_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const boundary = m[1] ?? "";
    const key = m[2].toLowerCase();
    const mentionStart = m.index + boundary.length;
    const mentionEnd = mentionStart + 1 + m[2].length;
    const modeHit = readModeAfterMention(body, mentionEnd);
    out.push({
      profileKey: key,
      mode: (modeHit?.mode ?? "DISCUSS") as EngagementMode,
      mentionStart,
      mentionEnd,
      modeStart: modeHit?.start ?? null,
      modeEnd: modeHit?.end ?? null,
      rawMode: modeHit?.raw ?? null,
    });
  }
  return out;
}

/**
 * Scan raw markdown for one ParsedAgentRequest per unique agent mention
 * (first mention wins). Plain @agent defaults to DISCUSS; typed mode words
 * are power-user sugar over the same structured request.
 */
export function parseAgentRequestsFromBody(body: string): ParsedAgentRequest[] {
  const out: ParsedAgentRequest[] = [];
  const seen = new Set<string>();
  for (const token of parseAgentRequestTokensFromBody(body)) {
    const key = token.profileKey.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ profileKey: key, mode: token.mode });
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

function readModeAfterMention(
  body: string,
  mentionEnd: number,
): { mode: EngagementMode; start: number; end: number; raw: string } | null {
  let i = mentionEnd;
  const first = body[i];
  if (first === ":") {
    i += 1;
    while (body[i] === " " || body[i] === "\t") i += 1;
  } else if (/\s/.test(first ?? "")) {
    while (/\s/.test(body[i] ?? "")) i += 1;
  } else {
    return null;
  }

  const tokenStart = body[i] === "/" ? i : i;
  const wordStart = body[i] === "/" ? i + 1 : i;
  const wordMatch = WORD_RE.exec(body.slice(wordStart));
  if (!wordMatch) return null;

  const word = wordMatch[0];
  const wordEnd = wordStart + word.length;
  // Require a real word boundary so "reviewing" does not become REVIEW.
  if (/[A-Za-z0-9_-]/.test(body[wordEnd] ?? "")) return null;

  const mode = normMode(word);
  if (!mode) return null;
  return {
    mode,
    start: tokenStart,
    end: wordEnd,
    raw: body.slice(tokenStart, wordEnd),
  };
}

function normMode(token: string | undefined): EngagementMode | null {
  if (!token) return null;
  const up = token.toUpperCase();
  if (MODE_VALUES.has(up)) return up as EngagementMode;
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
