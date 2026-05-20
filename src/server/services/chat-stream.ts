import "server-only";
import type OpenAI from "openai";
import { AgentProvider } from "@prisma/client";
import { getClient } from "@/server/services/ai-providers";
import { logger } from "@/server/logger";

/**
 * Interactive-chat streaming adapter.
 *
 * Distinct from `ai-providers.ts` (single-shot tool-call completions used by
 * triage/coach) and from the dispatch-webhook path (CHAT_MESSAGE_POSTED →
 * WebhookDelivery → Hermes → MCP draft chunks). This module is the direct
 * fetch path that backs `/api/chat/stream` — the operator types, the request
 * opens an OpenAI-compatible streaming call, and tokens flow straight back
 * over SSE without a queue hop.
 *
 * v1 deliberately renders tool-use blocks as *intents* (no auto-execution).
 * The model can express "I would call X(args)", we surface it as a card, and
 * a follow-on v2 will offer a confirm-and-run button.
 */

export type ChatStreamRole = "system" | "user" | "assistant" | "tool";

export interface ChatStreamMessage {
  role: ChatStreamRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Present on tool result messages. */
  tool_call_id?: string;
}

export type ChatStreamEvent =
  | { kind: "content"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool_use"; id: string; name: string; args: Record<string, unknown> }
  | {
      kind: "tool_result";
      id: string;
      ok: boolean;
      summary: string;
      result?: unknown;
    }
  | { kind: "done"; hasToolCalls: boolean }
  | { kind: "error"; message: string };

/** Maps Agent.provider → the ai-providers.ts ProviderId. */
function providerIdFor(provider: AgentProvider): string {
  switch (provider) {
    case AgentProvider.HERMES:
      return "hermes";
    case AgentProvider.CLAUDE:
      // Bailey's setup: prefer Anthropic direct when ANTHROPIC_API_KEY is set,
      // otherwise let the resolver fall back through Hermes.
      return process.env.ANTHROPIC_API_KEY ? "anthropic" : "hermes";
    case AgentProvider.CODEX:
      return process.env.OPENAI_API_KEY ? "openai" : "hermes";
    case AgentProvider.CUSTOM:
      return process.env.FORGE_AI_BASE_URL ? "custom" : "hermes";
    default:
      return "hermes";
  }
}

interface StreamArgs {
  provider: AgentProvider;
  messages: ChatStreamMessage[];
  signal?: AbortSignal;
  /** Optional model override; otherwise the provider default is used. */
  model?: string;
  /** Optional tool catalog. Empty/omitted disables function-calling. */
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
}

/**
 * Async generator over `ChatStreamEvent`s. Caller iterates with `for await`.
 * Always yields a terminal `done` or `error` so consumers can close their
 * SSE writer deterministically.
 */
export async function* streamChatReply(
  args: StreamArgs,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const providerId = providerIdFor(args.provider);
  const ctx = getClient(providerId);
  if (!ctx) {
    yield {
      kind: "error",
      message: `Provider ${providerId} is not configured. Set the matching API key in env.`,
    };
    yield { kind: "done", hasToolCalls: false };
    return;
  }

  const isAnthropicCompat = providerId === "anthropic";
  const requestBody: Record<string, unknown> = {
    model: args.model || ctx.defaultModel,
    messages: args.messages,
    stream: true,
    temperature: 0.4,
    max_tokens: 2048,
  };

  if (args.tools && args.tools.length > 0) {
    requestBody.tools = args.tools;
    requestBody.tool_choice = "auto";
  }

  // Anthropic supports an extended-thinking signal via its OpenAI-compat
  // layer. The OpenAI SDK accepts unknown keys, so we pass it through
  // `extra_body`-style merging by spreading directly. If the upstream
  // rejects it, fall through and content streaming still works.
  if (isAnthropicCompat) {
    requestBody.thinking = { type: "enabled", budget_tokens: 4_000 };
  }

  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
  try {
    stream = (await ctx.client.chat.completions.create(
      requestBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: args.signal },
    )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
  } catch (err) {
    logger.warn(
      { err, provider: providerId },
      "chat-stream: upstream create() failed",
    );
    yield {
      kind: "error",
      message: err instanceof Error ? err.message : "Upstream stream failed.",
    };
    yield { kind: "done", hasToolCalls: false };
    return;
  }

  // Accumulate tool-call args across deltas — OpenAI streams them as
  // incremental JSON-string fragments indexed by `tool_call.index`.
  const toolBuffers = new Map<
    number,
    { id: string; name: string; argsText: string; emitted: boolean }
  >();
  let emittedAny = false;

  try {
    for await (const chunk of stream) {
      if (args.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            // Anthropic OpenAI-compat surfaces extended thinking deltas
            // under a non-standard `reasoning_content` field. Treat it
            // defensively — Hermes/OpenAI won't set it.
            reasoning_content?: string;
          })
        | undefined;
      if (!delta) continue;

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        emittedAny = true;
        yield { kind: "thinking", delta: delta.reasoning_content };
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        emittedAny = true;
        yield { kind: "content", delta: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolBuffers.get(idx) ?? {
            id: tc.id ?? `tool_${idx}`,
            name: "",
            argsText: "",
            emitted: false,
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsText += tc.function.arguments;
          toolBuffers.set(idx, existing);
        }
      }

      // When the model signals it's done with a tool_calls turn, flush the
      // accumulated tool buffers as `tool_use` events. We do NOT execute —
      // the UI renders intent cards (display-only in v1).
      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === "tool_calls") {
        for (const buf of toolBuffers.values()) {
          if (buf.emitted) continue;
          buf.emitted = true;
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = buf.argsText ? (JSON.parse(buf.argsText) as Record<string, unknown>) : {};
          } catch {
            parsedArgs = { _raw: buf.argsText };
          }
          emittedAny = true;
          yield { kind: "tool_use", id: buf.id, name: buf.name || "(unnamed)", args: parsedArgs };
        }
      }
    }

    // Defensive flush — some providers don't emit a `tool_calls` finish
    // reason on the final chunk but still leave buffers populated.
    for (const buf of toolBuffers.values()) {
      if (buf.emitted) continue;
      buf.emitted = true;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = buf.argsText ? (JSON.parse(buf.argsText) as Record<string, unknown>) : {};
      } catch {
        parsedArgs = { _raw: buf.argsText };
      }
      emittedAny = true;
      yield { kind: "tool_use", id: buf.id, name: buf.name || "(unnamed)", args: parsedArgs };
    }

    if (!emittedAny) {
      yield { kind: "error", message: "Upstream returned an empty stream." };
    }
    yield { kind: "done", hasToolCalls: toolBuffers.size > 0 };
  } catch (err) {
    logger.warn(
      { err, provider: providerId },
      "chat-stream: error mid-stream",
    );
    yield {
      kind: "error",
      message: err instanceof Error ? err.message : "Stream interrupted.",
    };
    yield { kind: "done", hasToolCalls: false };
  }
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Original stringified arguments — needed when echoing into the next-turn message history. */
  argsText: string;
}

export interface ChatToolExecResult {
  ok: boolean;
  summary: string;
  result?: unknown;
}

export interface RunChatLoopArgs {
  provider: AgentProvider;
  messages: ChatStreamMessage[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  model?: string;
  signal?: AbortSignal;
  /** Maximum number of model turns. Defaults to 5. */
  maxTurns?: number;
  onContent?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUseStart?: (call: ChatToolCall) => void;
  onToolResult?: (id: string, result: ChatToolExecResult) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
  /** Executor invoked once per surfaced tool call. */
  executeToolCall: (call: ChatToolCall) => Promise<ChatToolExecResult>;
}

/**
 * Multi-turn chat loop with tool execution. Drives `streamChatReply`,
 * accumulates assistant content + tool calls, hands tool calls off to the
 * caller's executor, appends both the assistant turn and the tool results
 * to the running message array, and re-enters the loop until either no
 * tool calls are made or `maxTurns` is hit.
 */
export async function runChatLoop(args: RunChatLoopArgs): Promise<void> {
  const maxTurns = args.maxTurns ?? 5;
  const messages = [...args.messages];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (args.signal?.aborted) {
      args.onError?.("Stream aborted.");
      break;
    }

    const assistantContent: string[] = [];
    // Preserve provider stream order so tool_calls land in the same slots
    // when we echo them back as the assistant turn.
    const toolCalls = new Map<string, ChatToolCall>();
    let streamErrored = false;
    let hasToolCalls = false;

    for await (const evt of streamChatReply({
      provider: args.provider,
      messages,
      signal: args.signal,
      model: args.model,
      tools: args.tools,
    })) {
      if (args.signal?.aborted) break;
      switch (evt.kind) {
        case "content":
          assistantContent.push(evt.delta);
          args.onContent?.(evt.delta);
          break;
        case "thinking":
          args.onThinking?.(evt.delta);
          break;
        case "tool_use": {
          const call: ChatToolCall = {
            id: evt.id,
            name: evt.name,
            args: evt.args,
            argsText: JSON.stringify(evt.args ?? {}),
          };
          toolCalls.set(evt.id, call);
          args.onToolUseStart?.(call);
          break;
        }
        case "error":
          streamErrored = true;
          args.onError?.(evt.message);
          break;
        case "done":
          hasToolCalls = evt.hasToolCalls;
          break;
      }
    }

    if (streamErrored) break;
    if (!hasToolCalls && toolCalls.size === 0) {
      args.onDone?.();
      return;
    }

    // Append the assistant turn (with tool_calls) so the next streamed
    // call sees the same shape OpenAI expects, then run each tool and
    // append tool result messages.
    const assistantMsg: ChatStreamMessage = {
      role: "assistant",
      content: assistantContent.join(""),
      tool_calls: Array.from(toolCalls.values()).map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.argsText },
      })),
    };
    messages.push(assistantMsg);

    for (const call of toolCalls.values()) {
      let result: ChatToolExecResult;
      try {
        result = await args.executeToolCall(call);
      } catch (err) {
        result = {
          ok: false,
          summary:
            err instanceof Error
              ? err.message
              : `Tool ${call.name} executor threw.`,
        };
      }
      args.onToolResult?.(call.id, result);
      const toolBody = result.ok
        ? JSON.stringify(result.result ?? { ok: true, summary: result.summary })
        : JSON.stringify({ ok: false, error: result.summary });
      messages.push({
        role: "tool",
        content: toolBody.slice(0, 16_000),
        tool_call_id: call.id,
      });
    }

    if (args.signal?.aborted) {
      args.onError?.("Stream aborted.");
      break;
    }
  }

  args.onDone?.();
}
