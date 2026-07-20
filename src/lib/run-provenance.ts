export type WorkstreamRunConnection = {
  kind: "MCP_CLIENT" | "MANAGED_RUNTIME" | "WEBHOOK" | "ON_DEMAND";
  displayName?: string | null;
  clientName?: string | null;
  runtime?: { name?: string | null } | null;
};

export type WorkstreamRunProvenance = {
  label: string;
  description: string;
  recorded: boolean;
};

function connectionName(connection: WorkstreamRunConnection): string | null {
  return connection.displayName ?? connection.clientName ?? connection.runtime?.name ?? null;
}

export function workstreamRunProvenance(input: {
  run?: {
    externalRunId?: string | null;
    connection?: WorkstreamRunConnection | null;
    runtimePolicy?: unknown;
  } | null;
  configuredRuntimeName?: string | null;
  configuredRuntimeMode?: string | null;
}): WorkstreamRunProvenance {
  const connection = input.run?.connection;
  if (connection) {
    const name = connectionName(connection);
    if (
      connection.kind === "MANAGED_RUNTIME" &&
      input.run?.externalRunId &&
      connection.runtime?.name
    ) {
      return {
        label: `Ran on ${connection.runtime.name}`,
        description:
          "This managed runtime is recorded on the output-producing run with an external run id.",
        recorded: true,
      };
    }
    if (connection.kind === "MCP_CLIENT") {
      return {
        label: `Via MCP${name ? ` · ${name}` : ""}`,
        description:
          "This run was opened and updated through an MCP client. No managed runtime execution is claimed.",
        recorded: true,
      };
    }
    if (connection.kind === "WEBHOOK") {
      return {
        label: `Via webhook${name ? ` · ${name}` : ""}`,
        description:
          "This run is attributed to a webhook connection. A managed runtime is shown only when its execution is recorded separately.",
        recorded: true,
      };
    }
    return {
      label: `Via on-demand connection${name ? ` · ${name}` : ""}`,
      description:
        "This run is attributed to an on-demand connection. A managed runtime is shown only when its execution is recorded separately.",
      recorded: true,
    };
  }

  if (input.run) {
    return {
      label: "Execution source not recorded",
      description:
        "This historical run has no concrete connection provenance. Forge will not infer execution from the Agent Profile configuration.",
      recorded: false,
    };
  }

  if (input.configuredRuntimeName) {
    const lifetime = input.configuredRuntimeMode === "EPHEMERAL" ? "session" : "persistent";
    return {
      label: `Configured for ${input.configuredRuntimeName} · ${lifetime}`,
      description:
        "This is the Agent Profile's configured execution target, not evidence that a run executed there.",
      recorded: false,
    };
  }

  return {
    label: "No execution target configured",
    description: "No run connection or Agent Profile execution target is available.",
    recorded: false,
  };
}
