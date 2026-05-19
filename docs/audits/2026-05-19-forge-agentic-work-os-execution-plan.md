# Forge Agentic Work OS — Claude Code Long-Run Execution Plan

> **For Claude Code on Docker-Server:** This is a single-goal, long-run handoff for `~/forge`. Use agent teams/subtasks internally, but keep one orchestrated implementation thread. Commit in waves. Do not use direct production DB pokes except for read-only diagnostics or migrations through Prisma/deploy paths.

**Goal:** Turn the current Forge PM + agent/chat substrate into a cohesive agentic work OS: capture intent, curate context, execute via agent teams, produce durable artifacts, request/review human input, and optionally spatially arrange work on an infinite canvas.

**Architecture:** Add a small set of first-class primitives — `Artifact`, `ContextSet`, `ExecutionPlan/ExecutionStep`, `AgentCrew`, `ReviewGate`, `ActionRequest`, and `WorkspaceCanvas` — while reusing existing Forge foundations: workspace scoping, ActivityEvent/AuditLog, NotificationState, polymorphic Attachment/MinIO, ChatThread/ChatMessage, AgentRun/AgentRunEvent, Runtime/Agent, tRPC, MCP, and SSE. Ship in vertical slices so existing Issues/Chat/Agents remain stable throughout.

**Tech Stack:** Next.js 15 App Router, React, TypeScript, Prisma/Postgres, tRPC, Zod, Redis/BullMQ/SSE, MinIO attachments, Tailwind, Vitest, Playwright opt-in e2e, Forge MCP service layer.

---

## 0. Non-negotiables

1. **Canonical content lives in canonical tables.** Canvas/cards/promotions/context sets store references and layout/selection metadata; they do not duplicate issue/chat/artifact bodies.
2. **Every tenant row has `workspaceId`.** Every query is workspace-scoped via existing `workspaceProcedure`/MCP context rules.
3. **Use service/router paths, not ad hoc DB mutation.** Preserve audit, ActivityEvent, notification, SSE, webhook, and MCP semantics.
4. **Attachments stay polymorphic.** Extend allowed `targetType` validation for new entities; keep MinIO and `Attachment` as-is unless a migration is explicitly justified.
5. **Server-side settings only.** No localStorage as source of truth for product state.
6. **Agent/human trust is a product feature.** Every agent execution surface needs: context visibility, expected output, progress, review gate when needed, final evidence, follow-ups, and recovery controls.
7. **Public/general-use product.** Avoid Axiom-only names or private infra assumptions in reusable UI/docs.
8. **Design language:** Forge dark/warm-earthy tokens, subtle cyan accent, 8px radius, readable mobile layouts.

---

## 1. Current substrate to preserve

Before implementing, read these files and verify current names may have drifted:

- `CLAUDE.md`
- `DEVLOG.md`
- `prisma/schema.prisma`
- `src/server/trpc.ts`
- `src/server/services/mcp.ts`
- `src/server/services/storage.ts`
- `src/server/routers/chat.ts`
- `src/server/services/chat-context.ts`
- `src/server/services/agent-run.ts`
- `src/server/routers/inbox.ts`
- `src/components/chat/chat-workspace.tsx`
- `src/components/chat/chat-status-rail.tsx`
- `src/components/attachments/issue-attachments-panel.tsx`
- `src/components/sidebar-nav.ts`

Known shipped capabilities to lean on:

- Conversations v2: named `ChatThread`, summary/compaction, context modes, selected-thread dispatch.
- Chat attachments: pending message → upload/finalize `chat-message` attachments → dispatch.
- Agent runs: `AgentRun`, `AgentRunEvent`, status comments, stalled-run worker, control/kick paths.
- Runtime primitive: `Runtime`, `runtimes.*` MCP tools, `runs.recordUsage`.
- Notifications/Inbox: `ActivityEvent`, `NotificationState`, `waitingOnMe` query, persistent alert lifecycle.
- Attachments: polymorphic `Attachment` with `targetType/targetId`, link rows, MinIO file rows.

---

## 2. Agent team structure for the long run

Use one Claude Code goal, but split work internally into these teams. Each team should produce code/tests/docs for its slice and hand off via commits.

### Team A — Product architecture / schema steward

Owns data-model boundaries, migrations, service-layer contracts, permission rules, and event/audit semantics.

### Team B — Backend/API/MCP

Owns tRPC routers, service functions, MCP tool exposure, context bundle expansion, worker jobs, and tests.

### Team C — Frontend/surfaces

Owns nav, Capture Sheet, Artifacts, Context Inspector, Command Center, Canvas, ReviewGate/ActionRequest UI, responsive polish.

### Team D — Hermes/agent execution integration

Owns prompts/context shape, completion contracts, agent team execution flow, run events, usage telemetry, stalled/retry behavior.

### Team E — QA/docs/deploy

Owns Vitest/Playwright coverage, migration deployment, docs, DEVLOG, build, Docker deploy, live smoke, and rollback notes.

---

## 3. High-level implementation waves

This is intentionally ordered from lowest-risk cohesion to deeper primitives.

### Wave 0 — Baseline and safety rails

**Objective:** Establish current health and prevent regression during the long run.

Tasks:
1. `git status --short && git pull --ff-only`.
2. Read `CLAUDE.md` and `DEVLOG.md`.
3. Run current baseline:
   - `pnpm vitest run src/server/routers/__tests__/chat.test.ts src/server/services/__tests__/mcp.test.ts tests/unit/sidebar-nav.test.ts`
   - `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`
4. Confirm Prisma client is generated and migrations are applied locally with `pnpm prisma migrate deploy` if needed.
5. Add/refresh this plan in docs if missing.

Commit: `docs: add agentic work os execution plan`

Acceptance:
- Baseline tests/typecheck pass or failures are documented as pre-existing.
- No feature code changed yet.

---

### Wave 1 — Shared entity reference and safe rich renderer

**Objective:** Create the reusable foundation needed by artifacts, context sets, canvas cards, action requests, and cross-surface refs.

Add a shared typed entity reference contract:

```ts
export const forgeEntityTypeSchema = z.enum([
  "issue",
  "project",
  "initiative",
  "cycle",
  "chat-thread",
  "chat-message",
  "agent",
  "agent-run",
  "artifact",
  "context-set",
  "execution-plan",
  "execution-step",
  "action-request",
  "attachment",
  "note",
]);

export const forgeEntityRefSchema = z.object({
  type: forgeEntityTypeSchema,
  id: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  label: z.string().optional(),
});
```

Suggested files:
- Create `src/lib/entity-ref.ts`
- Create `src/server/services/entity-hydration.ts`
- Add unit tests under `tests/unit/entity-ref.test.ts` or `src/server/services/__tests__/entity-hydration.test.ts`

Renderer unification:
- Identify current chat markdown and issue/comment renderers.
- Create one safe renderer component for chat/comment/artifact bodies.
- Support basic GFM-like features already needed: links, inline code, fenced code, lists, task lists, blockquotes, tables if dependency-light, and Forge entity refs.
- Do not add heavy deps unless tests and bundle impact are acceptable.

Acceptance:
- Same markdown sample renders equivalently in chat and comments.
- Entity refs can hydrate enough display metadata for at least issue, chat thread, attachment, and future artifact stub.
- Existing chat tests still pass.

Commit: `feat: add shared entity refs and renderer foundation`

---

### Wave 2 — Artifact primitive v1

**Objective:** Add a durable, versionable output object for specs, decisions, runbooks, reports, briefs, verification logs, and accepted agent deliverables.

Schema direction:

```prisma
model Artifact {
  id          String         @id @default(cuid())
  workspaceId String
  title       String
  slug        String
  type        ArtifactType   @default(DOCUMENT)
  status      ArtifactStatus @default(DRAFT)
  body        String         @db.Text
  createdById String?
  createdByAgentId String?
  sourceType  String?
  sourceId    String?
  currentVersionId String?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  archivedAt  DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  versions  ArtifactVersion[]

  @@unique([workspaceId, slug])
  @@index([workspaceId, status, updatedAt])
}

model ArtifactVersion {
  id          String   @id @default(cuid())
  workspaceId String
  artifactId  String
  version     Int
  title       String
  body        String   @db.Text
  summary     String?  @db.Text
  createdById String?
  createdByAgentId String?
  createdAt   DateTime @default(now())

  artifact Artifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([artifactId, version])
  @@index([workspaceId, createdAt])
}

enum ArtifactType {
  DOCUMENT
  DECISION
  RUNBOOK
  REPORT
  SPEC
  BRIEF
  VERIFICATION
}

enum ArtifactStatus {
  DRAFT
  IN_REVIEW
  ACCEPTED
  ARCHIVED
}
```

Implementation:
- Migration + Prisma client.
- `artifact` router: list, get, create, update, archive, promoteFromSource.
- `artifact` service writes AuditLog + ActivityEvent.
- Extend `Attachment` allowed target types with `artifact`.
- Reusable `AttachmentsPanel` target abstraction instead of issue-only panel.
- MCP tools: `artifacts.list/get/create/update/archive` if scope model allows, or add to `agent.context.bundle` first if faster.
- UI route: `/w/[slug]/artifacts` and `/w/[slug]/artifacts/[id]`, or start with project/detail panels if nav is too much.

Acceptance:
- Can create an Artifact from scratch.
- Can promote a ChatMessage or Comment into an Artifact with source backlink.
- Can attach files/links to an Artifact using existing storage flow.
- Artifact appears in ActivityEvent/AuditLog.
- Agent context bundle can include linked artifacts.

Commit: `feat: add artifact primitive`

---

### Wave 3 — Capture Sheet and promotion flow

**Objective:** One capture path for issue, note, artifact, action request, and later execution plan.

Implementation:
- Replace or wrap current quick-create with `CaptureSheet`.
- Destinations: Issue, Artifact, Note, ActionRequest placeholder.
- Inputs: title/body, workspace, project, initiative, labels, priority, due date, agent/queue, attachments/links, acceptance criteria, context refs.
- Source-aware promotions from:
  - Chat message
  - Comment
  - Note
  - Attachment/link
  - Agent run summary
- Promotions should preserve source refs and backlinks.

Suggested files:
- `src/components/capture/capture-sheet.tsx`
- `src/components/capture/promote-menu.tsx`
- `src/server/routers/capture.ts` or service methods called by existing routers

Acceptance:
- A chat answer can become an issue or artifact with source backlink and attachments.
- Issue creation still works exactly as before through old routes.
- Mobile layout remains usable.

Commit: `feat: add unified capture and promotion flow`

---

### Wave 4 — ContextSet + context inspector

**Objective:** Make “what did the agent see?” auditable and reusable.

Schema direction:

```prisma
model ContextSet {
  id          String   @id @default(cuid())
  workspaceId String
  name        String
  description String? @db.Text
  ownerUserId String?
  ownerAgentId String?
  policy      Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  archivedAt  DateTime?
  items       ContextSetItem[]

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, updatedAt])
}

model ContextSetItem {
  id          String @id @default(cuid())
  workspaceId String
  contextSetId String
  targetType  String
  targetId    String
  includeMode String @default("INCLUDE") // INCLUDE | EXCLUDE | SUMMARY_ONLY
  position    Int    @default(0)
  note        String? @db.Text

  contextSet ContextSet @relation(fields: [contextSetId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@unique([contextSetId, targetType, targetId])
  @@index([workspaceId, targetType, targetId])
}
```

Implementation:
- Router/service for CRUD and item management.
- Context inspector component embeddable in Chat, Issue detail, AgentRun strip, and future ExecutionPlan.
- Extend MCP `agent.context.bundle` to include explicit selected ContextSet and diagnostics.
- Store context snapshot on AgentRun or ChatMessage when dispatching.

Acceptance:
- Operator can see and edit included/excluded context before dispatch.
- Context bundle output is deterministic and test-covered.
- Agents receive context-set metadata in MCP bundle.

Commit: `feat: add context sets and inspector`

---

### Wave 5 — Agent completion contract

**Objective:** Make agent runs dependable by defining “done means...” before dispatch and enforcing structured completion after.

Schema/options:
- Prefer lightweight issue metadata if existing `Issue` has appropriate JSON fields; otherwise add explicit fields:
  - `Issue.expectedOutput String? @db.Text`
  - `Issue.verificationChecklist Json?`
  - or model `IssueCompletionContract` if richer.

Implementation:
- Issue detail panel: expected output, verification checklist, artifact requirement toggle.
- MCP issue/context bundle includes completion contract.
- Agent final response parser/contract docs: summary, evidence, artifacts, verification, follow-ups.
- `AgentRun.summary` should link produced artifact(s) and verification result.
- Add guardrails for retry/kick if a run has no final contract.

Acceptance:
- Before dispatch/queue, an issue can show expected output and verification checklist.
- Agent-run final view shows summary/evidence/artifacts/follow-ups.
- Tests assert context bundle includes contract.

Commit: `feat: add agent completion contract`

---

### Wave 6 — ExecutionPlan / ExecutionStep

**Objective:** First-class planned multi-agent execution under issues/projects.

Schema direction:

```prisma
model ExecutionPlan {
  id          String @id @default(cuid())
  workspaceId String
  title       String
  description String? @db.Text
  issueId     String?
  projectId   String?
  status      ExecutionPlanStatus @default(DRAFT)
  createdById String?
  createdByAgentId String?
  contextSetId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  archivedAt DateTime?
  steps ExecutionStep[]

  @@index([workspaceId, status, updatedAt])
  @@index([issueId])
  @@index([projectId])
}

model ExecutionStep {
  id          String @id @default(cuid())
  workspaceId String
  planId      String
  title       String
  body        String? @db.Text
  position    Int
  status      ExecutionStepStatus @default(TODO)
  assignedAgentId String?
  assignedUserId String?
  expectedOutput String? @db.Text
  verification Json?
  sourceRunId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status])
  @@index([assignedAgentId, status])
}
```

Enums:
- `ExecutionPlanStatus`: DRAFT, APPROVED, RUNNING, BLOCKED, COMPLETED, CANCELED
- `ExecutionStepStatus`: TODO, READY, RUNNING, BLOCKED, REVIEW, DONE, CANCELED

Implementation:
- Plan builder UI on issue/project detail.
- Step assignment to agent/human.
- Dependency support can be deferred; add simple `dependsOnStepIds String[]` if necessary.
- Convert selected plan steps to queued issues only if the operator chooses; do not auto-spam issues.
- MCP tools for plan read/update and step status.

Acceptance:
- A project or issue can own an execution plan with ordered steps.
- Steps can be assigned to agents and surfaced in their context/queue.
- Plan state changes emit ActivityEvent and are visible in timeline.

Commit: `feat: add execution plans and steps`

---

### Wave 7 — AgentCrew + ReviewGate

**Objective:** Support agent teams with planner/worker/reviewer roles and explicit human/agent approval gates.

Schema direction:

```prisma
model AgentCrew {
  id          String @id @default(cuid())
  workspaceId String
  name        String
  description String? @db.Text
  maxParallel Int @default(1)
  policy      Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  archivedAt DateTime?
  members AgentCrewMember[]
}

model AgentCrewMember {
  id String @id @default(cuid())
  workspaceId String
  crewId String
  agentId String
  role String // PLANNER | WORKER | REVIEWER | OBSERVER | OPERATOR_PROXY
  position Int @default(0)
  @@unique([crewId, agentId, role])
}

model ReviewGate {
  id          String @id @default(cuid())
  workspaceId String
  targetType  String
  targetId    String
  status      ReviewGateStatus @default(PENDING)
  requiredRole String?
  requestedById String?
  requestedByAgentId String?
  resolvedById String?
  prompt      String @db.Text
  resolution  String? @db.Text
  createdAt DateTime @default(now())
  resolvedAt DateTime?
  @@index([workspaceId, status, createdAt])
  @@index([workspaceId, targetType, targetId])
}
```

Implementation:
- Crew settings/admin surface.
- Assign ExecutionPlan to a crew.
- ReviewGate UI on plans, artifacts, action requests, and sensitive agent actions.
- MCP read tools for crews/gates; mutations should be carefully scoped.

Acceptance:
- Operator can define a crew of existing agents.
- ExecutionPlan can be associated with a crew.
- ReviewGate blocks progression until approved/rejected and creates NotificationState.

Commit: `feat: add agent crews and review gates`

---

### Wave 8 — ActionRequest / Mention / Waiting-on-me unification

**Objective:** Replace vague notifications with precise, resolvable asks.

Schema direction:

```prisma
model ActionRequest {
  id          String @id @default(cuid())
  workspaceId String
  title       String
  body        String? @db.Text
  status      ActionRequestStatus @default(OPEN)
  severity    NotificationSeverity @default(INFO)
  requestedByUserId String?
  requestedByAgentId String?
  assignedUserId String?
  assignedAgentId String?
  sourceType String?
  sourceId   String?
  dueAt      DateTime?
  resolvedAt DateTime?
  resolution String? @db.Text
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId, status, createdAt])
  @@index([assignedUserId, status])
  @@index([assignedAgentId, status])
}
```

Implementation:
- Mention parser can create ActionRequest from comment/chat if explicit pattern is used.
- Inbox `waitingOnMe` should include open ActionRequests.
- Agent blocked runs should create ActionRequests instead of just passive events.
- Resolution path writes ActivityEvent and updates NotificationState.

Acceptance:
- Agent can request input and it appears as an actionable Inbox item.
- Operator can resolve/answer the request and link back to source.
- Stalled/blocked run UI routes to the request, not just the run row.

Commit: `feat: add action requests`

---

### Wave 9 — Cross-workspace Command Center v0

**Objective:** Daily operator home across AXI/PER/WRK-like scopes without breaking workspace tenancy.

Implementation:
- Route: `/home` or `/w/[slug]/command-center` with all-workspaces option if existing auth supports it.
- Read model combines:
  - open ActionRequests assigned to me
  - stalled/blocked agent runs
  - due soon issues
  - active timers
  - current sprint/cycle warnings
  - pinned/recent work
  - review gates waiting on me
  - recent artifacts needing review
- Writes remain workspace-scoped and route to canonical detail pages.

Acceptance:
- Operator can start day from one surface.
- No cross-workspace data leaks for users without membership.
- Mobile layout is useful.

Commit: `feat: add command center v0`

---

### Wave 10 — WorkspaceCanvas / spatial infinite canvas spike

**Objective:** Add Figma/Cate-style spatial synthesis without creating a second source of truth.

Reference: Cate (`github.com/0-AI-UG/cate`) is a useful pattern source: infinite canvas + docking, regions, annotations, minimap, snap guides, connections, panels. Do not fork the Electron app into Forge. Borrow the panel/card contract and interaction patterns.

Schema direction:

```prisma
model WorkspaceCanvas {
  id          String @id @default(cuid())
  workspaceId String
  name        String
  scopeType   String? // workspace | project | issue | initiative | user
  scopeId     String?
  viewport    Json?
  createdById String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  archivedAt DateTime?
  nodes WorkspaceCanvasNode[]
  edges WorkspaceCanvasEdge[]

  @@index([workspaceId, scopeType, scopeId])
}

model WorkspaceCanvasNode {
  id          String @id @default(cuid())
  workspaceId String
  canvasId    String
  targetType  String
  targetId    String
  x           Float
  y           Float
  width       Float
  height      Float
  zIndex      Int @default(0)
  collapsed   Boolean @default(false)
  viewMode    String? // card | full | compact | live
  meta        Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([canvasId, zIndex])
  @@index([workspaceId, targetType, targetId])
}

model WorkspaceCanvasEdge {
  id          String @id @default(cuid())
  workspaceId String
  canvasId    String
  fromNodeId  String
  toNodeId    String
  label       String?
  kind        String?
  meta        Json?
  createdAt DateTime @default(now())
  @@index([canvasId])
}
```

Implementation options to evaluate briefly before coding:
- Custom pan/zoom + absolute-position cards: most control, likely enough for v0.
- React Flow: good graph primitives, but may fight Figma-like arbitrary content cards.
- tldraw: strong whiteboard, heavier conceptual dependency; verify licensing/deps.

First slice:
- Project-level Canvas tab or `/w/[slug]/canvas`.
- Add cards from command palette/search.
- Supported card types v0: issue, artifact, chat thread, attachment/file, agent run, execution plan/step.
- Cards use canonical routers/renderers and obey permissions.
- Persist only layout/entity refs.
- Add minimap/snap/edges later if v0 is stable.

Acceptance:
- Create/save/reopen a canvas with at least one issue, one artifact, one file attachment, and one chat thread card.
- Opening a card navigates to canonical route.
- Deleting a card does not delete source object.
- If source object is inaccessible/deleted, card shows dead-ref fallback.

Commit: `feat: add workspace canvas spike`

---

### Wave 11 — MCP and Hermes integration pass

**Objective:** Make new primitives useful to agents, not just humans.

MCP additions, ordered by value:
1. `artifacts.*`
2. `contextSets.*`
3. `executionPlans.*`
4. `actionRequests.*`
5. `reviewGates.*` read/list/respond if safe
6. Canvas read/list only; mutation can wait

Context bundle additions:
- For issue: linked artifacts, completion contract, context sets, execution plan summary, open action requests/review gates.
- For chat thread: selected ContextSet, linked artifacts, recent action requests.
- For execution plan: steps, crew, context set, gates, artifacts.

Agent prompt contract:
- Every agent work prompt should state:
  - goal
  - canonical entity links/ids
  - selected context set
  - expected output
  - verification checklist
  - artifact requirements
  - review gates
  - allowed mutations/tools
  - final response schema

Acceptance:
- MCP tests cover new tool schemas and resource narrowing.
- Existing Hermes chat delivery path still works.
- Synthetic chat/issue dispatch includes new context without crashing older agents.

Commit: `feat: expose work os primitives to mcp`

---

### Wave 12 — Docs, deployment, and live verification

**Objective:** Ship safely and make the new model understandable.

Docs:
- `docs/concepts/primitives.md` — update primitive map.
- `docs/agents/overview.md` — agent teams, runs, completion contract.
- `docs/guide/inbox.md` — ActionRequests and waiting-on-me.
- `docs/guide/time-and-attachments.md` — Artifact attachments.
- `docs/guide/keyboard.md` — new nav/chords.
- `DEVLOG.md` — append full session summary and verification.

Verification commands:
- `pnpm prisma migrate deploy`
- `pnpm prisma generate`
- `pnpm vitest run src/server/services/__tests__/mcp.test.ts src/server/routers/__tests__/chat.test.ts`
- `pnpm test`
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint`
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`

Live deployment:
- Use existing Docker compose in `/home/bailey/docker/forge/docker-compose.yaml`.
- Build/deploy web + worker only after tests/build pass.
- Verify:
  - public signin redirect still works
  - `/w/axi/chat` loads authenticated
  - artifact route loads
  - command center loads
  - worker logs healthy
  - no new failed webhook deliveries
  - synthetic chat still returns via Hermes

Commit: `docs: document agentic work os primitives`

---

## 4. Suggested single-goal prompt for Claude Code

Paste this into Claude Code from `~/forge` on Docker-Server:

```text
You are Claude Code on Docker-Server working in /home/bailey/forge. Implement the Forge Agentic Work OS roadmap as a single long-running, agent-team-style execution. Read CLAUDE.md, DEVLOG.md, docs/audits/2026-05-19-forge-agentic-work-os-execution-plan.md, prisma/schema.prisma, src/server/services/mcp.ts, src/server/routers/chat.ts, src/server/services/chat-context.ts, src/server/services/storage.ts, and src/components/sidebar-nav.ts before changing code.

Goal: evolve Forge from PM + chat + agents into a cohesive agentic work OS. Add or harden these primitives and surfaces in safe vertical slices: shared entity refs and unified renderer; Artifact; Capture Sheet/promotions; ContextSet/context inspector; agent completion contract; ExecutionPlan/ExecutionStep; AgentCrew/ReviewGate; ActionRequest/Mention; cross-workspace Command Center; WorkspaceCanvas spatial board; MCP/Hermes context exposure; docs/deploy verification.

Constraints:
- Preserve existing Issues/Chat/Agents/Hermes delivery behavior.
- Use tRPC/services/MCP paths; do not direct-mutate production DB outside Prisma migrations/deploy verification.
- Every tenant row needs workspaceId and membership/resource checks.
- Reuse polymorphic Attachment + MinIO for files/links.
- Canvas stores layout + entity refs only, never duplicated canonical content.
- Emit AuditLog/ActivityEvent/NotificationState where existing patterns require it.
- Server-side product state only; no localStorage as source of truth.
- Keep UI mobile-friendly and aligned to Forge dark/warm-earthy design.
- Commit after each working wave with tests.

Execution style:
- Use internal subagents/agent teams for schema/backend/frontend/MCP/QA when helpful.
- Work wave-by-wave from the plan; do not attempt a giant unverified patch.
- For every wave: write tests first where practical, implement, run targeted tests, then commit.
- If scope gets too large, ship the first coherent subset with docs and TODOs rather than leaving the app broken.

Minimum acceptance for this run:
1. New plan/docs committed.
2. Shared entity refs + renderer foundation shipped.
3. Artifact primitive with attachments and promote-from-chat/comment/note shipped.
4. ContextSet/context inspector + agent completion contract shipped.
5. At least one of ExecutionPlan/ActionRequest/CommandCenter/WorkspaceCanvas shipped as a functional v0, with the rest scaffolded behind safe docs/TODOs if necessary.
6. MCP/context bundle updated for every shipped primitive.
7. `pnpm test`, `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`, `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint`, and `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` pass before deployment.
8. DEVLOG updated with what shipped, what was deferred, migrations, and verification.

Start by printing a short wave plan and current git/test baseline, then proceed without asking for more clarification unless a destructive deployment/secret action is required.
```

---

## 5. Risk / cut-line guidance

If the run is getting too large, cut in this order:

1. Must ship: entity refs, renderer foundation, Artifact, promotion, ContextSet, completion contract.
2. Strong next: ActionRequest and Command Center because they improve daily operation immediately.
3. Then: ExecutionPlan/ExecutionStep because multi-agent work needs it.
4. Then: AgentCrew/ReviewGate because it formalizes team execution and safety.
5. Last in this run: WorkspaceCanvas because it is high-upside but should sit on stable Artifact/Context/Plan primitives.

Do not let Canvas consume the whole run. Tiny whiteboard hydra is charming until it eats the PM system.

---

## 6. Final verification checklist

- [ ] Migrations apply cleanly.
- [ ] Prisma client regenerated.
- [ ] New routers have authorization tests.
- [ ] MCP schemas validate and resource narrowing still works.
- [ ] Existing chat/Hermes delivery tests pass.
- [ ] Artifact attachment upload/finalize/list works.
- [ ] Promotion from chat/comment/note preserves source refs.
- [ ] Agent context bundle includes shipped primitives.
- [ ] UI routes load at desktop and mobile widths.
- [ ] Worker still boots.
- [ ] `pnpm test` pass.
- [ ] `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` pass.
- [ ] `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` pass.
- [ ] `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` pass.
- [ ] DEVLOG updated.
- [ ] Git status clean except intentional untracked artifacts.
