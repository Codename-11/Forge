/**
 * Forge modal taxonomy.
 *
 * Five typed primitives + a shared behavior hook + draft-state helpers.
 * Keyboard contract across all of them: ⏎ submits primary, ⌘⏎ / ⇧⏎
 * triggers secondary when provided, ⎋ closes. Focus trap + restore is
 * handled by `useModalBehavior` under the hood.
 *
 *   <Confirm>    — small centered yes/no, optional type-to-confirm
 *                  for destructive actions.
 *   <QuickForm>  — 1-3 field centered form, optional draft persistence.
 *   <CenterModal> — large centered setup/editing flow with sticky footer.
 *   <SidePanel>  — right-edge slide-in for heavy forms (page visible).
 *   <Picker>     — command-palette-style searchable list.
 *   <Drawer>     — bottom sheet for tablet widths and below.
 *
 * The legacy `<Dialog>` primitive is still exported from
 * `@/components/ui` for back-compat while call-sites migrate.
 */
export { Confirm } from "./confirm";
export { useConfirm, type ConfirmOptions } from "./use-confirm";
export { QuickForm } from "./quick-form";
export { CenterModal } from "./center-modal";
export { SidePanel } from "./side-panel";
export { Picker } from "./picker";
export { Drawer } from "./drawer";
export { useModalBehavior } from "./use-modal-behavior";
export { saveDraft, readDraft, clearDraft } from "./draft";
