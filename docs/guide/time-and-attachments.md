# Time tracking & attachments

Two cross-cutting capabilities that hang off issues, comments, projects,
initiatives, and sprints. Time tracking is opt-in per workspace.
Attachments are always available, backed by MinIO with per-workspace
quotas. This page covers both end-to-end.

## Time tracking

Off by default. Turn on `Workspace.timeTrackingEnabled` to surface the
time-tracker widget and related affordances.

### TimeEntry

Time is recorded as `TimeEntry` rows.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | Internal identifier |
| `userId` | fk | The user the entry belongs to |
| `issueId` | fk | Optional issue link |
| `description` | string | Free-form |
| `startedAt` | datetime | When the entry started |
| `endedAt` | datetime, nullable | `null` = currently open (running) |
| `billable` | bool | Whether the time is billable |
| `hourlyRate` | decimal | Optional rate at the time of entry |

A `null` `endedAt` is the running state. A user has at most one open entry
at a time; starting a new one auto-stops any open entry first.

::: info
Forge keeps the rate on the entry, not the user. That's intentional — if a
rate changes, historical entries reflect what was billed at the time, not
the new rate. Rate edits don't retroactively rewrite history.
:::

### Toggling the widget

Press <kbd>t</kbd> to toggle the time-tracker widget. The widget appears as
a small persistent panel on the right edge of the app, showing the
currently running entry (if any) and exposing a stop button.

### Per-issue start/stop

In the issue detail view, press <kbd>⇧T</kbd> to start or stop a timer
against the current issue. This is the fastest path: open issue, hit the
chord, work, hit the chord again to stop. The entry's `issueId` is set
automatically.

### MCP tools

Six tools cover the surface:

| Tool | Purpose |
|---|---|
| `time.start` | Open a new entry. Stops any open entry first |
| `time.stop` | Close the current open entry |
| `time.log` | Post-hoc completed entry (start + end + description) |
| `time.list` | List entries with filters (user, issue, range) |
| `time.summary` | Aggregate by issue, project, or day |
| `time.running` | The currently open entry, if any |

```http
POST /api/mcp/time/start
Content-Type: application/json

{ "issueId": "...", "description": "Pairing on rollover bug" }
```

## Attachments

Attachments are polymorphic — they hang off any entity that supports them.

### Targets

| `targetType` | What it points at |
|---|---|
| `issue` | An issue |
| `comment` | A comment on any entity |
| `project` | A project |
| `initiative` | An initiative |
| `cycle` | A sprint |

The pair (`targetType`, `targetId`) identifies the parent. Cascade-delete
follows the parent: deleting an issue removes its attachment rows (and
schedules the MinIO objects for cleanup).

### Storage

Binaries live in MinIO (S3-compatible). Each workspace gets its own bucket:

```
forge-${workspace.slug}
```

Metadata — filename, MIME type, size, target — lives in Postgres. The
metadata row is the source of truth; MinIO is the byte store.

### Quota

`Workspace.attachmentQuotaMb` sets the per-workspace ceiling. The default
is 1024 (1 GB). Quota is enforced on init-upload: if the new file would
push total stored bytes over the cap, the call fails before the presigned
URL is issued.

### Limits

| Limit | Value |
|---|---|
| Per-file maximum | 25 MB |
| Per-workspace quota | `attachmentQuotaMb` (default 1024 MB) |
| Presigned URL TTL | 15 minutes |

### Allowed MIME types

| Category | Types |
|---|---|
| Images | PNG, JPEG, GIF, WebP, SVG |
| Documents | PDF, plain text, Markdown, DOCX, XLSX |
| Web | HTML, JSON, CSV, XML, YAML |
| Audio | MP3, WAV, OGG, M4A |
| Video | MP4, WebM, QuickTime |
| Archives | ZIP |

Files with a MIME type outside this set are rejected at init-upload. The
allowlist lives in `src/server/services/storage.ts` (`ALLOWED_MIME_TYPES`).
Adding a new type means adding the entry there and any preview/render
support the UI needs.

::: warning
SVG is allowed but rendered carefully — it's served with a sandbox CSP
to mitigate script-in-SVG vectors. If you embed SVGs from untrusted
sources, audit them first.
:::

### Three-step upload

The upload flow is three calls, not one. This keeps bytes off the Forge
web tier — clients PUT directly to MinIO using a short-lived presigned URL.

```
client                 forge api               minio
  │                       │                      │
  │ initUpload (metadata) │                      │
  ├──────────────────────▶│                      │
  │                       │ check quota          │
  │                       │ create row (PENDING) │
  │                       │ presign PUT (15min)  │
  │ ◀──────────────────── │                      │
  │                                              │
  │ PUT bytes                                    │
  ├─────────────────────────────────────────────▶│
  │                                              │
  │ finalize (id)         │                      │
  ├──────────────────────▶│                      │
  │                       │ verify + mark READY  │
  │ ◀──────────────────── │                      │
```

Three calls, three responsibilities:

1. `attachments.initUpload` — pass `{ targetType, targetId, filename,
   mimeType, sizeBytes }`. Forge validates MIME, checks quota, creates a
   `PENDING` row, and returns a presigned PUT URL valid for 15 minutes.
2. The client PUTs the bytes directly to MinIO using that URL.
3. `attachments.finalize` — pass the attachment id. Forge confirms the
   object exists in MinIO and flips the row to `READY`.

If finalize is never called (network drop, user closed tab), a sweep
eventually GCs `PENDING` rows older than the URL TTL.

### Download

Reads also go through a presigned URL.

```ts
const { url } = await trpc.attachments.getDownloadUrl.query({
  workspaceId,
  attachmentId,
});
// url is a presigned GET, valid for 15 minutes
```

The URL is single-use in spirit (anyone with it can fetch within the
window) but is not single-use in MinIO. If you need stricter access,
mediate through your own auth layer.

### External link attachments

Not every attachment is bytes. The `attachments.attachLink` tool (and
its tRPC sibling `attachment.attachLink`) records an external URL —
Google Doc, GitHub PR, Notion page, anything web-addressable — as a
first-class attachment row without uploading any object to MinIO.

The schema distinguishes them via `Attachment.kind` (`FILE` | `LINK`).
LINK rows populate `externalUrl` (the canonical URL) and `linkTitle`
(human label, defaults to URL hostname). The legacy file-shaped columns
(`filename`, `mimeType`, `size`, `url`) are still populated for backward
compat (`mimeType = "text/url"`, `size = 0`, `url = externalUrl`) so
existing consumers don't have to know the difference.

When the caller doesn't supply a title, Forge does a best-effort scrape
of the page's `<title>` (server-side fetch with 5s timeout, follows
redirects, reads up to 64 KB). On scrape failure the LINK chip falls
back to the URL hostname.

LINK chips on issues / comments / projects render with a deterministic
favicon (origin + `/favicon.ico`, with a Lucide `ExternalLink` fallback
on image-load error) and the hostname inline. Clicking opens the URL
in a new tab.

### `forge-link` markdown token

Inside any rendered markdown body (issue descriptions, comments,
notes), the token shape:

```
[label](forge-link:https://example.com)
```

renders as an inline `<InlineForgeLink />` chip — same border, hover-
ember, and click-to-open behavior as a LINK attachment chip, but with
no DB lookup involved. It's the markdown-native way to interleave
external references in body text without forcing a real Attachment row.

The scheme is restricted to `http` / `https` at both regex and code
level. Anything else falls through as plain text, by design.

### MCP tools

| Tool | Purpose |
|---|---|
| `attachments.initUpload` | Begin upload; returns presigned PUT |
| `attachments.finalize` | Confirm upload; flips row to READY |
| `attachments.attachLink` | Attach an external URL (LINK kind) |
| `attachments.getDownloadUrl` | Issue a presigned GET |
| `attachments.list` | List attachments for a target |
| `attachments.delete` | Remove (soft-delete + MinIO cleanup) |

## Where to next

- [Issues](/guide/issues.html) — the most common attachment target.
- [Settings](/guide/settings.html) — the workspace knobs covered above.
- [Reference → MCP Tools](/reference/mcp.html) — the full tool list.
