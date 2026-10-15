import { describe, expect, it } from "vitest";
import { canConfirmRuntimeLifecycle, runtimeOwnershipLabel } from "@/lib/runtime-ownership";

describe("runtime ownership presentation", () => {
  it("distinguishes personal, service-owned, and unassigned without inferring from workspace", () => {
    expect(runtimeOwnershipLabel({ ownerType: "PERSONAL", owner: { name: "Bailey" } })).toBe(
      "Personal · Bailey",
    );
    expect(runtimeOwnershipLabel({ ownerType: "SERVICE", owner: null })).toBe(
      "Service-owned · instance managed",
    );
    expect(runtimeOwnershipLabel({ ownerType: "UNASSIGNED", owner: null })).toBe(
      "Unassigned · needs an ownership decision",
    );
  });

  it("does not disguise a missing personal owner as service-owned", () => {
    expect(runtimeOwnershipLabel({ ownerType: "PERSONAL", owner: null })).toBe(
      "Personal · Owner unavailable",
    );
  });
});

describe("runtime lifecycle confirmation", () => {
  const ready = {
    name: "Local runner",
    confirmation: "Local runner",
    blockers: [],
    fetching: false,
    pending: false,
  };
  it("requires an exact typed name", () => {
    expect(canConfirmRuntimeLifecycle(ready)).toBe(true);
    expect(canConfirmRuntimeLifecycle({ ...ready, confirmation: "local runner" })).toBe(false);
    expect(canConfirmRuntimeLifecycle({ ...ready, confirmation: "Local runner " })).toBe(false);
    expect(canConfirmRuntimeLifecycle({ ...ready, name: "", confirmation: "" })).toBe(false);
  });
  it("blocks during refresh and mutation or while dependencies prevent the action", () => {
    expect(canConfirmRuntimeLifecycle({ ...ready, fetching: true })).toBe(false);
    expect(canConfirmRuntimeLifecycle({ ...ready, pending: true })).toBe(false);
    expect(
      canConfirmRuntimeLifecycle({ ...ready, blockers: ["Active agent still uses this runtime."] }),
    ).toBe(false);
  });
  it("requires an explicit personal owner", () => {
    expect(canConfirmRuntimeLifecycle({ ...ready, ownerRequired: true, ownerId: null })).toBe(
      false,
    );
    expect(canConfirmRuntimeLifecycle({ ...ready, ownerRequired: true, ownerId: "owner-1" })).toBe(
      true,
    );
    expect(canConfirmRuntimeLifecycle({ ...ready, ownerRequired: false, ownerId: null })).toBe(
      true,
    );
  });
});
