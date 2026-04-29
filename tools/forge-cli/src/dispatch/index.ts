import { callTool } from "../mcp.js";
import type { AuthFile } from "../auth.js";
import { runClaudeChat } from "./claude-code.js";
import type {
  ChatMessageHistoryRow,
  DispatchAgent,
  InlineAttachment,
  IssueBundle,
} from "./types.js";

export type { ChatDispatchContext, IssueDispatchContext } from "./types.js";

/**
 * Provider switch — given an agent's `provider` enum value, fan out to
 * the matching adapter. Only CLAUDE is functional in v1; the rest stub
 * by finalizing a friendly placeholder so the chat thread doesn't sit
 * with an empty draft bubble forever.
 */

export type AgentProviderId = "CLAUDE" | "CODEX" | "HERMES" | "CUSTOM";

export interface DispatchChatArgs {
  auth: AuthFile;
  threadId: string;
  agent: DispatchAgent & { provider: AgentProviderId | string };
  userMessage: string;
  workspaceSlug?: string;
  threadHistory?: ChatMessageHistoryRow[];
  issueContext?: IssueBundle | null;
  attachments?: InlineAttachment[];
}

export async function dispatchChat(args: DispatchChatArgs): Promise<void> {
  const provider = args.agent.provider as AgentProviderId;
  switch (provider) {
    case "CLAUDE":
      return runClaudeChat({
        auth: args.auth,
        threadId: args.threadId,
        agent: args.agent,
        userMessage: args.userMessage,
        workspaceSlug: args.workspaceSlug,
        threadHistory: args.threadHistory ?? [],
        issueContext: args.issueContext ?? null,
        attachments: args.attachments ?? [],
      });
    case "CODEX":
    case "HERMES":
    case "CUSTOM":
    default:
      return stubReply(args, provider);
  }
}

async function stubReply(
  args: DispatchChatArgs,
  provider: string,
): Promise<void> {
  // Open a draft and immediately finalize so the user sees a real bubble
  // rather than an empty draft state.
  try {
    const start = await callTool<{ draftId: string }>(
      args.auth,
      "chat.startDraft",
      { threadId: args.threadId },
    );
    if (start.isError || !start.data?.draftId) {
      console.error(
        `[dispatch] stubReply could not open draft: ${start.text}`,
      );
      return;
    }
    await callTool(args.auth, "chat.finalizeDraft", {
      threadId: args.threadId,
      draftId: start.data.draftId,
      body: `[provider:${provider}] Local daemon recognised this dispatch but the ${provider} provider adapter isn't implemented yet. Track this in the Forge runtimes roadmap.`,
    });
  } catch (err) {
    console.error(`[dispatch] stubReply error:`, err);
  }
}

/** Re-export for convenience — `daemon.ts` calls this for chat dispatch. */
export type { ChatMessageHistoryRow, DispatchAgent, InlineAttachment, IssueBundle };
