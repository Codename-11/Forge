# Current-state screenshot log

Captured 2026-07-14 from the seeded Forge E2E instance after the user explicitly
approved Playwright CLI for this audit. The app ran against the isolated
`forge_e2e` Postgres database and Redis stack. Desktop captures use 1440×900;
mobile captures use 390×844. Every accepted image was opened and visually
inspected at original resolution.

Artifact directory:

`/home/bailey/.codex/visualizations/2026/07/15/019f6345-3f4d-7f72-8ff8-d13cb01139af/configuration-ia-current`

## Accepted evidence

| # | File | Viewport | Evidence |
|---|---|---:|---|
| 1 | `01-mission-control-desktop.png` | 1440×900 | Cross-workspace Mission Control and its global navigation entry points. |
| 2 | `02-account-settings-agents-desktop.png` | 1440×900 | Mixed-ownership Account rail and agent-profile definition copy. |
| 3 | `03-global-runtime-inventory-desktop.png` | 1440×900 | Global runtime inventory, scope wording, detail links, and card crowding. |
| 4 | `04-workspace-settings-overview-desktop.png` | 1440×900 | Named-workspace overview, duplicated rail/index, and account scope jump. |
| 5 | `05-workspace-general-desktop.png` | 1440×900 | Overloaded Workspace General page. |
| 6 | `06-dispatch-fall-through-desktop.png` | 1440×900 | Read-only fall-through mode and dead-end instruction. |
| 7 | `07-workspace-agent-bindings-desktop.png` | 1440×900 | Definition → binding → instance-policy model. |
| 8 | `08-workspace-connections-desktop.png` | 1440×900 | Workspace mapping/policy surface and integration naming. |
| 9 | `09-authentication-in-account-shell-desktop.png` | 1440×900 | Instance-wide authentication rendered inside Account settings. |
| 10 | `10-instance-admin-overview-desktop.png` | 1440×900 | Strong instance scope/risk signal and admin hierarchy. |
| 11 | `11-instance-agent-policy-desktop.png` | 1440×900 | Instance agent governance and destructive controls. |
| 12 | `12-workspace-mission-control-preferences-desktop.png` | 1440×900 | Duplicate Mission Control name and mixed local/personal/workspace preferences. |
| 13 | `13-workspace-settings-overview-mobile.png` | 390×844 | 16rem settings rail before content and nested scrolling. |
| 14 | `14-account-settings-agents-mobile.png` | 390×844 | Account rail exposes only two destinations before its capped scroll region. |
| 15 | `15-instance-admin-overview-mobile.png` | 390×844 | Admin navigation height plus clipped/crowded data tables. |
| 16 | `16-workspace-mission-control-preferences-mobile.png` | 390×844 | Near-full-screen operations shelf and preferences popover reflow. |
| 17 | `17-developer-access-in-account-shell-desktop.png` | 1440×900 | Workspace API keys presented in the Account shell. |
| 18 | `18-agent-clients-in-account-shell-desktop.png` | 1440×900 | Clients derived from workspace keys but labeled as account-level. |

## Rejected and recaptured states

- The first workspace-overview capture was rejected because the PWA offline
  prompt obscured the page. The prompt was dismissed through its documented
  local state and the image was recaptured.
- The first fall-through capture did not include the audited control. The
  exact section was centered and recaptured.
- The first mobile workspace capture inherited the expanded operations shelf
  from the desktop walkthrough. Persisted shelf state was reset and the page
  was recaptured.

## Audit boundary

Screenshots support visible hierarchy, reflow, naming, density, and obstruction
findings. They do not by themselves prove screen-reader behavior, contrast
ratios, focus order, permission behavior for every role, or full WCAG
conformance. Those require DOM/axe, keyboard, and role-specific E2E checks.
Figma and Orca were not used.

## Implemented-state comparison

After the first P0/P1 slice, four additional captures were inspected at the
same viewports under:

`/home/bailey/.codex/visualizations/2026/07/15/019f6345-3f4d-7f72-8ff8-d13cb01139af/configuration-ia-after`

They show the new Personal overview and scope header, editable authoritative
Dispatch & routing defaults, Instance Identity & sign-in inside the admin
shell, and the collapsed mobile settings navigation that exposes content
immediately.
