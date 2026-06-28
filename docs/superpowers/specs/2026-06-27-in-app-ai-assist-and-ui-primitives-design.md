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

**Most primitives already exist** (re-survey 2026-06-27) — this thread is
mostly *adoption/migration*, not new construction:

- **`Confirm`** (`ui/modal/confirm.tsx`) — themed, destructive +
  type-to-confirm + loading + a11y. **Reuse.** Add a thin `useConfirm()`
  imperative wrapper (promise-returning) so migrating `window.confirm` sites is
  one-line.
- **`QuickForm`** (`ui/modal/quick-form.tsx`) — 1–3 field create dialog with
  `.Field`, draft persistence, error banner. **Reuse** for `CreateLabelModal`
  and to replace `window.prompt` (github-apps app-id / org → a 1-field
  QuickForm).
- **`Picker`** (`ui/modal/picker.tsx`) — palette-style chooser; **reuse** for
  modal `<select>` replacements. Inline `<select>` → `combobox`.
- **`ColorSwatchPicker`** (NEW, `ui/color-swatch-picker.tsx`) — extract the
  `DEFAULT_COLORS` swatches currently inlined in `settings/labels/page.tsx`
  into a shared component (swatches + optional hex entry). Replaces the native
  `<input type=color>` there and feeds Thread B.
- **`DatePicker`** (NEW, `ui/date-picker.tsx`) — the one genuinely missing
  primitive: a themed calendar popover (built on `anchored-popover`) to replace
  the ~8 native `<input type=date>` (cycles, initiatives, roadmap, snooze). The
  largest piece; sequenced last.

**Migrations (this initiative):** `window.confirm` (×4) → `Confirm`/`useConfirm`;
`window.prompt` (×2, github-apps) → `QuickForm`; `window.alert` (time) → toast;
native `<select>` (×4) → `combobox`/`Picker`; native `<input type=color>`
(labels) → `ColorSwatchPicker`; native `<input type=date>` → `DatePicker`.

**Guardrails:** CLAUDE.md "Design style" rule + ESLint
`no-restricted-globals`/`no-restricted-syntax` for `window.confirm|alert|prompt`
and native `<select>`, so it can't regress.

**Guardrails:** add a "Design style" rule to `CLAUDE.md` ("never native
`<select>` / `confirm` / `alert` / `prompt`; use the `ui/` primitives"), and an
ESLint `no-restricted-syntax` / `no-restricted-globals` rule flagging
`window.confirm|alert|prompt` and native `<select>` so it can't regress.

---

## Architecture / new units

| Unit | New? | Purpose | Depends on |
|------|------|---------|-----------|
| `ui/modal/confirm.tsx` (`Confirm`) | exists | confirm dialog | — |
| `useConfirm()` wrapper | new (thin) | imperative `await confirm()` | `Confirm` |
| `ui/modal/quick-form.tsx` (`QuickForm`) | exists | 1–3 field create / prompt | — |
| `ui/modal/picker.tsx` (`Picker`) | exists | palette-style chooser | — |
| `ui/combobox.tsx` | exists (+`onCreate`) | inline select / typeahead | anchored-popover |
| `ui/color-swatch-picker.tsx` | new | themed color choice | tokens |
| `ui/date-picker.tsx` | new | themed date input | anchored-popover |
| `components/inline-create/create-label-modal.tsx` | new | inline label create | `QuickForm`, swatch, `labels.create` |
| `components/issue-detail/ai-assist-menu.tsx` | new | AI action entry point | anchored-popover, `ai.*` |
| `ai.draftDescription` / `ai.enhanceDescription` (router) | new | AI desc endpoints | `runDescription*` |
| `runDescriptionDraft` / `runDescriptionEnhance` (service) | new | model calls | `getClient`, prose-tolerant parse |

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

Reordered for dependencies now that most primitives exist:

1. **`ColorSwatchPicker` + `useConfirm`** — extract swatches from
   `settings/labels` (replacing its native `<input type=color>`); add the
   `useConfirm()` wrapper over the existing `Confirm`. Small foundation.
2. **Thread B — inline label create** — combobox `onCreate` + `CreateLabelModal`
   (QuickForm + ColorSwatchPicker); wire label pickers (issue detail first,
   then quick-create / issue-list).
3. **Thread A — issue AI assist** — `runDescriptionDraft/Enhance` +
   `ai.draftDescription/enhanceDescription` + `AiAssistMenu` (re-run, draft,
   enhance-with-diff).
4. **Thread C — non-date sweep + guardrails** — `window.confirm`→`useConfirm`,
   `window.prompt`→`QuickForm`, `window.alert`→toast, native `<select>`→
   `combobox`/`Picker`; CLAUDE.md rule + ESLint guard (warn→error).
5. **`DatePicker` + date sweep** — themed calendar; migrate the native
   `<input type=date>` sites. Largest; last.

Each phase: DEVLOG + (user-facing) CHANGELOG, `lint && typecheck` + focused
tests, commit. Deploy when a coherent slice is ready.
