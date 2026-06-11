import { describe, expect, it } from "vitest";
import { shouldStartInProcessWorker } from "@/instrumentation";

describe("instrumentation worker boot policy", () => {
  it("does not start BullMQ workers inside the production web process by default", () => {
    expect(
      shouldStartInProcessWorker({
        nodeEnv: "production",
        disableInProcessWorker: undefined,
        enableInProcessWorker: undefined,
      }),
    ).toBe(false);
  });

  it("keeps the in-process worker available outside production unless explicitly disabled", () => {
    expect(
      shouldStartInProcessWorker({
        nodeEnv: "development",
        disableInProcessWorker: undefined,
        enableInProcessWorker: undefined,
      }),
    ).toBe(true);
  });

  it("allows an explicit production opt-in for single-process deployments", () => {
    expect(
      shouldStartInProcessWorker({
        nodeEnv: "production",
        disableInProcessWorker: undefined,
        enableInProcessWorker: "1",
      }),
    ).toBe(true);
  });

  it("honors the disable switch before any opt-in", () => {
    expect(
      shouldStartInProcessWorker({
        nodeEnv: "development",
        disableInProcessWorker: "1",
        enableInProcessWorker: "1",
      }),
    ).toBe(false);
  });
});
