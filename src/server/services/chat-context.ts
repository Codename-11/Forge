import "server-only";

export interface ChatContextSnapshot {
  route?: string;
  slug?: string;
  issueId?: string;
  selectedIds?: string[];
  visibleEntities?: { kind: string; ids: string[] }[];
  pinnedRunIds?: string[];
  liveRunIds?: string[];
}

export function buildChatSystemPrompt(args: {
  agent: { name: string; profileKey: string };
  user: { name: string | null };
  workspace: { name: string };
  context: ChatContextSnapshot | undefined;
  recentMessages: { role: string; body: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`You are ${args.agent.name} (@${args.agent.profileKey}), chatting with ${args.user.name ?? "operator"} in the ${args.workspace.name} workspace of Forge.`);
  lines.push(`Be concise, task-focused, and use Forge primitives (issues, projects, cycles) when referencing work.`);
  if (args.context?.route) lines.push(`Operator route: ${args.context.route}`);
  if (args.context?.issueId) lines.push(`Operator viewing issue: ${args.context.issueId}`);
  if (args.context?.liveRunIds?.length) lines.push(`Active runs: ${args.context.liveRunIds.length}`);
  return lines.join("\n");
}
