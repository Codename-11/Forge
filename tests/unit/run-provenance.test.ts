import { describe, expect, it } from "vitest";
import { workstreamRunProvenance } from "@/lib/run-provenance";

describe("workstreamRunProvenance", () => {
  it("attributes direct MCP work to the transport instead of the configured runtime", () => {
    const result = workstreamRunProvenance({
      run: {
        connection: {
          kind: "MCP_CLIENT",
          displayName: "Codex Desktop",
        },
      },
      configuredRuntimeName: "Codex app server",
      configuredRuntimeMode: "PERSISTENT",
    });

    expect(result).toMatchObject({
      label: "Via MCP · Codex Desktop",
      recorded: true,
    });
    expect(result.label).not.toContain("Codex app server");
  });

  it("claims managed runtime execution only when the run has an external runtime id", () => {
    expect(
      workstreamRunProvenance({
        run: {
          externalRunId: "runtime-run-42",
          connection: {
            kind: "MANAGED_RUNTIME",
            displayName: "Codex Runtime",
            runtime: { name: "Codex app server" },
          },
        },
      }),
    ).toMatchObject({ label: "Ran on Codex app server", recorded: true });
  });

  it("does not infer execution for a historical run without a connection", () => {
    expect(
      workstreamRunProvenance({
        run: {},
        configuredRuntimeName: "Codex app server",
        configuredRuntimeMode: "PERSISTENT",
      }),
    ).toMatchObject({ label: "Execution source not recorded", recorded: false });
  });

  it("shows profile configuration only when there is no run", () => {
    expect(
      workstreamRunProvenance({
        configuredRuntimeName: "Codex app server",
        configuredRuntimeMode: "PERSISTENT",
      }),
    ).toMatchObject({
      label: "Configured for Codex app server · persistent",
      recorded: false,
    });
  });
});
