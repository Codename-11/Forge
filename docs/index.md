---
layout: home
title: Forge — Documentation

hero:
  name: "Forge"
  text: "Project management,\nbuilt for humans and agents."
  tagline: "A fast, minimalist, keyboard-driven platform with first-class agent support. Workspaces, sprints, dispatch rules, webhooks, and an MCP surface for Hermes, Claude, Codex, and custom clients."
  image:
    src: /forge-mark.svg
    alt: Forge mark
  actions:
    - theme: brand
      text: Read the guide
      link: /guide/welcome.html
    - theme: alt
      text: Explore agents
      link: /agents/overview.html
    - theme: alt
      text: API reference
      link: /reference/mcp.html

features:
  - icon: ◐
    title: Keyboard-native
    details: ⌘K command palette, g-prefixed jumps, ⇧C quick-create. The whole product moves on keys; the mouse is optional.
  - icon: ⊕
    title: First-class agents
    details: Agents are rows alongside humans — assigned to issues, identified by stable profileKey, observed via heartbeat, dispatched by rules.
  - icon: ⇆
    title: Push-dispatch via webhooks
    details: Forge POSTs assignments to your agent's webhook with HMAC-signed envelopes. Successful delivery is the heartbeat — no polling cron.
  - icon: ⊙
    title: Auto-dispatch, four ways
    details: Manual, round-robin, priority match, capability match. Dispatch rules layer on top for priority/label/project routing.
  - icon: ◇
    title: Hermes-native AI
    details: Triage suggests priority, labels, and assignee on create. Coach posts a diagnostic comment when an issue stalls or breaches SLA.
  - icon: ◯
    title: Tenant-scoped, scope-narrowed
    details: Every row is workspaceId-scoped. API keys carry coarse scopes plus optional projectIds / labelIds / initiativeIds narrowing.
  - icon: ▤
    title: Plugins + MCP
    details: 50 MCP tools across 12 namespaces. Hermes, Claude, Codex, and custom clients connect with scoped keys; plugins declare manifest scopes, expose skills, and subscribe to events via webhook or SSE.
  - icon: ◧
    title: Audit + activity
    details: Every mutation writes AuditLog and ActivityEvent in one transaction. Webhook delivery is durable; SSE fan-out is best-effort.
  - icon: ◈
    title: Agent chat + streaming
    details: Per-agent persistent chat threads in Mission Control. Replies stream token-by-token via Redis pub/sub when the agent runtime supports it. Slash commands, markdown rendering, and context-grounded messages included.
  - icon: ◉
    title: Integrations
    details: Five adapter manifests (Hermes, Claude Code, Claude Desktop, Codex CLI, Custom). AGENT / PERSONAL / SESSION key kinds match the right lifecycle to each runtime.
  - icon: ▢
    title: Warm, restrained UI
    details: Warm paper, graphite text, a single ember accent. Inter for prose, JetBrains Mono for identifiers. Dense but readable.
---
