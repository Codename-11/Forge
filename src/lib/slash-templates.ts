/**
 * Slash TEMPLATES — quick-comment expanders for the issue-detail
 * comment composer.
 *
 * Templates differ from the structured slash commands in
 * `src/lib/slash-commands.ts`:
 *
 * - Slash COMMANDS (`/assign`, `/priority`, …) are parsed off the top
 *   of the body and applied as side-effects on the resulting comment.
 *   They modify the issue, not the comment text.
 * - Slash TEMPLATES (`/status`, `/blocked`, `/approve`, `/handoff`)
 *   REPLACE the cursor's current line with a templated body and may
 *   ALSO inject a real slash command (e.g. `/handoff @victor` injects
 *   a `/assign @victor` at the top) or fire a separate mutation on
 *   submit (e.g. `/blocked` opens an action-request).
 *
 * The autocomplete dropdown unions the two surfaces so the operator
 * sees them in one list. The hook in `slash-autocomplete.tsx`
 * distinguishes them by kind when the user picks one.
 *
 * Design goals (Linear's quick actions are the north-star):
 *   - Zero modal dialogs. Pick → text expands → operator can keep typing.
 *   - Argument parsing is best-effort: a template's `parse` returns the
 *     extracted args from the line the user typed. The keyword may be
 *     followed by free-form text the user will fill in.
 *   - Side-effects are described as a structured `SideEffect` shape so
 *     the composer can dispatch them after the comment lands without
 *     the template having to know about tRPC.
 */

/**
 * A side-effect a template wants to fire alongside the comment.
 *
 * - `none`: just text.
 * - `actionRequest`: open a FREE_FORM action request on the issue.
 *   Title is supplied; body comes from the comment itself.
 * - The reassignment case is NOT modeled here — `/handoff @victor`
 *   leans on the existing `/assign @victor` command parser, which the
 *   server already handles via `issue.applyCommands`. The template
 *   simply injects an `/assign` line at the top of the body.
 */
export type SlashTemplateSideEffect =
  | { kind: "none" }
  | { kind: "actionRequest"; title: string };

/**
 * The result of applying a template to the line the user typed.
 */
export interface SlashTemplateExpansion {
  /**
   * The text that REPLACES the user's current line. Multi-line is
   * allowed. May include a leading `/assign @x` etc. so the server
   * picks it up as a real slash command on submit.
   */
  body: string;
  /** Where the caret should land within `body`, measured from start. */
  caretOffset: number;
  /** Any extra mutation the composer should fire after the comment lands. */
  sideEffect: SlashTemplateSideEffect;
}

export interface SlashTemplate {
  /** Keyword including the leading `/`. */
  keyword: string;
  /** One-line shown next to the keyword in the autocomplete dropdown. */
  description: string;
  /**
   * Example shown in the dropdown right column. Mirrors the shape of
   * `SLASH_COMMAND_HELP` so the autocomplete UI can mix both surfaces.
   */
  example: string;
  /**
   * Optional argument shape. Templates with `args: "agent"` expect an
   * `@handle` after the keyword (e.g. `/handoff @victor`); the
   * autocomplete keeps the dropdown open until the operator commits
   * the line.
   */
  args?: "agent" | "free";
  /**
   * Expand the template into a body + side-effect. `argText` is
   * everything after the keyword on the typed line, trimmed (e.g.
   * `"@victor working on auth"` for `/handoff @victor working on auth`).
   * Returns `null` if the args are required but missing — the
   * autocomplete uses this to short-circuit on Enter and keep typing
   * mode open.
   */
  expand: (argText: string) => SlashTemplateExpansion | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a leading `@handle` token from `argText`. Returns
 * `{ handle, rest }` or `null` if the first non-whitespace word
 * doesn't look like an `@`-prefixed handle.
 */
function extractAgentHandle(
  argText: string,
): { handle: string; rest: string } | null {
  const m = argText.trim().match(/^@?([a-z0-9_-]{1,64})(.*)$/i);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  const rest = m[2].trim();
  if (!handle) return null;
  return { handle, rest };
}

/**
 * Sentinel inserted where the caret should land after a template
 * expansion. We splice it out of the final body and use its index as
 * the caret position. Picked deliberately weird so a user typing it
 * literally is exceedingly unlikely.
 */
const CARET_MARKER = "​__FORGE_CARET__​";

/**
 * Build an expansion result by parsing a template-shaped string with a
 * single `${cursor}` marker.
 */
function withCaret(template: string, sideEffect: SlashTemplateSideEffect): SlashTemplateExpansion {
  const idx = template.indexOf(CARET_MARKER);
  const body = template.replace(CARET_MARKER, "");
  return {
    body,
    caretOffset: idx >= 0 ? idx : body.length,
    sideEffect,
  };
}

// ---------------------------------------------------------------------------
// Template catalogue
// ---------------------------------------------------------------------------

export const SLASH_TEMPLATES: ReadonlyArray<SlashTemplate> = [
  {
    keyword: "/status",
    description: "Working-on update",
    example: "/status",
    args: "free",
    expand: (argText) => {
      const rest = argText.trim();
      const tail = rest.length > 0 ? rest : CARET_MARKER;
      return withCaret(`**Status:** Working on ${tail}`, { kind: "none" });
    },
  },
  {
    keyword: "/blocked",
    description: "Flag a blocker (opens unblock request)",
    example: "/blocked <reason>",
    args: "free",
    expand: (argText) => {
      const rest = argText.trim();
      const tail = rest.length > 0 ? rest : CARET_MARKER;
      return withCaret(
        `**Blocked:** ${tail}`,
        { kind: "actionRequest", title: "Unblock needed" },
      );
    },
  },
  {
    keyword: "/approve",
    description: "Approve / sign-off",
    example: "/approve",
    expand: () => {
      return withCaret(`**Approved** ✓${CARET_MARKER}`, { kind: "none" });
    },
  },
  {
    keyword: "/handoff",
    description: "Hand off to an agent (reassigns)",
    example: "/handoff @victor",
    args: "agent",
    expand: (argText) => {
      const parsed = extractAgentHandle(argText);
      if (!parsed) return null;
      const { handle, rest } = parsed;
      const tail = rest.length > 0 ? rest : CARET_MARKER;
      // Inject a real `/assign` command at the top of the body — the
      // existing comment-create flow strips it and the server applies
      // the reassignment via `issue.applyCommands`. The visible
      // handoff sentence stays in the comment body itself.
      return withCaret(
        `/assign @${handle}\n**Handing off to @${handle}:** ${tail}`,
        { kind: "none" },
      );
    },
  },
];

/**
 * Help-row shape that matches `SLASH_COMMAND_HELP` from
 * `slash-commands.ts` — same `{ keyword, example }` so the
 * autocomplete dropdown can mix templates and commands without
 * branching per row.
 */
export const SLASH_TEMPLATE_HELP: ReadonlyArray<{
  keyword: string;
  example: string;
}> = SLASH_TEMPLATES.map((t) => ({
  keyword: t.keyword,
  example: t.example,
}));

/**
 * Look up a template by its keyword (with leading slash).
 */
export function findTemplate(keyword: string): SlashTemplate | null {
  const k = keyword.toLowerCase();
  return SLASH_TEMPLATES.find((t) => t.keyword.toLowerCase() === k) ?? null;
}

/**
 * Given the full line the user has on the current row of the
 * composer (no trailing newline), attempt to expand it as a template.
 * Returns `null` if the line doesn't start with a template keyword,
 * if the template requires args that aren't present, or if the
 * arguments don't parse.
 */
export function expandTemplateLine(line: string): {
  template: SlashTemplate;
  expansion: SlashTemplateExpansion;
} | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^(\/[a-z]+)(\s+(.*))?$/i);
  if (!match) return null;
  const keyword = match[1].toLowerCase();
  const argText = (match[3] ?? "").trim();
  const template = findTemplate(keyword);
  if (!template) return null;
  const expansion = template.expand(argText);
  if (!expansion) return null;
  return { template, expansion };
}

/**
 * Body-pass: scan the comment body for any template lines and expand
 * them in place, accumulating side-effects to fire after the comment
 * lands. Only inspects standalone lines that begin with `/` — same
 * top-of-body discipline as `parseSlashCommands`, since templates and
 * commands share the leading-block UX. Fenced code blocks are
 * preserved verbatim (mirrors `parseSlashCommands`'s fenced-aware
 * abort: if the body starts with a code fence we don't touch it).
 *
 * Returns:
 *   - `expandedBody`: the body with each template line replaced by
 *     its expansion body. Note expansions may inject a real slash
 *     command (e.g. `/handoff @x` → `/assign @x\n…`) — that's
 *     intentional, the regular `parseSlashCommands` pass then picks
 *     it up.
 *   - `sideEffects`: each non-`none` `sideEffect` in document order.
 *     Composer dispatches these after the comment lands.
 */
export function expandTemplatesInBody(body: string): {
  expandedBody: string;
  sideEffects: SlashTemplateSideEffect[];
} {
  const sideEffects: SlashTemplateSideEffect[] = [];
  if (/^\s*```/.test(body)) {
    return { expandedBody: body, sideEffects };
  }
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  // Only expand contiguous top-of-body slash lines so an `/blocked`
  // typed mid-paragraph (e.g. in a quoted passage) isn't rewritten.
  let inTopBlock = true;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (inTopBlock && trimmed.startsWith("```")) {
      // Stop the top-of-body block at the first fence — don't expand
      // anything past it.
      inTopBlock = false;
      out.push(line);
      i += 1;
      continue;
    }
    if (inTopBlock && trimmed.startsWith("/")) {
      const result = expandTemplateLine(trimmed);
      if (result) {
        out.push(result.expansion.body);
        if (result.expansion.sideEffect.kind !== "none") {
          sideEffects.push(result.expansion.sideEffect);
        }
        i += 1;
        continue;
      }
      // Recognised-shape slash that's NOT a template — leave it for
      // `parseSlashCommands` to handle.
      out.push(line);
      i += 1;
      continue;
    }
    if (trimmed !== "") inTopBlock = false;
    out.push(line);
    i += 1;
  }
  return { expandedBody: out.join("\n"), sideEffects };
}
