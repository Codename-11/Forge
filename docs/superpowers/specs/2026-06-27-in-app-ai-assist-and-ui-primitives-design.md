# In-app AI assist + UI primitives + native-element sweep — Design

**Date:** 2026-06-27
**Status:** Approved to proceed (all threads), phased execution.

## Context

Three related asks, grounded in the current code:

- **Triage** (`src/components/ai-triage-card.tsx`) already supports Re-run
  (READY) and Retry (ERROR). There is **no** AI help for the issue
  *description* anywhere; `aiCoach` only posts comments on stalled issues.
- **Labels** have a full `settings/labels` page, but pickers (quick-create,
  issue detail, issue-list) offer **no inline create** — you must leave to
  settings first.
- **Native browser elements** remain on user-facing surfaces, violating the
  standing rule *"no app surface uses basic browser elements — always in-app
  UI."* Audit (2026-06-27): native `<select>` in `plans/page.tsx`,
  `issues/[id]/page.tsx`, `crews/crew-selector.tsx`, `ui/combobox.tsx`;
  `window.confirm/alert/prompt` in `time/page.tsx`, `quick-notes-widget.tsx`,
  `admin-shell/admin-users.tsx`, `issue-detail/agent-run-strip.tsx`,
  `settings/github-apps.tsx` (×2); plus 23 native date/color/file inputs.

## Goals

1. One coherent **AI assist** surface on an issue (triage + description help).
2. **Create labels (and the same pattern for other entities) inline** from the
   picker, with a themed modal.
3. Replace native browser controls with **in-app primitives**, and prevent
   regressions (CLAUDE.md rule + lint guard).

## Non-goals

- Streaming token-by-token description drafting (single-shot first; can add
  later via the existing chat draft plumbing).
- Migrating every one of the 23 native date/color/file inputs in the first
  pass — date pickers (most user-facing) first; color handled by the swatch
  picker; file inputs last.
- Inline-create for *every* entity now — labels ship complete; projects /
  cycles / initiatives adopt the same `InlineCreate` pattern opportunistically.

---

## Thread A — Issue AI assist

**Entry point.** A single `AiAssistMenu` (themed popover, built on
`anchored-popover.tsx`) on the issue detail page, replacing scattered buttons.
Actions, context-gated:

- **Re-run triage** — calls existing `ai.triageRerun`. Show a compact "what
  changed vs last run" line when a prior suggestion exists.
- **Draft description** — visible only when description is empty. Fills the
  editor with a generated draft (preview → Apply).
- **Enhance description** — visible only when description is non-empty. Shows a
  **diff** (before/after) with Apply / Discard. Never overwrites silently.
- (Stretch, behind the same menu, later phases) *Suggest sub-tasks*, *Find
  duplicates/related*.

**Backend.** New `ai.draftDescription` / `ai.enhanceDescription` tRPC mutations
in `src/server/routers/ai.ts`, backed by new `runDescriptionDraft` /
`runDescriptionEnhance` in `src/server/services/ai.ts`. They reuse `getClient`
+ the **prose-tolerant** parsing posture from the triage fix (do not hard-fail
if the provider ignores tool calls — accept content text). Both return
`{ markdown }`; enhance also returns the original for the diff. Gated by
`Workspace.aiEnabled`; unavailable → actionable reason (same pattern as triage
ERROR), never a silent no-op.

**Apply path.** Description changes go through the existing `issue.update`
mutation so audit/events fire normally. The AI text is a *suggestion staged in
the client* until Apply — nothing persists on generate.

**Result surface.** The triage suggestion card is unchanged; the menu is the
trigger. ERROR/loading states reuse the card's existing treatment.

## Thread B — Inline create-from-picker

**Pattern.** Extend `ui/combobox.tsx` with an optional `onCreate(query)` and a
"+ Create '<query>'" row shown when the query matches nothing. Selecting it
opens an in-app modal.

**Labels first.** `CreateLabelModal` (themed): name (prefilled from query) +
**color swatch picker** (`ui/color-swatch-picker.tsx`, a themed palette — NOT
native `<input type=color>`). Submits `labels.create`, then auto-selects the
new label in the originating picker. Wire into the label pickers in
quick-create, issue detail, and issue-list.

**Generalize.** The combobox `onCreate` hook + modal shell are written so
projects / cycles / initiatives can adopt the same flow later with their own
small create form. Only labels are wired in this initiative.

## Thread C — In-app primitives + native sweep

New primitives in `src/components/ui/`:

- **`select.tsx`** — themed select built on `anchored-popover` + `combobox`
  internals (keyboard, search optional). Replaces native `<select>`.
- **`confirm-dialog.tsx`** + **`useConfirm()`** — promise-returning hook so
  call sites read like `if (await confirm({...})) …`, replacing
  `window.confirm`. Themed modal with title/body/confirm/cancel + variant.
- **`prompt-modal.tsx`** + **`usePrompt()`** — replaces `window.prompt`
  (github-apps app-id / org entry).
- **`color-swatch-picker.tsx`** — shared with Thread B.
- **Date picker** — themed calendar popover for the user-facing date inputs
  (reuse if one already exists in due-date UI; else add). Color via swatch
  picker. File inputs: themed dropzone wrapper last.

**Migrations (this initiative):** the 4 native `<select>`, the 6
confirm/alert/prompt sites, and the most user-facing date inputs. Remaining
date/color/file inputs tracked as follow-up.

**Guardrails:** add a "Design style" rule to `CLAUDE.md` ("never native
`<select>` / `confirm` / `alert` / `prompt`; use the `ui/` primitives"), and an
ESLint `no-restricted-syntax` / `no-restricted-globals` rule flagging
`window.confirm|alert|prompt` and native `<select>` so it can't regress.

---

## Architecture / new units

| Unit | Purpose | Depends on |
|------|---------|-----------|
| `ui/select.tsx` | themed select | anchored-popover, combobox |
| `ui/confirm-dialog.tsx` + `useConfirm` | in-app confirm | dialog/modal base |
| `ui/prompt-modal.tsx` + `usePrompt` | in-app text prompt | dialog/modal base |
| `ui/color-swatch-picker.tsx` | themed color choice | tokens |
| `ui/date-picker.tsx` (if absent) | themed date input | anchored-popover |
| `components/inline-create/create-label-modal.tsx` | inline label create | combobox `onCreate`, swatch, `labels.create` |
| `components/issue-detail/ai-assist-menu.tsx` | AI action entry point | anchored-popover, `ai.*` |
| `ai.draftDescription` / `ai.enhanceDescription` (router) | AI desc endpoints | `runDescription*` |
| `runDescriptionDraft` / `runDescriptionEnhance` (service) | model calls | `getClient`, prose-tolerant parse |

## Error handling

- AI endpoints: provider-unavailable / empty result → typed error with an
  actionable message pointing at Settings → Workspace → AI (mirrors the triage
  ERROR card). Generate never mutates the issue.
- Inline create: `labels.create` failures surface a toast; modal stays open.
- Primitives: `useConfirm`/`usePrompt` reject/resolve cleanly on cancel
  (no dangling promises).

## Testing

- Unit: `runDescriptionDraft/Enhance` parsing (incl. prose-only providers),
  combobox `onCreate` row logic, `useConfirm`/`usePrompt` resolve/cancel.
- Integration (Postgres/Redis containers, no mocks): `ai.draftDescription` /
  `enhanceDescription`, `labels.create` from picker path.
- Keep changes lint/typecheck clean; add the ESLint guard and confirm it fails
  on a planted `window.confirm`.

## Phasing / build order (commit + verify each)

1. **Primitives + guardrails** — `select`, `confirm-dialog`/`useConfirm`,
   `prompt-modal`/`usePrompt`, `color-swatch-picker`, date picker; CLAUDE.md
   rule + ESLint guard. No behavior change yet.
2. **Inline create-from-picker (labels)** — combobox `onCreate` +
   `CreateLabelModal`; wire label pickers.
3. **Issue AI assist** — `runDescription*` + `ai.*` endpoints +
   `AiAssistMenu` (re-run, draft, enhance-with-diff).
4. **Native sweep** — migrate the 4 selects, 6 confirm/alert/prompt sites, and
   user-facing date inputs onto the new primitives; ESLint guard turned to
   error.

Each phase: DEVLOG + (user-facing) CHANGELOG, `lint && typecheck` + focused
tests, commit. Deploy when a coherent slice is ready.
