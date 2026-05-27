# GOAL — Multi-workspace restructure, follow-up wave (deferred + larger items)

> **TEMPORARY execution spec for an agent team.** Point an agent at it:
> *"complete goal per `docs/plans/multiws-followup-goal.md`"*. It **self-deletes**
> at the end (§7) so it never lingers on master.
>
> Builds on the shipped restructure (live on `forge.axiom-labs.dev`). Durable
> brief: [`docs/plans/multiws-restructure.md`](./multiws-restructure.md).

## 0. Context — what's already live (do NOT rebuild)

The three-tier ownership restructure is deployed and verified on production:
- Schema: `AgentProfile` (global) + `Agent` (binding, `Agent.profileId`),
  `Connection`/`ConnectionMapping`, `User.instanceRole`, `Runtime.instanceShared`
  (migrations 0069/0070, applied on prod). Idempotent `prisma/backfill-multiws.ts` ran.
- Routers: `agents.profiles.*`, `agents.bindings.*`, `connection.*`,
  `connectionMapping.*`, `instanceAdmin.*`, `global.*` (read-only cross-WS).
- UI: three shells (workspace / global concourse `/` Mission Control / admin graphite
  `/admin/*`), global `/inbox` + `/activity`, workspace binding + connection-mapping
  pages, Activity dock rename, workspace→Mission-Control affordances, tokenized admin
  graphite (`--admin-*` in globals.css), canonical `WorkspaceBadge` (color + avatarUrl).
- Confirmed decisions: Agent row = binding (never repoint FKs); `profileKey` unique
  per owner; Connections generic OIDC; cross-workspace = read-only.

## 1. Definition of Done (all must hold)

- [ ] All lanes (§3) implemented; copy/density/layout match the design handoff where one exists.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm test:e2e` green.
- [ ] New e2e specs for: connection OAuth round-trip (mocked provider), member
      profile-request → admin-approve, Activity dock tab switching, MCP `agents.profiles`/
      `agents.bindings` tool calls.
- [ ] `CHANGELOG.md` (new dated heading) + `DEVLOG.md` updated.
- [ ] Merged to `master` (squash) + pushed to `origin`.
- [ ] Built + deployed to prod (build stamp), migrations applied, any new backfill run.
- [ ] Live smoke against the deployed URL for each lane.
- [ ] This file deleted in the final pre-merge commit (§7).

## 2. Setup

```bash
cd /home/bailey/forge          # main checkout, or a fresh worktree off origin/master
pnpm install
pnpm dev:local                 # isolated PG/Redis/MinIO; owner@forge.local / forge-dev
```
Test env (integration + e2e) needs Postgres+Redis+MinIO from `docker/docker-compose.yml`;
run vitest with `--no-file-parallelism` (the shared-DB suite has cross-test contention
under parallelism). Reuse `src/components/global-shell/*`, `admin-shell/*`, `ui/*`.

## 3. Work lanes (parallelizable; file-disjoint where possible)

### Lane A — Connections: live OAuth/OIDC flow  *(largest)*
Today `connection.*` stores a generic OIDC config + a **manually-entered** token
(`connection.setToken`, encrypted). Build the real flow:
- `/api/connections/[id]/authorize` → redirect to the provider's authUrl (PKCE/state).
- `/api/connections/[id]/callback` → exchange code→token, encrypt via `crypto.ts`,
  set `status=CONNECTED`, store `expiresAt`; handle refresh.
- Generic OIDC (issuer discovery) + GitHub/Google/Slack shapes (mirror `SsoProvider`/
  `ssoRouter`). Wire the "Re-authorize" button (global `/settings/connections`) +
  the workspace mapping page's connect affordance.
- A background refresh sweep (worker) flips `status=DEGRADED` near expiry (the UI
  already renders DEGRADED + `error`). Source: design `screens-global.jsx` connections.

### Lane B — Activity dock: 7-tab fidelity  *(edits `src/components/mission-control/*`)*
The chord-`G 5` dock is renamed to Activity with 7 tabs present, but tab **content**
isn't rebuilt to the design. Bring Live / Queue / Agents / History / Chat / Admin /
Plans to match `docs/design-handoff/project/js/screens-activity.jsx` (re-stage from the
bundle if the handoff dir was deleted — see §0 of the durable brief). Preserve
keybindings + localStorage keys; don't rename files/namespaces.

### Lane C — Profile request → approve flow  *(agents.profiles + admin)*
Design: "Members can request profiles; admins approve." Today create = INSTANCE_ADMIN
only. Add `agents.profiles.request` (any member; creates a pending profile —
`disabledAt` set or a `status` field) + `agents.profiles.approve`/`reject`
(instanceAdmin). Surface requests in `/admin/agents` and the "requires instance admin"
affordance in the workspace bind catalog becomes "Request a profile".

### Lane D — Wire the stubbed admin + binding affordances  *(small, mostly backend)*
- `/admin` header actions: **Backup now** (trigger a DB/MinIO backup job),
  **New tenant** (workspace create as instance admin), **Invite** (instance user invite).
  These render but are unwired (`instanceAdmin.*` mutations needed).
- Per-binding **Require approval** toggle: today the design shows it but the binding
  policy doesn't carry it (`requireApprovalBeforeStart` is workspace-level). Decide:
  add `Agent.requireApprovalBeforeStart` (binding-level override) or remove the toggle.
- Connection-mapping **Default labels** column: wire `labelIds` (the mutation already
  accepts them) with the workspace label picker.

### Lane E — MCP + CLI profile/binding awareness  *(integration)*
- MCP `agents.*` tools: add `agents.profiles.list/get` + keep `agents.list` (bindings)
  working. Ensure `runtimes.register` / heartbeat set `ownerId` so global runtime views
  populate for daemon-registered hosts (today backfilled; new registrations should set it).
- `forge` CLI (`tools/forge-cli/`): `forge agents` shows profiles vs bindings;
  `forge whoami` surfaces `instanceRole`.

### Lane F — Runtime full globalization  *(optional / schema)*
Today `Runtime.workspaceId` is still required; global views key off `ownerId`. If
desired, make `workspaceId` nullable (migration), update `runtime.ts` + runtime
services that assume non-null, and let daemon registration create owner-scoped global
runtimes directly. Verify dispatch/chat still resolve runtimes. Skip if ownerId-based
views are sufficient.

## 4. Pre-merge gate
```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e
pnpm build
```

## 5. Merge + deploy (LIVE — same procedure that shipped the restructure)
1. Reconcile in-branch: `git fetch origin && git merge origin/master`; re-run §4.
2. Self-delete this file (§7); commit.
3. Squash-merge to master from `/home/bailey/forge`; push `origin master`.
4. Deploy:
   ```bash
   cd ~/docker/forge
   GIT_SHA=$(git -C /home/bailey/forge rev-parse --short HEAD) \
   BUILD_TIME=$(date -u +%FT%TZ) docker compose build forge forge-worker
   docker compose up -d                # entrypoint runs migrate deploy
   # run any new backfill via: docker cp a .cjs into the container + `node` (prod has no tsx)
   ```
   The deployed SHA shows via `FORGE_GIT_SHA` (Settings → About + `/admin/system`).

## 6. Live smoke (deployed URL)
Per lane: complete an OAuth connect; request+approve a profile; switch all 7 Activity
tabs; trigger a wired admin action; confirm `system.buildInfo` shows the new SHA.

## 7. Self-delete (final step, before squash-merge)
```bash
rm -f docs/plans/multiws-followup-goal.md
# also drop the VitePress srcExclude entry for this file in docs/.vitepress/config.ts
git add -A && git commit -m "chore: remove temp follow-up goal plan (self-delete)"
```
Keep `docs/plans/multiws-restructure.md`.

---
**Goal-complete:** every §1 box checked, live smoke (§6) passing, this file gone.
</content>
