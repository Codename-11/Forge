# Agent Studio configuration audit — 2026-07-15

## Outcome

Forge now presents agent configuration as five explicit, non-overlapping
surfaces:

- **Agent Studio** owns the durable identity, provider, prompt, base
  capabilities, and zero-or-one primary execution runtime.
- **Workspace Agent roster** binds that identity into a workspace and owns only
  local capacity, routing eligibility, engagement, approval, and capability
  overrides.
- **Workspace Agent access** owns zero-or-many MCP client credentials per
  binding, plus personal and session credentials, scopes, rotation, and
  revocation.
- **Instance Administration** owns approval, instance sharing, disabling, and
  removal.
- **Mission Control** remains read-only operational telemetry for runtime
  health, capacity, queues, runs, and attention.

This makes the core relationship explicit:

```text
Agent profile
├── primary execution runtime: 0..1
├── workspace binding: 0..n
│   └── MCP client credentials: 0..n
└── instance governance policy: 1
```

The previous Agent Clients inventory has been retired as an independent
surface. Its routes redirect to Agent access so saved links keep working while
credential creation and credential lifecycle have one source of truth.

## Evidence

The audit used a fresh production-mode Playwright build with seeded data at
1440×1000 and 390×844. The accepted current-state captures are in
[`after/`](./after/); the original captures are preserved in
[`before/`](./before/) for direct comparison.

Key accepted captures:

- `after/01-global-agent-profiles.png` — Agent Studio inventory
- `after/02-create-agent-profile.png` — creation with primary runtime
- `after/03-agent-profile-detail.png` — readiness and connection model
- `after/04-edit-agent-identity.png` — editable identity and execution
- `after/05-add-mcp-client.png` — deep-linked, preselected MCP client wizard
- `after/07-workspace-agent-bindings.png` — collapsed workspace roster
- `after/08-workspace-agent-policy-expanded.png` — policy on demand
- `after/09-agent-access.png` — consolidated credential lifecycle
- `after/10-instance-agent-policy.png` — instance governance
- `after/11-mission-control.png` — read-only operations
- `after/12`–`14` — mobile Agent Studio, detail, and workspace roster

## Numbered walkthrough health

1. **Find the agent definition — healthy.** “Account & identity” no longer
   claims shared profiles are personal settings, and Agent Studio explains its
   identity/runtime/workspace remit at entry.
2. **Create a profile — healthy.** Creation now includes the primary execution
   runtime and explains that MCP clients are configured separately. Required
   identity fields and the existing instance-admin gate remain clear.
3. **Understand readiness — healthy.** The profile begins with three explicit
   cards for runtime, workspace bindings, and MCP clients. Missing execution or
   access is visible without inferring it from an empty field.
4. **Edit identity and execution — healthy.** Name, avatar, description,
   provider, run engine, base capabilities, and the single runtime can be
   edited together. Identity/execution changes propagate to active workspace
   bindings while workspace policy remains local.
5. **Attach multiple clients — healthy.** Each workspace binding aggregates all
   linked MCP client credentials and opens Agent access with that binding
   preselected. Adding another client never replaces the execution runtime.
6. **Tune workspace behavior — healthy.** Roster rows default to compact status
   summaries; policy expands only when requested. The large always-visible
   three-step explainer and policy grids no longer dominate the page.
7. **Manage credentials — healthy.** Client creation, scopes, inspection,
   rotation, revocation, and deletion now share one Agent access surface. The
   separate Developer clients navigation and inventory were removed.
8. **Govern the instance — healthy.** Instance Administration remains the only
   place for cross-workspace sharing, approval, disable, and removal decisions.
9. **Operate the fleet — healthy.** Mission Control remains visibly read-only
   and reports runtime attention, capacity, runs, queues, presence, and recent
   activity without becoming a fourth configuration surface.
10. **Use the flow on mobile — healthy after repair.** Settings navigation stays
    collapsed, readiness cards stack, the creation callout reflows, and roster
    actions remain in a readable action row instead of narrow text columns.

## Accessibility and usability notes

- Existing design tokens, focus-ring utilities, semantic buttons, switch roles,
  `aria-expanded`, `aria-current`, and labeled settings search were preserved.
- Progressive disclosure reduces vertical scanning and interaction cost but
  keeps all binding actions keyboard reachable.
- Readiness does not rely on color alone: each card includes a label, value,
  status icon, and explanatory text.
- The Playwright walkthrough validates visible behavior and responsive layout;
  it does not replace a full screen-reader or automated WCAG audit.

## Verification contract

The focused router coverage proves that profile edits synchronize identity and
execution fields to active bindings and that a profile aggregates multiple MCP
clients. The Playwright journey exercises desktop and mobile entry, creation,
editing, client deep-linking, collapsed/expanded workspace policy, instance
governance, and Mission Control.
