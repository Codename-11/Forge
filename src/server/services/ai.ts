import "server-only";
import { Priority } from "@prisma/client";
import type OpenAI from "openai";
import { logger } from "@/server/logger";
import {
  getClient,
  isProviderAvailable,
  listProviders,
  type ResolvedProviderClient,
} from "@/server/services/ai-providers";

/**
 * AI service — provider-agnostic wrapper around OpenAI's
 * chat-completions shape. Routes through the configured provider
 * (Hermes by default) using the OpenAI SDK with a swappable baseURL.
 *
 * - Forge-internal only. Never reaches into Lucid, Obsidian, etc.
 * - Returns null on any failure (no provider, rate limit, parse error).
 *   Callers treat null as "no suggestion" — never throws.
 * - Uses tool_use for structured triage output.
 *
 * Provider selection lives in `Workspace.aiProvider`. URLs / keys are
 * env-driven (see ai-providers.ts).
 */

export { listProviders };

export interface TriageInput {
  title: string;
  description: string | null | undefined;
  workspaceLabels: Array<{ id: string; name: string; color: string }>;
  agents: Array<{
    id: string;
    profileKey: string;
    name: string;
    capabilities: string[];
  }>;
  recentTitles?: string[];
  provider?: string | null;
  model?: string | null;
}

export interface TriageSuggestion {
  priority: Priority;
  labelIds: string[];
  agentId: string | null;
  reasoning: string;
}

export interface CoachInput {
  eventKind: "ISSUE_STALLED" | "AGENT_NOACK" | "ISSUE_SLA_BREACH";
  issue: {
    id: string;
    number: number;
    title: string;
    description: string | null;
    priority: Priority;
    statusName: string;
    labels: string[];
    createdAt: Date;
    updatedAt: Date;
  };
  agent: { profileKey: string; name: string } | null;
  recentCommentBodies: string[];
  provider?: string | null;
  model?: string | null;
}

/** Whether the named provider has its env wired up. */
export function aiAvailable(provider?: string | null): boolean {
  return isProviderAvailable(provider ?? "hermes");
}

export async function runTriage(
  input: TriageInput,
): Promise<TriageSuggestion | null> {
  const ctx = getClient(input.provider);
  if (!ctx) return null;

  const labelMenu = input.workspaceLabels
    .map((l) => `- ${l.name} (id: ${l.id})`)
    .join("\n");
  const agentMenu = input.agents.length
    ? input.agents
        .map(
          (a) =>
            `- ${a.profileKey} (${a.name}) — id: ${a.id}, capabilities: ${a.capabilities.join(", ") || "none"}`,
        )
        .join("\n")
    : "(none registered)";

  const recentBlock = input.recentTitles?.length
    ? `\n\nRecently created issues in this workspace (for tone/scope reference):\n${input.recentTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const userMessage = `New issue title: ${input.title}

Description:
${input.description?.trim() || "(none)"}

Available labels:
${labelMenu || "(none configured)"}

Available agents:
${agentMenu}${recentBlock}

Suggest a priority, applicable labels (only from the list above — match by id, not name), and an agent assignment if one of the available agents is a clear fit. Skip agent assignment if no agent is a strong match. Include a 1-2 sentence reasoning the operator can read at a glance.`;

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "submit_triage",
        description: "Submit a triage suggestion for a newly created issue.",
        parameters: {
          type: "object",
          properties: {
            priority: {
              type: "string",
              enum: ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"],
            },
            label_ids: {
              type: "array",
              items: { type: "string" },
              description:
                "IDs from the workspace labels list. Empty array if no labels apply.",
            },
            agent_id: {
              type: ["string", "null"],
              description:
                "Agent id from the available agents list, or null if no clear fit.",
            },
            reasoning: {
              type: "string",
              description: "1-2 sentences explaining the suggestion.",
            },
          },
          required: ["priority", "label_ids", "agent_id", "reasoning"],
        },
      },
    },
  ];

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await ctx.client.chat.completions.create({
      model: input.model || ctx.defaultModel,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content:
            "You are a triage assistant for a project management tool. Make a single tool call to submit_triage. Be conservative — prefer NONE/LOW priority unless the issue clearly indicates urgency, and don't assign an agent unless one is a strong capability match. Do not invent label ids or agent ids; only use values from the provided lists.",
        },
        { role: "user", content: userMessage },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "submit_triage" } },
    });
  } catch (err) {
    logger.warn(
      { err, provider: ctx.providerId },
      "ai.triage: chat call failed",
    );
    return null;
  }

  const call =
    completion.choices?.[0]?.message?.tool_calls?.[0] as
      | { type: string; function?: { name?: string; arguments?: string } }
      | undefined;
  if (!call?.function?.arguments) {
    logger.warn({ completion }, "ai.triage: tool call missing");
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    logger.warn({ err, args: call.function.arguments }, "ai.triage: bad JSON");
    return null;
  }

  const priority = isPriority(parsed.priority) ? parsed.priority : Priority.NONE;
  const labelIds = Array.isArray(parsed.label_ids)
    ? parsed.label_ids.filter((x): x is string => typeof x === "string")
    : [];
  const validLabelIds = new Set(input.workspaceLabels.map((l) => l.id));
  const filteredLabelIds = labelIds.filter((id) => validLabelIds.has(id));
  const validAgentIds = new Set(input.agents.map((a) => a.id));
  const agentId =
    typeof parsed.agent_id === "string" && validAgentIds.has(parsed.agent_id)
      ? parsed.agent_id
      : null;
  const reasoning =
    typeof parsed.reasoning === "string"
      ? parsed.reasoning.slice(0, 1000)
      : "(no reasoning provided)";

  return { priority, labelIds: filteredLabelIds, agentId, reasoning };
}

export async function runCoachComment(
  input: CoachInput,
): Promise<string | null> {
  const ctx = getClient(input.provider);
  if (!ctx) return null;

  const eventDescription = {
    ISSUE_STALLED:
      "An assigned agent has not moved this issue out of BACKLOG/TODO within the workspace SLA. The issue is stalled.",
    AGENT_NOACK:
      "The assigned agent did not comment on or transition this issue within the required acknowledgement window after assignment.",
    ISSUE_SLA_BREACH:
      "This issue has passed its per-issue SLA target with no resolution.",
  }[input.eventKind];

  const ageMinutes = Math.round(
    (Date.now() - input.issue.createdAt.getTime()) / 60_000,
  );
  const sinceUpdateMinutes = Math.round(
    (Date.now() - input.issue.updatedAt.getTime()) / 60_000,
  );

  const commentsBlock = input.recentCommentBodies.length
    ? `\n\nRecent comments (oldest first):\n${input.recentCommentBodies
        .map((b, i) => `[${i + 1}] ${b.slice(0, 500)}`)
        .join("\n\n")}`
    : "";

  const userMessage = `Issue ${input.issue.number}: ${input.issue.title}
Status: ${input.issue.statusName}
Priority: ${input.issue.priority}
Labels: ${input.issue.labels.join(", ") || "(none)"}
Assigned agent: ${input.agent ? `${input.agent.profileKey} (${input.agent.name})` : "(none)"}
Age: ${ageMinutes}m, last updated ${sinceUpdateMinutes}m ago

Description:
${input.issue.description?.trim() || "(none)"}${commentsBlock}

Event: ${input.eventKind}
${eventDescription}

Write a short comment (3-6 sentences) for the operator. Do NOT speculate beyond what the data supports. Focus on:
1. What likely went wrong (one sentence based on the data above).
2. One concrete next step the operator can take.
3. If applicable, what to change in workspace settings to prevent recurrence.
Use plain prose, no bullets, no headers. Do not address the agent directly.`;

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await ctx.client.chat.completions.create({
      model: input.model || ctx.defaultModel,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content:
            "You are Coach, a Forge agent that posts diagnostic comments when work stalls. You are calm, terse, and actionable. You do not pretend to know things you don't. Comments must be 3-6 sentences max.",
        },
        { role: "user", content: userMessage },
      ],
    });
  } catch (err) {
    logger.warn(
      { err, provider: ctx.providerId },
      "ai.coach: chat call failed",
    );
    return null;
  }

  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    logger.warn({ completion }, "ai.coach: empty response");
    return null;
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Plan generation — Forge's built-in PLANNER. Single-shot, forced tool-call
// that decomposes a goal into ordered ExecutionSteps so "Generate with Forge"
// works without dispatching to an external agent runtime. The output is mapped
// to `AddStepInput[]` by the caller (orchestration-service.generatePlanForGoal).
//
// Unlike runTriage/runCoachComment (env-only via getClient), the caller passes
// an already-resolved client from `resolveWorkspaceProviderClient` so a
// DB-credential-only workspace works too. Returns null on any failure — the
// caller surfaces a typed error and never persists a dead empty plan.
// ---------------------------------------------------------------------------

export interface PlanGenInput {
  goalTitle: string;
  goalDescription: string | null;
  /** Crew roles present (e.g. ["WORKER","REVIEWER"]) — hints assigned_role. */
  crewRoles?: string[];
  model?: string | null;
}

export interface GeneratedStep {
  title: string;
  body: string | null;
  expectedOutput: string | null;
  verification: string[];
  dependsOnStepIndexes: number[];
  assignedRole: "WORKER" | "REVIEWER" | null;
}

export async function runPlanGeneration(
  client: ResolvedProviderClient,
  input: PlanGenInput,
): Promise<GeneratedStep[] | null> {
  const rolesBlock = input.crewRoles?.length
    ? `\n\nThe assigned crew has these roles available: ${input.crewRoles.join(
        ", ",
      )}. Suggest assigned_role from {WORKER, REVIEWER} per step, or null.`
    : "";

  const userMessage = `Goal: ${input.goalTitle}

Description:
${input.goalDescription?.trim() || "(none)"}${rolesBlock}

Decompose this goal into a short, ordered list of concrete execution steps (typically 3-7). Each step needs a clear title, a body describing the work, an expected_output (the completion contract), a verification checklist (how we know it's done), and depends_on_step_indexes referencing earlier steps by their 0-based position in your list. Keep steps independent where possible; only add a dependency when one step genuinely requires another's output first.`;

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "submit_plan",
        description:
          "Submit the decomposed execution plan as an ordered list of steps.",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "Ordered execution steps. At least one.",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  body: {
                    type: ["string", "null"],
                    description: "What the step entails. Markdown allowed.",
                  },
                  expected_output: {
                    type: ["string", "null"],
                    description: "The concrete deliverable that marks completion.",
                  },
                  verification: {
                    type: "array",
                    items: { type: "string" },
                    description: "Checklist items proving the step is done.",
                  },
                  depends_on_step_indexes: {
                    type: "array",
                    items: { type: "integer" },
                    description:
                      "0-based indexes of prerequisite steps in this same list.",
                  },
                  assigned_role: {
                    type: ["string", "null"],
                    enum: ["WORKER", "REVIEWER", null],
                  },
                },
                required: [
                  "title",
                  "body",
                  "expected_output",
                  "verification",
                  "depends_on_step_indexes",
                  "assigned_role",
                ],
              },
            },
          },
          required: ["steps"],
        },
      },
    },
  ];

  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    completion = await client.client.chat.completions.create({
      model: input.model || client.defaultModel,
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content:
            "You are the PLANNER for a project management tool. Decompose a goal into ordered, verifiable execution steps and make a single tool call to submit_plan. Be concrete and conservative: prefer fewer, well-scoped steps over many vague ones. Do not invent dependencies. Every step must have a non-empty title.",
        },
        { role: "user", content: userMessage },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "submit_plan" } },
    });
  } catch (err) {
    logger.warn(
      { err, provider: client.providerId },
      "ai.plan: chat call failed",
    );
    return null;
  }

  const call = completion.choices?.[0]?.message?.tool_calls?.[0] as
    | { type: string; function?: { name?: string; arguments?: string } }
    | undefined;
  if (!call?.function?.arguments) {
    logger.warn({ completion }, "ai.plan: tool call missing");
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    logger.warn({ err, args: call.function.arguments }, "ai.plan: bad JSON");
    return null;
  }

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps: GeneratedStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title) continue; // a step with no title is unusable
    const verification = Array.isArray(r.verification)
      ? r.verification
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
      : [];
    const dependsOnStepIndexes = Array.isArray(r.depends_on_step_indexes)
      ? r.depends_on_step_indexes.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n),
        )
      : [];
    const role =
      r.assigned_role === "WORKER" || r.assigned_role === "REVIEWER"
        ? r.assigned_role
        : null;
    steps.push({
      title: title.slice(0, 300),
      body: typeof r.body === "string" && r.body.trim() ? r.body : null,
      expectedOutput:
        typeof r.expected_output === "string" && r.expected_output.trim()
          ? r.expected_output
          : null,
      verification,
      dependsOnStepIndexes,
      assignedRole: role,
    });
  }

  if (steps.length === 0) {
    logger.warn({ completion }, "ai.plan: no usable steps");
    return null;
  }
  return steps;
}

function isPriority(value: unknown): value is Priority {
  return (
    typeof value === "string" &&
    (
      [
        Priority.NONE,
        Priority.LOW,
        Priority.MEDIUM,
        Priority.HIGH,
        Priority.URGENT,
      ] as string[]
    ).includes(value)
  );
}
