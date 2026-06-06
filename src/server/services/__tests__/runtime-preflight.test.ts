import { describe, expect, it } from "vitest";
import { runtimePreflightForIssue } from "@/server/services/runtime-preflight";

describe("runtime-preflight", () => {
  const victor = {
    name: "Victor",
    profileKey: "victor",
    provider: "HERMES" as const,
    webhookUrl: null,
    runtimeId: "runtime-1",
    runtime: {
      name: "Hermes gateway",
      kind: "REMOTE_HTTP" as const,
      adapterKey: "hermes",
      config: {},
    },
  };

  it("warns when repo-like work is assigned to a runtime without declared repo tools", () => {
    const warning = runtimePreflightForIssue({
      title: "Fix dispatcher regression and run tests",
      description: "Needs git patch, typecheck, and deploy.",
      labels: ["Bug"],
      assignedAgent: victor,
    });

    expect(warning?.severity).toBe("warning");
    expect(warning?.runtimeLabel).toBe("Hermes gateway");
    expect(warning?.requiredSurface).toContain("git");
  });

  it("does not warn when Hermes declares local workspace tools", () => {
    const warning = runtimePreflightForIssue({
      title: "Fix dispatcher regression and run tests",
      description: "Needs git patch, typecheck, and deploy.",
      labels: ["Bug"],
      assignedAgent: {
        ...victor,
        runtime: {
          ...victor.runtime,
          config: { toolCapabilities: ["terminal", "filesystem", "git"] },
        },
      },
    });

    expect(warning).toBeNull();
  });

  it("does not warn for non-code discussion work", () => {
    const warning = runtimePreflightForIssue({
      title: "Clarify rollout owner",
      description: "Please weigh in on the plan.",
      labels: ["Discussion"],
      assignedAgent: victor,
    });

    expect(warning).toBeNull();
  });
});
