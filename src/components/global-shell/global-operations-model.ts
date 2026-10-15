export type GlobalOperationsPosture = {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
  summary: string;
  actionLabel: string;
  actionHref: string;
};

export function deriveGlobalOperationsPosture(input: {
  activeRuns: number;
  agentsOnline: number;
  runtimeCount: number;
  runtimesOnline: number;
}): GlobalOperationsPosture {
  if (input.runtimeCount === 0) {
    return {
      tone: input.activeRuns > 0 ? "success" : "neutral",
      label: input.activeRuns > 0 ? "Work in motion" : "Managed execution optional",
      summary: input.activeRuns > 0
        ? `${input.activeRuns} active runs. No managed runtime is registered; external MCP work does not require one.`
        : "External MCP clients can work without a runtime. Configure managed execution only when Forge should dispatch work.",
      actionLabel: "Set up an agent",
      actionHref: "/agents",
    };
  }

  if (input.runtimesOnline < input.runtimeCount) {
    const offline = input.runtimeCount - input.runtimesOnline;
    return {
      tone: "danger",
      label: "Runtime attention",
      summary: `${offline} ${offline === 1 ? "runtime is" : "runtimes are"} unavailable for dispatch.`,
      actionLabel: "Inspect runtimes",
      actionHref: "/settings/runtimes",
    };
  }

  if (input.activeRuns > 0) {
    return {
      tone: "success",
      label: "Work in motion",
      summary: `${input.activeRuns} ${input.activeRuns === 1 ? "agent run is" : "agent runs are"} active across your workspaces.`,
      actionLabel: "View live activity",
      actionHref: "/activity",
    };
  }

  if (input.agentsOnline > 0) {
    return {
      tone: "success",
      label: "Ready to dispatch",
      summary: `${input.agentsOnline} ${input.agentsOnline === 1 ? "agent is" : "agents are"} online and ready for work.`,
      actionLabel: "Open agent coverage",
      actionHref: "/agents",
    };
  }

  return {
    tone: "neutral",
    label: "Standing by",
    summary: "Runtime coverage is healthy, but no agents are currently online.",
    actionLabel: "Review agents",
    actionHref: "/agents",
  };
}
