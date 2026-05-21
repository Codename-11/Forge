/**
 * `:::data <kind>` directive matcher.
 *
 * Agents emit structured payloads inline with prose by wrapping a JSON
 * body in a fenced data directive:
 *
 *     :::data table
 *     { "headers": ["Tool", "OK?"], "rows": [["x", "y"]] }
 *     :::
 *
 * The renderer scans the markdown line-by-line at block-parse time. When
 * we hit a `:::data <kind>` opener we slurp until the closing `:::` and
 * try to JSON.parse the inner body. Anything that fails validation falls
 * back to a code-fenced block with an "invalid :::data" warning chip —
 * we never just drop or crash on bad input.
 *
 * Three kinds are recognized in v1: `table`, `list`, `kv`. New kinds add
 * a row to `DATA_BLOCK_KINDS` and a discriminated branch on `DataBlock`.
 */

export type DataBlockAlign = "left" | "center" | "right";

export type DataBlockTablePayload = {
  /** Required ordered headers. */
  headers: string[];
  /** Body rows; each row's length is padded/truncated to `headers.length`. */
  rows: (string | number | boolean | null)[][];
  /**
   * Per-column alignment. Length is reconciled to `headers.length`;
   * missing entries default to `left`. Extra entries are ignored.
   */
  align?: (DataBlockAlign | null)[];
  /** Optional title rendered above the table. */
  caption?: string;
};

export type DataBlockListPayload = {
  /** When true, render as `<ol>` instead of `<ul>`. */
  ordered?: boolean;
  /**
   * Items. Either bare strings or `{ text, badge? }` objects so an agent
   * can attach a single-token tag to each line (e.g. "✓", "WIP",
   * priority labels).
   */
  items: (string | { text: string; badge?: string | null })[];
};

export type DataBlockKVPayload = {
  /** Optional caption rendered above the strip. */
  caption?: string;
  /**
   * Either a plain `{key: value}` object (insertion-order preserved by
   * JSON.parse) or an explicit `[{key, value}]` array when the agent
   * needs duplicate keys or a stable ordering they control.
   */
  pairs:
    | Record<string, string | number | boolean | null>
    | { key: string; value: string | number | boolean | null }[];
};

export type DataBlock =
  | { kind: "table"; payload: DataBlockTablePayload }
  | { kind: "list"; payload: DataBlockListPayload }
  | { kind: "kv"; payload: DataBlockKVPayload };

export const DATA_BLOCK_KINDS = ["table", "list", "kv"] as const;
export type DataBlockKind = (typeof DATA_BLOCK_KINDS)[number];

/** Lazy regex — `^:::data <kind>$` at the start of a line. */
const OPEN_RE = /^:::data\s+([a-z][a-z0-9-]*)\s*$/i;
const CLOSE_RE = /^:::\s*$/;

export type DataBlockParseResult =
  | { ok: true; block: DataBlock; consumed: number }
  | { ok: false; raw: string; reason: string; consumed: number };

/**
 * Try to consume a `:::data <kind>` block starting at `lines[start]`.
 * Returns either a parsed block or a structured failure (so the caller
 * can render a fallback code block with a warning chip).
 *
 * `consumed` is the number of input lines absorbed — including the
 * opener and closer. On failure it equals the count we scanned before
 * giving up (so the block-parser advances past the bad opener instead
 * of looping).
 */
export function tryParseDataBlock(
  lines: string[],
  start: number,
): DataBlockParseResult | null {
  const open = lines[start];
  const m = open.match(OPEN_RE);
  if (!m) return null;
  const kind = m[1].toLowerCase();

  // Find the closing `:::` on its own line. If we run off the end of
  // the input we treat the rest of the doc as the block body — the
  // user almost certainly forgot the closer.
  let j = start + 1;
  const bodyLines: string[] = [];
  while (j < lines.length && !CLOSE_RE.test(lines[j])) {
    bodyLines.push(lines[j]);
    j++;
  }
  const closed = j < lines.length;
  const consumed = closed ? j - start + 1 : j - start;
  const rawBody = bodyLines.join("\n");
  const raw = lines.slice(start, start + consumed).join("\n");

  if (!isKnownKind(kind)) {
    return {
      ok: false,
      raw,
      reason: `unknown :::data kind "${kind}"`,
      consumed,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    return {
      ok: false,
      raw,
      reason: `JSON parse failed: ${(e as Error).message}`,
      consumed,
    };
  }

  const validated = validate(kind, parsed);
  if ("error" in validated) {
    return { ok: false, raw, reason: validated.error, consumed };
  }
  return { ok: true, block: validated.block, consumed };
}

function isKnownKind(k: string): k is DataBlockKind {
  return (DATA_BLOCK_KINDS as readonly string[]).includes(k);
}

type Validated =
  | { block: DataBlock }
  | { error: string };

function validate(kind: DataBlockKind, raw: unknown): Validated {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "payload must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  if (kind === "table") {
    const headers = r.headers;
    const rows = r.rows;
    if (!Array.isArray(headers) || headers.some((h) => typeof h !== "string")) {
      return { error: "table.headers must be an array of strings" };
    }
    if (!Array.isArray(rows)) {
      return { error: "table.rows must be an array of arrays" };
    }
    const cleanRows: (string | number | boolean | null)[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        return { error: "table.rows entries must be arrays" };
      }
      const cleanRow: (string | number | boolean | null)[] = [];
      for (const cell of row) {
        if (
          cell === null ||
          typeof cell === "string" ||
          typeof cell === "number" ||
          typeof cell === "boolean"
        ) {
          cleanRow.push(cell);
        } else {
          // Coerce nested objects/arrays to their JSON representation so
          // a malformed cell doesn't break the table layout.
          cleanRow.push(JSON.stringify(cell));
        }
      }
      cleanRows.push(cleanRow);
    }
    let align: (DataBlockAlign | null)[] | undefined = undefined;
    if (Array.isArray(r.align)) {
      align = (r.align as unknown[]).map((a) => {
        if (a === "left" || a === "center" || a === "right") return a;
        return null;
      });
    }
    const caption = typeof r.caption === "string" ? r.caption : undefined;
    return {
      block: {
        kind: "table",
        payload: { headers: headers as string[], rows: cleanRows, align, caption },
      },
    };
  }

  if (kind === "list") {
    if (!Array.isArray(r.items)) {
      return { error: "list.items must be an array" };
    }
    const items: (string | { text: string; badge?: string | null })[] = [];
    for (const it of r.items) {
      if (typeof it === "string") {
        items.push(it);
        continue;
      }
      if (it && typeof it === "object" && !Array.isArray(it)) {
        const obj = it as Record<string, unknown>;
        if (typeof obj.text !== "string") {
          return { error: "list item objects need a string `text`" };
        }
        const badge =
          typeof obj.badge === "string"
            ? obj.badge
            : obj.badge == null
              ? null
              : String(obj.badge);
        items.push({ text: obj.text, badge });
        continue;
      }
      return { error: "list items must be strings or {text, badge?}" };
    }
    const ordered = r.ordered === true;
    return { block: { kind: "list", payload: { ordered, items } } };
  }

  // kv
  const caption = typeof r.caption === "string" ? r.caption : undefined;
  if (Array.isArray(r.pairs)) {
    const pairs: { key: string; value: string | number | boolean | null }[] = [];
    for (const p of r.pairs) {
      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        typeof (p as Record<string, unknown>).key !== "string"
      ) {
        return { error: "kv.pairs[] entries need a string `key`" };
      }
      const obj = p as Record<string, unknown>;
      const value = coerceScalar(obj.value);
      pairs.push({ key: obj.key as string, value });
    }
    return { block: { kind: "kv", payload: { pairs, caption } } };
  }
  if (r.pairs && typeof r.pairs === "object") {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(r.pairs as Record<string, unknown>)) {
      out[k] = coerceScalar(v);
    }
    return { block: { kind: "kv", payload: { pairs: out, caption } } };
  }
  return { error: "kv.pairs must be an object or array of {key,value}" };
}

function coerceScalar(v: unknown): string | number | boolean | null {
  if (v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  // Nested arrays/objects: stringify so they at least render as text.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
