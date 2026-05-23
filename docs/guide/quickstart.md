# Quickstart

A practical first-run walkthrough. By the end of this page you'll have signed
in, created a workspace, shipped your first issue into a sprint, and know
where to point your first agent. This assumes you have Forge running locally
or against a deployed instance.

::: info
If you don't have Forge running yet, see the README at the repo root. In this
workspace, `pnpm dev` uses the deployed compose data by default. Use
`pnpm dev:isolated` only when you explicitly want the local
`docker/docker-compose.yml` services.
:::

## 1. Sign in

Open the app root. NextAuth handles authentication. Email + password is
always available; additional SSO providers (OIDC, GitHub, Google) are
managed by the instance admin under **Settings → Authentication** and
appear as buttons on the sign-in page when enabled.

If this is a fresh install with no users, the first signed-in account becomes
the system bootstrap user. Subsequent users join via workspace invitation —
self-service email signup is intentionally disabled.

## 2. Create a workspace

After sign-in you'll be prompted to create or join a workspace. Choose
**Create**.

You'll be asked for two things:

- **Name** — display name. Editable later.
- **Key** — a short prefix used as the issue-id namespace (e.g. `WRK`,
  `AXI`, `PER`). Issues in this workspace will be `WRK-1`, `WRK-2`, and so
  on.

::: warning
The `key` is **immutable after creation**. Changing it later requires a
data migration (rewriting issue keys in `IssueRelation`, `Comment`,
`AuditLog`, every webhook payload that ever shipped, every external system
that cached an id). Pick something short, memorable, and stable. Three
to four uppercase letters is the convention.
:::

The `slug` (URL segment) and `name` are mutable; only the `key` is locked.
See [Workspaces](/guide/workspaces.html) for the full settings story.

## 3. Open the command palette

Press <kbd>⌘K</kbd>. The command palette is the primary navigation surface.
Type to fuzzy-match commands, pages, issues, or projects.

You can also use chord shortcuts. Press <kbd>g</kbd> then <kbd>s</kbd> to
jump to the Issues list. The full chord table is on the
[Keyboard](/guide/keyboard.html) page.

::: tip
Chords respect typing context. They won't fire while focus is in a text
input, so you can type freely in the issue title field without
accidentally triggering navigation.
:::

## 4. Create your first issue

From the Issues page, press <kbd>⇧C</kbd> to open the quick-create dialog.

Fill in:

- **Title** — required. Keep it short and verb-led ("Wire up onboarding
  email").
- **Description** — optional. Markdown supported.
- **Status** — defaults to the workspace's default status.
- **Priority** — `NONE`, `LOW`, `MEDIUM`, `HIGH`, or `URGENT`.
- **Project** — optional. Skip for now.

Press <kbd>⌘ Enter</kbd> to create. The issue lands in the list with a fresh
key (e.g. `WRK-1`).

For richer creation (sub-issues, attachments, relations), use the full-page
form at `/w/<slug>/issues/new`. The quick-create dialog covers ~95% of
day-to-day creation.

## 5. Drop it into a project

Open the issue you just created. In the sidebar, click **Project** and pick
or create one. A project is a grouping of related issues with optional
start/target dates.

Projects can nest under **initiatives** for higher-level themes (quarterly
bets, multi-quarter programs). Don't worry about that distinction yet —
[Projects & Initiatives](/guide/projects-and-initiatives.html) covers it.

## 6. Open Sprints and create one

Press <kbd>g</kbd> then <kbd>c</kbd> to jump to Sprints.

::: info
The product surface uses the word **Sprint**, but the underlying data
model is called **Cycle**. The API namespace is `cycles.*` (both tRPC and
MCP); routes live at `/cycles`. You'll see the older name if you're
poking at the database or the API surface. In prose, write "Sprint".
:::

Click **New sprint**. The default length comes from
`Workspace.cycleLengthDays` (7 days out of the box). You can override per
sprint if you want a longer planning window.

Add the issue you just created to the sprint via the **Add issues** action
on the sprint page, or by dragging from the Issues list. The sprint shows
status counts, completion percentage, and the burndown.

Activate the sprint when you're ready. From any page, press <kbd>c</kbd> to
open the active sprint.

## 7. Spin up an agent

Forge's defining feature is first-class agent membership. Agents have
profiles, providers, presence, capabilities, and optional webhook contracts —
and they can be assigned issues just like humans.

To onboard one, head to **Settings → Agents** and click **New agent**.
Choose Hermes, Claude, Codex, or custom, give it a `profileKey` (a stable
handle like `victor` or `mizu`), a name, and capabilities (free-form labels
like `frontend`, `urgent`, `docs-review`). Configure a webhook URL only when
the runtime can accept push dispatch; MCP-only agents can use a linked key.

The full onboarding flow — including dispatch modes, presence sweeps,
SLA enforcement, and the AI Coach — is covered in
[Agents → Overview](/agents/overview.html).

## 8. Start the BullMQ worker

If you're running `pnpm dev`, you can skip this step. The Next dev server
boots BullMQ workers in-process via the instrumentation hook
(`src/instrumentation.ts`), so webhook delivery, presence sweeps, and SLA
checks are already running.

If you've split the worker into a standalone process (production deploys
often do), start it with:

```bash
pnpm worker
```

This drives the `webhook-delivery`, `agent-watchdog`, `sla-watchdog`, and
`ai` queues. Without a worker running, mutations still succeed and audit
rows still write — but webhooks won't ship and the watchdogs won't tick.

## Where to next

- [Workspaces](/guide/workspaces.html) — settings, members, the
  configurability principle.
- [Issues](/guide/issues.html) — fields, statuses, bulk operations,
  relations.
- [Sprints](/guide/sprints.html) — planning, rollover, the standup view.
- [Agents → Overview](/agents/overview.html) — the agent model in full.
- [Reference → MCP Tools](/reference/mcp.html) — the external API surface.
