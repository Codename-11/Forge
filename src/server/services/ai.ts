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

  const validLabelIds = new Set(input.workspaceLabels.map((l) => l.id));
  const validAgentIds = new Set(input.agents.map((a) => a.id));
  const suggestion = parseTriageMessage(
    completion.choices?.[0]?.message,
    validLabelIds,
    validAgentIds,
  );
  if (!suggestion) {
    logger.warn(
      {
        provider: ctx.providerId,
        finishReason: completion.choices?.[0]?.finish_reason,
      },
      "ai.triage: no usable suggestion",
    );
    return null;
  }
  return suggestion;
}

// ---------------------------------------------------------------------------
// Triage response parsing. The happy path is a forced `submit_triage` tool
// call. But some OpenAI-compatible gateways (notably the Hermes model-router)
// ignore `tool_choice` and answer in prose — so we degrade gracefully:
// tool_calls → function_call → fenced/inline JSON → labelled prose. A prose
// answer only counts if it names a recognizable priority; otherwise we treat
// it as a non-result so the caller can mark ERROR. Mirrors the resilience the
// PLANNER already has in `parseGeneratedPlanMessage`.
// ---------------------------------------------------------------------------

const PRIORITY_PATTERN = "NONE|LOW|MEDIUM|HIGH|URGENT";

export function parseTriageMessage(
  message: unknown,
  validLabelIds: Set<string>,
  validAgentIds: Set<string>,
): TriageSuggestion | null {
  for (const payload of triagePayloadCandidates(message)) {
    const fromPayload = suggestionFromPayload(
      payload,
      validLabelIds,
      validAgentIds,
    );
    if (fromPayload) return fromPayload;
  }
  const text = messageTextContent(message);
  if (text) return suggestionFromProse(text, validLabelIds, validAgentIds);
  return null;
}

function triagePayloadCandidates(message: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const msg = asRecord(message);
  if (!msg) return out;

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const toolCall of toolCalls) {
    const fn = asRecord(asRecord(toolCall)?.function);
    const name = typeof fn?.name === "string" ? fn.name : null;
    if (name && name !== "submit_triage") continue;
    const payload = jsonRecord(fn?.arguments);
    if (payload) out.push(payload);
  }

  const legacy = asRecord(msg.function_call);
  if (legacy) {
    const name = typeof legacy.name === "string" ? legacy.name : null;
    if (!name || name === "submit_triage") {
      const payload = jsonRecord(legacy.arguments);
      if (payload) out.push(payload);
    }
  }

  const text = messageTextContent(message);
  if (text) {
    for (const candidate of jsonCandidates(text)) {
      try {
        const record = asRecord(JSON.parse(candidate));
        if (record) out.push(record);
      } catch {
        // Try the next likely JSON span.
      }
    }
  }
  return out;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

function suggestionFromPayload(
  parsed: Record<string, unknown>,
  validLabelIds: Set<string>,
  validAgentIds: Set<string>,
): TriageSuggestion | null {
  const reasoning =
    typeof parsed.reasoning === "string" && parsed.reasoning.trim()
      ? parsed.reasoning.trim().slice(0, 1000)
      : null;
  // Guard against arbitrary JSON that isn't a triage payload (e.g. a stray
  // object embedded in prose): it must carry a priority or a reasoning.
  if (!("priority" in parsed) && reasoning === null) return null;

  const priority = isPriority(parsed.priority) ? parsed.priority : Priority.NONE;
  const rawLabels = Array.isArray(parsed.label_ids)
    ? parsed.label_ids
    : Array.isArray(parsed.labelIds)
      ? parsed.labelIds
      : [];
  const labelIds = rawLabels
    .filter((x): x is string => typeof x === "string")
    .filter((id) => validLabelIds.has(id));
  const agentRaw = parsed.agent_id ?? parsed.agentId;
  const agentId =
    typeof agentRaw === "string" && validAgentIds.has(agentRaw)
      ? agentRaw
      : null;

  return {
    priority,
    labelIds,
    agentId,
    reasoning: reasoning ?? "(no reasoning provided)",
  };
}

function suggestionFromProse(
  text: string,
  validLabelIds: Set<string>,
  validAgentIds: Set<string>,
): TriageSuggestion | null {
  const priority = prosePriority(text);
  if (!priority) return null; // no recognizable triage signal — let caller ERROR.

  // ids are unique cuids, so a substring scan is the most format-robust match
  // regardless of how the model formatted the prose.
  const labelIds = [...validLabelIds].filter((id) => text.includes(id));
  const agentId = [...validAgentIds].find((id) => text.includes(id)) ?? null;

  const reasonMatch = text.match(/reasoning[\s*_]*[:\-]\s*([\s\S]+)/i);
  const reasoning = (reasonMatch?.[1]?.trim() || text.trim()).slice(0, 1000);

  return { priority, labelIds, agentId, reasoning };
}

function prosePriority(text: string): Priority | null {
  const labelled = text.match(
    new RegExp(
      `priority[\\s*_]*[:\\-]?\\s*\\*{0,2}\\s*(${PRIORITY_PATTERN})`,
      "i",
    ),
  );
  const token =
    labelled?.[1] ??
    text.match(new RegExp(`\\b(${PRIORITY_PATTERN})\\b`, "i"))?.[1];
  if (!token) return null;
  const upper = token.toUpperCase();
  return isPriority(upper) ? upper : null;
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
  // Some gateways (the Hermes model-router) wrap the call in an agent loop
  // that answers with a meta-acknowledgement ("Posted the diagnostic
  // comment…") instead of an actual diagnostic. Drop those so we never post
  // a useless coach comment.
  if (!isUsefulCoachComment(text)) {
    logger.warn(
      { provider: ctx.providerId, text: text.slice(0, 120) },
      "ai.coach: dropped low-quality response",
    );
    return null;
  }
  return text.trim();
}

/**
 * Whether a Coach completion is a real diagnostic worth posting — rejects
 * meta-acknowledgements ("Posted the diagnostic comment…") and terse
 * non-answers that some gateways return instead of an actual diagnosis.
 */
export function isUsefulCoachComment(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 40) return false;
  if (t.split(/\s+/).length < 8) return false;
  const meta = [
    /^\s*posted\b/i,
    /posted (the )?(diagnostic )?comment/i,
    /^\s*i(?:'ve| have)?\s+(posted|added|left|written)\b/i,
    /^\s*(done|ok|okay|acknowledged|noted)\b[.!]?\s*$/i,
  ];
  return !meta.some((re) => re.test(t));
}

// ---------------------------------------------------------------------------
// Description assist — draft a description from the title, or enhance an
// existing one. Free-text Markdown out (no tool call), so parsing is just
// "take the content, strip a wrapping code fence". Never throws; returns null
// on any failure so the router surfaces an actionable message.
// ---------------------------------------------------------------------------

export interface DescriptionInput {
  title: string;
  description?: string | null;
  provider?: string | null;
  model?: string | null;
}

const DESCRIBE_SYSTEM =
  "You write crisp issue descriptions for a project-management tool. Output GitHub-flavored Markdown only — a 1–2 sentence summary, then, only if it genuinely helps, a short `## Acceptance criteria` or `## Steps` list. No preamble, no sign-off, and do NOT wrap your whole answer in a code fence.";

/**
 * Strip a code fence that wraps the *entire* model output (some models wrap
 * their whole markdown answer in ```markdown … ```). Only when there are
 * exactly two fences, so a description with a genuine embedded code block is
 * left intact. Returns null for empty/nullish.
 */
export function cleanDescriptionOutput(
  content: string | null | undefined,
): string | null {
  if (!content) return null;
  let text = content.trim();
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount === 2) {
    const m = text.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
    if (m) text = m[1].trim();
  }
  return text.length ? text : null;
}

export async function runDescriptionDraft(
  input: DescriptionInput,
): Promise<string | null> {
  const ctx = getClient(input.provider);
  if (!ctx) return null;
  try {
    const completion = await ctx.client.chat.completions.create({
      model: input.model || ctx.defaultModel,
      max_tokens: 700,
      messages: [
        { role: "system", content: DESCRIBE_SYSTEM },
        {
          role: "user",
          content: `Write an issue description from this title:\n\n${input.title}`,
        },
      ],
    });
    return cleanDescriptionOutput(completion.choices?.[0]?.message?.content);
  } catch (err) {
    logger.warn({ err, provider: ctx.providerId }, "ai.describe: draft failed");
    return null;
  }
}

export async function runDescriptionEnhance(
  input: DescriptionInput,
): Promise<string | null> {
  const ctx = getClient(input.provider);
  if (!ctx) return null;
  const existing = input.description?.trim();
  // Nothing to enhance → fall back to a fresh draft.
  if (!existing) return runDescriptionDraft(input);
  try {
    const completion = await ctx.client.chat.completions.create({
      model: input.model || ctx.defaultModel,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content:
            DESCRIBE_SYSTEM +
            " You are improving an EXISTING description: keep the author's intent and every concrete fact, improve clarity / structure / grammar, and do NOT invent requirements or drop information.",
        },
        {
          role: "user",
          content: `Issue title: ${input.title}\n\nCurrent description:\n${existing}\n\nReturn an improved version of the description.`,
        },
      ],
    });
    return cleanDescriptionOutput(completion.choices?.[0]?.message?.content);
  } catch (err) {
    logger.warn({ err, provider: ctx.providerId }, "ai.describe: enhance failed");
    return null;
  }
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

  const parsed = parseGeneratedPlanMessage(completion.choices?.[0]?.message);
  if (!parsed) {
    logger.warn(
      {
        provider: client.providerId,
        finishReason: completion.choices?.[0]?.finish_reason,
        completion,
      },
      "ai.plan: no usable steps",
    );
    return null;
  }
  logger.info(
    { provider: client.providerId, source: parsed.source, stepCount: parsed.steps.length },
    "ai.plan: parsed plan",
  );
  return parsed.steps;
}

export function parseGeneratedPlanMessage(
  message: unknown,
): { steps: GeneratedStep[]; source: string } | null {
  const candidates = extractPlanPayloadCandidates(message);
  for (const candidate of candidates) {
    const steps = generatedStepsFromPayload(candidate.payload);
    if (steps.length > 0) {
      return { steps, source: candidate.source };
    }
  }

  const text = messageTextContent(message);
  if (text) {
    const steps = generatedStepsFromMarkdown(text);
    if (steps.length > 0) {
      return { steps, source: "content_markdown" };
    }
  }

  return null;
}

function extractPlanPayloadCandidates(
  message: unknown,
): Array<{ payload: unknown; source: string }> {
  const candidates: Array<{ payload: unknown; source: string }> = [];
  const msg = asRecord(message);
  if (!msg) return candidates;

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const toolCall of toolCalls) {
    const call = asRecord(toolCall);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === "string" ? fn.name : null;
    if (name && name !== "submit_plan") continue;
    const payload = parsePlanArguments(fn?.arguments);
    if (payload !== null) {
      candidates.push({ payload, source: "tool_calls" });
    }
  }

  const legacyFn = asRecord(msg.function_call);
  if (legacyFn) {
    const name = typeof legacyFn.name === "string" ? legacyFn.name : null;
    if (!name || name === "submit_plan") {
      const payload = parsePlanArguments(legacyFn.arguments);
      if (payload !== null) {
        candidates.push({ payload, source: "function_call" });
      }
    }
  }

  const text = messageTextContent(message);
  if (text) {
    const payload = parseJsonishPlanPayload(text);
    if (payload !== null) {
      candidates.push({ payload, source: "content_json" });
    }
  }

  return candidates;
}

function parsePlanArguments(value: unknown): unknown | null {
  if (typeof value === "string") {
    return parseJsonishPlanPayload(value);
  }
  if (value && typeof value === "object") {
    return value;
  }
  return null;
}

function parseJsonishPlanPayload(text: string): unknown | null {
  const candidates = jsonCandidates(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next likely JSON span.
    }
  }
  return null;
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = [trimmed];
  const fencePattern = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fencePattern)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1).trim());
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1).trim());
  }

  return Array.from(new Set(candidates));
}

function generatedStepsFromPayload(payload: unknown): GeneratedStep[] {
  const rawSteps = rawStepsFromPayload(payload);
  const steps: GeneratedStep[] = [];
  for (let index = 0; index < rawSteps.length; index++) {
    const raw = rawSteps[index];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = firstString(r.title, r.name, r.step_title)?.trim() ?? "";
    if (!title) continue;

    const verification = coerceStringArray(
      r.verification ?? r.verification_checklist ?? r.checklist,
    );
    const dependsOnStepIndexes = coerceIntegerArray(
      r.depends_on_step_indexes ?? r.dependsOnStepIndexes ?? r.depends_on ?? r.dependencies,
    ).filter((n) => n >= 0 && n < index);
    const role = coerceRole(r.assigned_role ?? r.assignedRole);
    const body = firstString(r.body, r.description, r.details);
    const expectedOutput = firstString(
      r.expected_output,
      r.expectedOutput,
      r.output,
      r.deliverable,
    );

    steps.push({
      title: title.slice(0, 300),
      body: body?.trim() ? body.trim() : null,
      expectedOutput: expectedOutput?.trim() ? expectedOutput.trim() : null,
      verification,
      dependsOnStepIndexes,
      assignedRole: role,
    });
  }
  return steps;
}

function rawStepsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  const steps = record.steps ?? record.plan ?? record.execution_steps;
  return Array.isArray(steps) ? steps : [];
}

function generatedStepsFromMarkdown(text: string): GeneratedStep[] {
  const items = collectMarkdownStepItems(text, false);
  const fallbackItems = items.length > 0 ? items : collectMarkdownStepItems(text, true);
  const steps: GeneratedStep[] = [];
  for (const item of fallbackItems) {
    const title = cleanMarkdownInline(item.title);
    if (!title) continue;
    const details = markdownDetails(item.bodyLines);
    steps.push({
      title: title.slice(0, 300),
      body: details.body,
      expectedOutput: details.expectedOutput,
      verification: details.verification,
      dependsOnStepIndexes: [],
      assignedRole: null,
    });
  }
  return steps;
}

function collectMarkdownStepItems(
  text: string,
  allowPlainBullets: boolean,
): Array<{ title: string; bodyLines: string[] }> {
  const items: Array<{ title: string; bodyLines: string[] }> = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const line of text.split(/\r?\n/)) {
    const item = markdownStepTitle(line, allowPlainBullets);
    if (item) {
      current = { title: item, bodyLines: [] };
      items.push(current);
      continue;
    }
    if (current && line.trim()) {
      current.bodyLines.push(line);
    }
  }

  return items;
}

function markdownStepTitle(line: string, allowPlainBullets: boolean): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const heading = trimmed.match(/^#{1,6}\s+(?:step\s*)?\d{1,2}[.)\s:-]+(.+)$/i);
  if (heading?.[1]) return heading[1].trim();

  const listed = trimmed.match(/^(?:step\s*)?\d{1,2}[.)]\s+(.+)$/i);
  if (listed?.[1]) return listed[1].trim();

  const bullet = trimmed.match(/^[-*+]\s+(?:step\s*)?\d{1,2}[.)\s:-]+(.+)$/i);
  if (bullet?.[1]) return bullet[1].trim();

  if (allowPlainBullets && line === trimmed) {
    const plainBullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (plainBullet?.[1]) return plainBullet[1].trim();
  }

  return null;
}

function markdownDetails(lines: string[]): {
  body: string | null;
  expectedOutput: string | null;
  verification: string[];
} {
  const bodyLines: string[] = [];
  const verification: string[] = [];
  let expectedOutput: string | null = null;

  for (const line of lines) {
    const clean = cleanMarkdownInline(line.replace(/^\s*[-*+]\s+/, ""));
    if (!clean) continue;

    const expected = clean.match(/^(?:expected output|expected_output|deliverable|output):\s*(.+)$/i);
    if (expected?.[1]) {
      expectedOutput = expected[1].trim();
      continue;
    }

    const verify = clean.match(/^(?:verification|verify|done when|acceptance):\s*(.+)$/i);
    if (verify?.[1]) {
      verification.push(verify[1].trim());
      continue;
    }

    bodyLines.push(clean);
  }

  return {
    body: bodyLines.length ? bodyLines.join("\n") : null,
    expectedOutput,
    verification,
  };
}

function cleanMarkdownInline(value: string): string {
  return value
    .replace(/^\s*(?:step\s*)?\d{1,2}[.)\s:-]+/i, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .trim();
}

function messageTextContent(message: unknown): string | null {
  if (typeof message === "string") return message.trim() || null;
  const msg = asRecord(message);
  if (!msg) return null;
  return contentToText(msg.content);
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      if (!record) return "";
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function coerceStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n|;/)
      .map((v) => cleanMarkdownInline(v.replace(/^\s*[-*+]\s+/, "")))
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function coerceIntegerArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n),
  );
}

function coerceRole(value: unknown): "WORKER" | "REVIEWER" | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return upper === "WORKER" || upper === "REVIEWER" ? upper : null;
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
