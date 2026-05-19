# Agent Dispatch Inbox Implementation Map

## Overview

This document maps how Forge currently creates/updates `AgentRun` rows, dispatches webhooks to agents, and surfaces inbox-like data through MCP tools. It serves as the foundation for the **Durable Agent Dispatch Inbox plan**, which will:

1. Make webhooks **wake-only** (no transactional AgentRun creation on delivery success)
2. Introduce a **canonical inbox tied to AgentRun creation at event time** (not at webhook delivery success)
3. Preserve fire-and-forget Redis patterns while adding durable queue semantics for inbox presence

---

## 1. AgentRun Service (`src/server/services/agent-run.ts`)

### Exported Functions

#### `findActiveRun(tx, params): Promise<AgentRun | null>`
- **Args:** `(issueId, agentId)`
- **Returns:** Single ACTIVE run for the (issue, agent) tuple or null
- **Writes:** None (read-only)
- **Callers:** `openOrTouchRun()` (line 100), comment workflow

#### `openOrTouchRun(tx, params): Promise<{ run, isNew }>`
- **Lines:** 89–157
- **Args:** `workspaceId`, `issueId`, `agentId`, `actorId?`, `assignmentEventId?`, `currentStep?`
- **Writes:**
  - `AgentRun` row (create or touch `lastEventAt`)
  - `AgentRunEvent` row with kind="STARTED" (only on creation)
  - Via `recordChange()`: `AuditLog`, `ActivityEvent`, `WebhookDelivery` rows
- **Returns:** `{ run, isNew }` — callers branch on `isNew` to suppress duplicate notifications
- **Callers:** `recordAgentAction()`, comment workflow, mcp.ts

#### `appendRunEvent(tx, params): Promise<void>`
- **Lines:** 170–212
- **Args:** `runId`, `workspaceId`, `issueId`, `agentId`, `kind`, `payload?`, `currentStep?`
- **Writes:**
  - `AgentRunEvent` row
  - Update `AgentRun.lastEventAt` + optional `currentStep`
  - Fire-and-forget Redis publish (no AuditLog, no ActivityEvent)

#### `finishRun(tx, params): Promise<AgentRun | null>`
- **Lines:** 223–282
- **Args:** `runId`, `workspaceId`, `issueId`, `agentId`, `status` ("COMPLETED" | "ABANDONED" | "STALLED"), `summary?`, `actorId?`
- **Writes:** Update run status + finishedAt, create AgentRunEvent, emit via recordChange()
- **Returns:** Finished run or null if already terminal (idempotent)

#### `recordAgentAction(tx, params): Promise<{ runId, isNewRun }>`
- **Lines:** 294–331
- **Args:** Same as openOrTouchRun + `kind` (freeform)
- **Behavior:** Opens/touches run + conditionally appends event (skips duplicate STARTED)
- **Returns:** `{ runId, isNewRun }`
- **Callers:** worker.ts (line 173), issue.ts, mcp.ts

#### `finishRunsForIssue(tx, params): Promise<number>`
- **Lines:** 341–365
- **Args:** `workspaceId`, `issueId`, `status` ("COMPLETED" | "ABANDONED"), `actorId?`
- **Returns:** Count closed

---

## 2. Audit Service (`src/server/audit.ts`)

### `recordChange()` — Single Transaction Writes
- **Lines:** 185–483
- **Writes in one tx:**
  1. `AuditLog` row (line 203)
  2. `ActivityEvent` row (line 259)
  3. `WebhookDelivery` rows (line 468) — fan-out to all subscriber webhooks + agent-routed shims

### Agent Dispatch Fan-out Branches

**(a) AGENT_ASSIGNED / ISSUE_QUEUED (lines 304–321)**
- Condition: Issue subject + agent assigned with `webhookUrl`
- Creates: One `WebhookDelivery` for generic `agent:dispatch` shim
- Agent.webhookUrl: **Required**

**(b) ISSUE_PRIORITY_CHANGED HIGH/URGENT (lines 326–348)**
- Condition: Priority escalation on assigned issue
- Creates: Per-agent `agent:dispatch:{agentId}` shim
- Agent.webhookUrl: **Required**

**(c) COMMENT_CREATED @-mentions (lines 353–383)**
- Condition: Mentions in payload
- Creates: One shim per mentioned agent
- Agent.webhookUrl: **Required** (filtered in query)

**(d) CHAT_MESSAGE_POSTED USER→Agent (lines 385–411)**
- Condition: USER role + agentId in payload
- Creates: Per-agent shim for addressed agent
- Agent.webhookUrl: **Required**

**(e) Watchers — Any Issue Event (lines 424–454)**
- Condition: Issue subject + agent watchers with webhookUrl
- Creates: One shim per watcher (skip self)
- Agent.webhookUrl: **Required**

---

## 3. Worker (`src/server/worker.ts`)

### Webhook Delivery Job (lines 51–214)
1. **Resolution (lines 66–131):** Resolve synthetic dispatch URLs to real agent webhook + secret
2. **Delivery (lines 133–155):** HTTP POST with HMAC; update WebhookDelivery status
3. **Post-Success (lines 156–209):**
   - Call `recordAgentReachable()` to bump agent presence
   - **CRITICAL (lines 171–186):** Call `recordAgentAction()` to create/touch AgentRun:
     ```typescript
     await recordAgentAction(tx, {
       workspaceId: delivery.event.workspaceId,
       issueId: delivery.event.subjectId,
       agentId: presenceAgentId!,
       kind: delivery.event.kind === "AGENT_ASSIGNED" ? "DISPATCH_RECEIVED" : `DISPATCH_${delivery.event.kind}`,
       assignmentEventId: delivery.event.kind === "AGENT_ASSIGNED" ? delivery.event.id : null,
       payload: { eventId: delivery.event.id, eventKind: delivery.event.kind },
     });
     ```
   - Schedule required-ack check if workspace opted in

### Maintenance Queue (lines 228–268)
- 6 recurring sweep jobs (heartbeat, delivery-drain, stale-work, sla-breach, agent-run-stale, chat-compaction)
- Stable jobIds so repeats upsert (auto-register on module load)

### Retry & Backoff
- Increment attempt on every update
- Dead-letter at attempt >= 5
- Drain PENDING rows in 100-row batches every 5s

---

## 4. Prisma Schema

**AgentRun** (lines 1532+)
```
id, workspaceId, issueId, agentId, status (ACTIVE|COMPLETED|ABANDONED|STALLED), 
startedAt, lastEventAt, finishedAt, currentStep, summary, producedArtifactIds, 
verificationResult, followUps, assignmentEventId, tokensIn, tokensOut, tokensCached, 
costUsd, controlState, controlRequestedAt, controlRequestedById
Indexes: (workspaceId, status, lastEventAt), (issueId, startedAt), (agentId, status)
```

**AgentRunEvent** (lines 1602+)
```
id, workspaceId, runId, kind (freeform string), payload (Json), createdAt
Indexes: (runId, createdAt), (workspaceId, createdAt)
```

**WebhookDelivery** (lines 1246+)
```
id, webhookId, eventId, status (PENDING|SUCCESS|FAILED|DEAD_LETTER), attempt, 
responseStatus, responseBody, scheduledAt, deliveredAt
Indexes: (status, scheduledAt), (webhookId)
```

**Webhook** (lines 1229+)
```
id, workspaceId, pluginId, url, secret, events (EventKind[]), active
Indexes: (workspaceId, active)
```

**ActivityEvent** (lines 1066+)
```
id, workspaceId, kind (EventKind), actorId, subjectType, subjectId, payload, createdAt
Indexes: (workspaceId, kind, createdAt), (workspaceId, subjectType, subjectId)
```

**Agent** (lines 1412+)
```
id, workspaceId, name, profileKey, description, avatar, provider, runtimeMode, 
webhookUrl, webhookSecret, runtimeId, capabilities, role, templateMarkdown, 
status, lastHeartbeatAt, maxConcurrent, lastDispatchedAt, archivedAt, createdAt, updatedAt
Indexes: (workspaceId, profileKey) UNIQUE, (workspaceId, status), (runtimeId)
```

---

## 5. Inbox-Like MCP Tools (`src/server/services/mcp.ts`)

| Tool | Lines | Scope | Purpose |
|------|-------|-------|---------|
| `agents.me` | 3560–3595 | READ_USERS | Resolve calling agent from linkedAgentId |
| `agents.heartbeat` | 3596–3667 | READ_USERS | Update agent presence (bumps lastHeartbeatAt) |
| `runs.recordUsage` | 4114–4164 | WRITE_ISSUES | Record token telemetry; requires linkedAgentId |
| `runs.list` | 4286–4360 | READ_ISSUES | List runs; cursor-paginated; scope-gated by issue narrowing |
| `runs.kick` | 4363–4451 | WRITE_ISSUES | Re-dispatch stalled-but-active run; calls recordChange() + direct webhook |
| `agent.context.bundle` | 4579–4750+ | READ_ISSUES | Hydrate issue/chat context for agent decision-making |

---

## 6. ApiKey Context & linkedAgentId

**Location:** `src/server/services/api-key-auth.ts` (lines 21–36)

```typescript
export interface ApiKeyContext {
  keyId: string;
  workspaceId: string;
  userId: string | null;
  pluginId: string | null;
  scopes: PluginScope[];
  projectIds: string[];
  labelIds: string[];
  initiativeIds: string[];
  linkedAgentId: string | null;  // Agent id for AGENT-kind keys
}
```

**Flow to MCP:**
1. Route handler `/api/mcp/rpc` extracts `Authorization: Bearer` header
2. Calls `authenticateApiKey()` (lines 47–81) → `ApiKeyContext`
3. Wraps in `McpContext` for tool handlers
4. Tools access `ctx.apiKey?.linkedAgentId` directly (e.g., mcp.ts line 4145)

---

## 7. Chat Dispatch Path

**Router:** `src/server/routers/chat.ts` (lines 1+)

- **Message creation:** Store + call `recordChange()` with `CHAT_MESSAGE_POSTED`
- **Payload:** `{ threadId, messageId, agentId, role (USER|AGENT), body?, context?, sourceRunId?, attachments? }`
- **Fan-out:** Via audit.ts branch (d) → per-agent dispatch shim
- **SSE:** Client subscribes to workspace events; shows agent replies in real-time

**Component:** `src/server/components/chat/chat-workspace.tsx`
- Drafting: optimistic local state
- Typing indicator: SYSTEM ChatMessage role (not an event)
- Live updates: via ChatContextProvider SSE subscription

---

## 8. Test Files

- `/src/server/services/__tests__/agent-run-stale.test.ts` — Stale run closing
- `/src/server/services/__tests__/mcp.test.ts` — MCP tool validation
- `/src/server/routers/__tests__/chat.test.ts` — Chat dispatch
- Patterns: `createWorkspaceFixture()`, `createIssue()`, real Postgres (no mocks)

---

## Critical Sharp Edges

1. **Transaction boundaries:** `recordChange()` is the ONLY place `WebhookDelivery` rows are created; must be in same tx as triggering write.

2. **Fire-and-forget Redis:** Both `publishRunEvent()` and `publish()` are fire-and-forget with no error handling; `ActivityEvent` + `WebhookDelivery` are the durable log.

3. **Synthetic dispatch URLs:** Both `agent:dispatch` (resolves at delivery time) and `agent:dispatch:{agentId}` (baked-in); excluded from broadcast webhook query to prevent self-paging.

4. **No current link between WebhookDelivery ↔ AgentRun:** Both created separately; correlation is implicit via (agentId, issueId). **Critical for inbox plan:** Moving run creation to event time de-couples it from delivery.

5. **assignmentEventId pointer:** `AgentRun.assignmentEventId` points to `ActivityEvent.id` that triggered it; only set for AGENT_ASSIGNED; fragile if ActivityEvent is deleted.

6. **Scope narrowing:** MCP tools respect `ctx.apiKey.(projectIds|labelIds|initiativeIds)`; no super-agent scope.

7. **Required-ack scheduling:** Scheduled after transaction commit only on successful AGENT_ASSIGNED delivery; silent loss if scheduling fails.

8. **Deduplication:** `upsertAgentDispatchWebhook()` checks `(workspaceId, url)` uniqueness; `agentWebhookIds` dedup loop prevents double-adds.

---

## Key Injection Points for Inbox Plan

### 1. Canonical Run Creation at Event Time
- Move `recordAgentAction()` call from worker.ts (line 173) → audit.ts `recordChange()`
- Inject after `ActivityEvent` creation (line 259) for agent-routed events (branches a–e)
- Guard by agent presence (`webhookUrl` non-null)
- Opens `AgentRun.ACTIVE` with `assignmentEventId = event.id` (AGENT_ASSIGNED only)

### 2. Inbox Table Design
- Add `AgentDispatchInbox` table: `(workspaceId, agentId, eventId, kind, issueId, createdAt, readAt?)`
- Index: `(workspaceId, agentId, readAt, createdAt DESC)` for "unread inbox" queries

### 3. MCP Tool: `runs.assigned` (New)
- **Scope:** `READ_ISSUES`
- **Input:** `{ limit?: 50, offset?: 0, unreadOnly?: false }`
- **Output:** Cursor-paginated inbox rows + minimal run metadata
- **Guard:** `ctx.apiKey?.linkedAgentId` required; respect narrowing

### 4. Wake-Only Webhooks
- `WebhookDelivery` remains durable queue (no change)
- Delivery job success no longer creates run (remove from worker.ts)
- Run exists at event time; agent wakes to existing run + queries via MCP
- Retries unchanged; run remains ACTIVE waiting for agent pickup

### 5. Presence Signal Decoupling
- Current: `presenceAgentId` set only on successful delivery (worker.ts line 130)
- Future: `presenceAgentId` inferred from run creation at event time
- `recordAgentReachable()` call unchanged; run guaranteed to exist

---

## Summary: Files & Lines to Edit

| File | Lines | Action |
|------|-------|--------|
| `audit.ts` | 259+ | After ActivityEvent creation, call `createAgentRunAtEvent()` for agent-routed events |
| `agent-run.ts` | TBD | Add `createAgentRunAtEvent(tx, params)` — run at event time |
| `worker.ts` | 171–186 | Remove `recordAgentAction()` call; keep presenceAgentId inference |
| `mcp.ts` | TBD | Add `runs.assigned` tool for inbox queries |
| `schema.prisma` | TBD | Add `AgentDispatchInbox` table |
| Tests | TBD | Mirror agent-run-stale.test.ts style |

