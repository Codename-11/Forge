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
      tone: "warning",
      label: "Setup required",
      summary: "Register a runtime before agents can execute queued work.",
      actionLabel: "Register a runtime",
      actionHref: "/settings/runtimes",
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
