# Mission Control operations — design QA

## Source and implementation evidence

### Workspace Operations Shelf

- Source visual truth: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\11-direction-3.png`
- Desktop implementation: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\21-workspace-operations-desktop.png`
- Mobile implementation: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\22-workspace-operations-mobile.png`
- Full-view comparison: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\24-workspace-qa-comparison.png`
- Viewports: 1536 x 1024 desktop; 390 x 844 mobile
- State: Forge workspace Dashboard, Mission Control expanded, Queue selected, seeded local data loaded

The full-view comparison preserves each 1536 x 1024 frame at native scale. It shows the selected bottom operations-shelf composition beside the browser-rendered implementation. Both reflow the dashboard above a bottom-attached shelf, use summary / queue / agent-presence zones, keep Queue selected, expose one ember primary action, and retain Forge's warm-earthy dark tokens and compact typography.

The implementation intentionally omits the mock's speculative filter, sort, and inline assignee controls because the current quick-access query is read-only and deep-links to the durable issue surface. It uses honest dispatch-state copy and canonical issue links instead. This is an expected product constraint rather than unresolved visual drift.

### Global Mission Control

- Source desktop baseline: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\01-global-desktop-accepted.png`
- Source mobile baseline: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\02-global-mobile-accepted.jpg`
- Desktop implementation: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\19-global-operations-desktop.png`
- Mobile implementation: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\20-global-operations-mobile.png`
- Lower mobile implementation: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\20b-global-operations-mobile-lower.png`
- Full-view comparison: `C:\Users\Bailey\Documents\Codex\2026-07-13\forge-mission-control-audit\outputs\forge-mission-control-audit\23-global-qa-comparison.png`
- Viewports: 1536 x 1024 desktop; 390 x 844 mobile
- State: cross-workspace overview with seeded Forge workspace, zero registered runtimes, 19 open issues, no assigned attention, three offline agents, and recent activity

The baseline and implementation comparison confirms the redesign preserves the global shell, real data, existing tokens, density, navigation destinations, and read-only contract while replacing the undifferentiated card grid with the selected direction's operator hierarchy. Runtime and dispatch posture now leads; workspace queue and assigned attention are the primary work plane; agent presence, runtime coverage, and activity follow as supporting evidence.

## Required fidelity surfaces

- **Fonts and typography:** Both surfaces use Forge's existing font stack and density-aware scale. Section labels, headings, metrics, issue keys, and row copy establish the same compact operational hierarchy without a parallel type system.
- **Spacing and layout:** The workspace shelf attaches to the bottom of the content flow and never covers the dashboard. The global surface uses one posture banner, a 2:1 primary work grid, then three supporting columns. Mobile collapses both surfaces into one readable vertical sequence with no clipped controls or horizontal overflow.
- **Colors and tokens:** Existing `background`, `card`, `border`, `ember`, `warning`, `danger`, `success`, `foreground`, and `muted-foreground` tokens are used throughout. No hard-coded palette, gradients, or new design system were introduced.
- **Images and icons:** Neither target requires raster imagery. All interface icons use Forge's existing Lucide dependency; no placeholder asset, handcrafted SVG, CSS drawing, or generated substitute was added.
- **Copy and content:** Mission Control terminology remains consistent. Workspace issue keys use canonical `FRG-*` references. The global runtime CTA appears only when setup is required, Queue remains distinct from assigned Attention, and Sprint terminology elsewhere remains unchanged.

## States, interaction, and accessibility

- Live, Queue, Agents, and Chat expose `tablist`, `tab`, `aria-selected`, `aria-controls`, and `tabpanel` semantics.
- Numeric shortcuts 1–4 switch workspace tabs and Escape collapses the shelf. The primary Assign next action opens the oldest unassigned issue; issue and agent rows deep-link to their durable surfaces.
- The global workspace row, issue-queue action, inbox, activity, agent settings, and runtime settings navigation were exercised from the rendered page.
- Workspace Queue and Agent Presence provide explicit loading, empty, and error states. Every global query region has a bounded loading state, empty state, and retry action without hiding the rest of Mission Control.
- Mobile workspace tabs, Settings, and Collapse meet a 44 px target. Global mobile interactive rows and actions meet at least 40 px, preserve visible focus styles from existing components, and wrap long content without collision.
- Desktop and mobile document widths match their viewport widths. Browser log review found no warnings or errors attributable to the implementation.

## Comparison history

### Iteration 1

- **[P2] Workspace mobile controls were 24–40 px.** Settings, tabs, and Collapse did not meet the intended touch target. Fixed by increasing mobile controls to 44 px while retaining compact desktop sizing.
- **[P1] The collapsed workspace pill could sit behind mobile navigation.** Fixed by applying bottom-navigation safe clearance to bottom-corner pill and glance states.
- **[P1] Global runtime health was buried below workspace volume.** Fixed by replacing the equal-weight card grid with a derived runtime and dispatch posture banner, keeping registration failure visible before queue triage.
- **[P2] Queue, attention, presence, and activity competed at the same level globally.** Fixed by separating actionable workspace queue and personal attention from supporting coverage and recency evidence.

### Iteration 2

- Post-fix mobile measurement confirms the workspace controls meet 44 px and neither surface overflows at 390 x 844.
- Post-fix desktop captures confirm the workspace shelf remains in layout and the global scan begins with runtime posture, queue, and attention.
- Combined comparisons contain no actionable P0, P1, or P2 differences against the approved direction, captured product baseline, and existing Forge conventions.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- **P3:** If Forge later exposes safe quick-assignment mutations and queue sort/filter contracts, the workspace shelf can adopt inline controls without changing its structure.

## Final result

final result: passed
