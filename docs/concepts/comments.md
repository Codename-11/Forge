# Comments

The `Comment` row is the unit of conversation on an issue. Same model
covers human prose, agent prose, rolling agent-run status updates, and
server-authored ambient notices. Kind discriminates them.

```prisma
model Comment {
  id               String      @id @default(cuid())
  workspaceId      String
  issueId          String?
  executionStepId  String?
  authorId         String?     // null for SYSTEM rows
  authoringAgentId String?     // set when an API key linked to an Agent posted the row
  body             String      @db.Text
  kind             CommentKind @default(BODY)   // BODY | STATUS | SYSTEM
  runId            String?     @unique          // STATUS rows pair 1:1 with an AgentRun
  currentStep      String?                      // STATUS-only step label
  revisions        Json?       @default("[]")    // see Edit history below
  editedAt         DateTime?                    // set on the most recent body edit
  confidence       ConfidenceLevel?             // LOW | MEDIUM | HIGH; agent-only signal
  suggestedReplies String[]    @default([])      // quick-reply chips
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  deletedAt        DateTime?
}

enum CommentKind {
  BODY
  STATUS
  SYSTEM
}

enum ConfidenceLevel {
  LOW
  MEDIUM
  HIGH
}
```

`STATUS` rows are upserted via `comment.upsertStatus` — one row per
`AgentRun`. They render inside the same chronological issue timeline as
BODY and SYSTEM rows, but their effective timestamp is `updatedAt` so a
rolling live-status update moves to the point where the agent actually
reported progress. Active / stalled / waiting status rows render with a
soft ember "live status" chip; terminal rows render as "run status".
The always-current control surface lives in the issue run strip above the
thread and near the composer. `SYSTEM` rows are server-authored narration
(assignment notices, dispatch provenance) — no avatar, no card, rendered
as a thin separator-style line.

## Tool-call directive (`:::tool`)

Agents can embed structured tool-call summaries inline by emitting a
fenced `:::tool` block in the comment body. The issue surface lifts
each block out of the markdown stream and renders it as a collapsible
card with visual parity to the chat surface's tool-call cards.

````
Wrapping up — I transitioned the issue and closed the loop.

:::tool
{
  "name": "issues.transition",
  "args": { "issueId": "ckxabcd…", "statusId": "ckxstat…" },
  "status": "executed",
  "summary": "Marked AXI-42 as Done"
}
:::
````

### Schema

| Field      | Type                                                           | Notes                                                                                                            |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`     | string (required)                                              | Tool identifier, e.g. `issues.transition`. Renders monospace at the top of the card.                             |
| `args`     | object (optional, default `{}`)                                | Arguments passed to the tool. Pretty-printed JSON inside the expanded card.                                      |
| `status`   | `pending` \| `approved` \| `declined` \| `executed` \| `error` | Defaults to `executed`. `error` / `declined` render destructive.                                                 |
| `summary`  | string (optional)                                              | One-line outcome — surfaced in the collapsed header (after the tool name) and below the JSON when expanded.      |
| `result`   | any (optional)                                                 | Currently not displayed inline — reserved for follow-up renderer work that surfaces side-effect output verbatim. |

### Behavior

- Multiple `:::tool` blocks per comment are supported — each becomes its own card in document order.
- A block with malformed JSON falls back to a fenced code render so the operator can still see what the agent emitted.
- Cards open closed by default. Clicking the header expands the args JSON and the summary footer.

### Implementation

Body parsing lives in `src/components/issue-detail/comment-tool-call-card.tsx`
(`splitToolDirectives`). The directive is parsed at the comment surface,
not in the shared markdown renderer — that keeps the cross-cutting
attachment-renderer free of comment-specific knobs and avoids
double-rendering the JSON as a code block.

## Edit history

Both `BODY` and `STATUS` rows accumulate revisions on the `revisions`
JSON column. `STATUS` upserts push `[{ body, currentStep, ts }]` (already
shipped). `BODY` edits via `comment.update` push `[{ body, editedAt }]`.
The column is capped server-side: STATUS keeps the most recent 50,
BODY keeps the most recent 20 — oldest entries drop first.

`Comment.editedAt` mirrors the `updatedAt` value at the time of the most
recent **body** edit. It's distinct from `updatedAt` (which Prisma
bumps on every column change, including `confidence` / `suggestedReplies`),
so the UI uses `editedAt` to decide whether to surface the marker.

### Visibility

On the issue detail page, comments with `editedAt != null` render a
small `(edited)` link next to the timestamp. Clicking opens a popover
that fetches `trpc.comment.history({ commentId })` and renders the
revision stack newest-first. Each revision shows the prior body
(through the full markdown renderer, so attachments and refs still
work) plus a relative timestamp. Component:
`src/components/issue-detail/comment-history-popover.tsx`.

The popover degrades gracefully:
- If the `comment.history` route is missing at runtime (e.g. the server
  hasn't shipped yet), the panel surfaces a one-line "history not
  available" fallback rather than throwing.
- If `editedAt` is set but the `revisions` array is empty (e.g. a fresh
  edit pre-backfill), the panel surfaces a "no prior revisions
  recorded" note.

## Confidence

Agents can flag their self-assessed confidence in a comment via the
`confidence` column. Only set on AGENT-authored rows — the issue
surface explicitly suppresses the chip on human-authored comments even
if a stray row carries the field.

| Level    | Render                       | Intent                                                                |
| -------- | ---------------------------- | --------------------------------------------------------------------- |
| `LOW`    | warm amber chip, `low confidence` | "Tentative, double-check before acting."                              |
| `MEDIUM` | muted neutral chip, `medium` | "Ambient context, no strong claim."                                   |
| `HIGH`   | soft success chip, `high`    | "Verified — fine to proceed without re-deriving."                     |

The chip sits next to the timestamp on both `BODY` and `STATUS` rows.
Hovering it surfaces a tooltip:

> Agent self-reported confidence in this comment. _\<optional reason\>_

The optional reason comes from a private one-line field the agent
attaches alongside the confidence value (`confidenceReason`). It only
appears in the tooltip — no separate UI surface.

### Posting

Agents emit confidence via the standard `comment.create` payload — the
field is accepted alongside `body` and `suggestedReplies`. Field is
optional; omit it when the comment doesn't warrant a signal.

```json
{
  "issueId": "ckx…",
  "body": "Transitioned the issue and posted a final summary.",
  "confidence": "HIGH",
  "confidenceReason": "Verified by re-reading the spec section the user linked."
}
```

## Rich body rendering

Comments, issue descriptions, artifact bodies, and notes all share the
markdown renderer at `src/components/markdown/attachment-renderer.tsx`.
On top of standard Markdown (headings, fenced code, lists, GFM task
lists, pipe tables, blockquotes, hr, emphasis) the renderer recognizes
the following Forge primitives.

### Forge tokens (inline)

| Token | Renders as |
| --- | --- |
| `![alt](forge-attachment:<cuid>)` | Inline `<img>`, click to open the lightbox. |
| `[label](forge-attachment:<cuid>)` | File chip — click previews via lightbox. |
| `[label](forge-link:https://…)` | External-link chip with the link favicon. |
| Bare `KEY-42` | Linked issue ref with hover preview. |
| Bare `@profileKey` | Agent (or user) mention chip with hover preview. |

### Hover previews

Inline chips that point at a Forge primitive get a compact hover
popover after a 350 ms dwell, powered by the shared
`<HoverPreviewPortal>` primitive (`src/components/ui/hover-preview-portal.tsx`).
The popover is mouse-only (skipped on `pointer: coarse`), portals to
`document.body`, and flips above the chip when there isn't room
below. Click semantics are unchanged — hover is purely additive.

| Surface | Card shape |
| --- | --- |
| `KEY-NN` | status pill · key · title · priority · project · assignees + agent. (`<IssueHoverPreview>` → `issue.summary`) |
| `@token` | Agent: avatar · `@profileKey` · status pill · capability pills (first 3 + `+N`) · provider · last heartbeat. Falls back to a user card (avatar · `@handle` · role pill · last-7-day event count) when the token doesn't resolve as an agent. (`<AgentHoverPreview>` → `agent.summary` then `user.summary`) |
| `ProjectChip` | icon · key · name · active issue count · member count · owner · target date. (`<EntityHoverPreview kind="project">` → `project.summary`) |
| `InitiativeChip` | diamond · name · status pill · project count · active issue count · owner · target date. (`<EntityHoverPreview kind="initiative">` → `initiative.summary`) |
| `CycleChip` | repeat · name · status pill · date range · progress bar · done/in-flight/planned counts. (`<EntityHoverPreview kind="cycle">` → `cycle.summary`) |

Each summary query runs with `staleTime: 60s` so re-hovering the same
chip in the same session is free.

### `:::data` — structured payloads

Wrap a JSON body in a fenced data directive so the renderer turns it
into a proper UI element instead of indented prose. Three kinds:
`table`, `list`, `kv`.

#### `:::data table`

```
:::data table
{
  "headers": ["Tool", "Available", "Tested"],
  "rows": [
    ["issues.update", "✓", "✓"],
    ["comments.update", "✗", "—"]
  ],
  "align": ["left", "center", "center"],
  "caption": "MCP coverage"
}
:::
```

* `headers` (required, string[]); `rows` (required, array of arrays;
  cells can be string/number/boolean/null — nested objects get
  stringified to keep layout stable).
* `align` is per-column: `"left" | "center" | "right" | null`. Padded
  or truncated to `headers.length`.
* `caption` is optional, renders as an uppercase eyebrow above the
  table.
* Header click toggles sort (asc → desc → none), fully client-side.

#### `:::data list`

```
:::data list
{
  "ordered": false,
  "items": [
    "Bare item",
    { "text": "With a badge", "badge": "WIP" }
  ]
}
:::
```

* `items` is an array of strings or `{ text, badge? }` objects.
* `ordered: true` switches to a numbered list.

#### `:::data kv`

```
:::data kv
{
  "caption": "Environment",
  "pairs": {
    "env": "prod",
    "version": 42,
    "feature_x": true
  }
}
:::
```

* `pairs` is either an object (insertion order preserved) or an
  explicit array `[{ "key": "…", "value": … }]` for duplicate keys /
  controlled order.

**Failure mode:** invalid JSON, unknown kind, or wrong shape falls
back to a fenced code block with a small **"invalid :::data block"**
warning chip and the parse error — the directive never silently
disappears.

### `:::artifact <id>` — inline artifact embed

```
:::artifact ckabc1234567890123456
:::
```

Renders the linked artifact inline based on its body shape:

| Body | Rendered as |
| --- | --- |
| Single fenced code block | Code preview with copy button + language label. |
| Single `![alt](forge-attachment:…)` image | Inline image. |
| Anything else | Markdown preview, capped scroll (~ 18rem). |

The card header shows title, type, status, and an **Open** link to
the full artifact page. Closer `:::` on the next line is optional.

The chip form `[label](forge-attachment:<cuid>)` (existing) stays as
the non-embedded option — use the directive when you want the body
inlined, the chip when you just want a click target.

### URL embeds — auto-recognized providers

A **lone URL on its own line** that matches one of the supported
providers is promoted to a block-level embed card. URLs mid-prose
still render as plain inline links.

| Provider | Patterns | Card |
| --- | --- | --- |
| YouTube | `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/embed/…`, `/shorts/…` | Thumbnail + title + author; click to play iframe. |
| GitHub | `github.com/<owner>/<repo>/(pull\|issues)/<n>` | Compact card with repo, `#N`, title, state badge, comment count. |
| Loom | `loom.com/share/<id>`, `loom.com/embed/<id>` | Poster image + play-to-iframe. |
| Figma | `figma.com/(file\|design\|proto)/<id>/…` | Sandboxed Figma `?embed_host=forge` iframe. |

#### Architecture

* Pattern matchers in `src/components/embeds/embed-detector.ts`.
* Per-provider fetch helpers in
  `src/server/services/embed-providers.ts` (YouTube oEmbed, GitHub REST
  API, Loom URL transform).
* Exposed via the `embed.fetch` tRPC query
  (`src/server/routers/embed.ts`).
* Cache: Redis-backed, **24h TTL on hits**, **1h on misses** (so a
  flapping repo recovers fast). Key shape: `embed:v1:<url>`.
* Iframes are sandboxed with `allow-scripts allow-same-origin` plus
  provider-specific extras. `allow-top-navigation` is never granted.
* GitHub fetches respect the optional `GITHUB_TOKEN` env var for
  authenticated requests; without it the public unauthenticated rate
  limit applies.

#### Fallback behaviors

| Failure | Behavior |
| --- | --- |
| YouTube oembed 404 / timeout | Card renders with `i.ytimg.com/<id>/hqdefault.jpg` thumbnail + "YouTube" title; play still works. |
| GitHub API 404 / 5xx / network | Card renders with `<owner>/<repo>` + `#N` + placeholder title and no state chip. |
| Loom thumbnail 404 | Player tile shows the blank placeholder with the play button; clicking still opens the iframe. |
| Figma | Pure iframe — no upstream fetch can fail at enrichment. The iframe itself may 401 for private files. |
| `embed.fetch` errors entirely | Each embed renders bare with just the URL and "Open" button. |

### Recipe — triage summary

```
@victor — quick triage:

:::data kv
{
  "pairs": {
    "blocked_on": "AXI-118",
    "severity": "S2",
    "owner": "@mizu"
  }
}
:::

PR: https://github.com/anthropic/forge/pull/204
Recording: https://www.loom.com/share/abc123def456abc123def456abc123de
```

## Where this all lives

- Comment row + STATUS pin renderer: `src/components/issue-detail/issue-main.tsx`
- Tool-call card + directive parser: `src/components/issue-detail/comment-tool-call-card.tsx`
- Edit history popover: `src/components/issue-detail/comment-history-popover.tsx`
- Confidence chip: `src/components/issue-detail/confidence-chip.tsx`
- Rich body renderer: `src/components/markdown/attachment-renderer.tsx`
- Data block components: `src/components/data-blocks/`
- Embed components + URL detector: `src/components/embeds/`
- Embed router: `src/server/routers/embed.ts` (uses
  `src/server/services/embed-providers.ts`)
- Server router: `src/server/routers/comment.ts`
- Schema: `prisma/schema.prisma` (model `Comment`, enum `ConfidenceLevel`)
