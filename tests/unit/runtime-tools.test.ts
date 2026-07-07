import { describe, expect, it } from "vitest";
import { runtimeModeToolCapabilities } from "@/lib/runtime-tools";

describe("runtimeModeToolCapabilities", () => {
  const declaresAll = { toolCapabilities: ["terminal", "filesystem", "git"] };

  it("gives EXECUTE everything the runtime declared", () => {
    expect(runtimeModeToolCapabilities(declaresAll, "EXECUTE")).toEqual([
      "terminal",
      "filesystem",
      "git",
    ]);
  });

  it("gives RESEARCH the read-oriented subset by default, never terminal", () => {
    expect(runtimeModeToolCapabilities(declaresAll, "RESEARCH")).toEqual(["filesystem", "git"]);
  });

  it("gives REVIEW the same read-oriented subset by default", () => {
    expect(runtimeModeToolCapabilities(declaresAll, "REVIEW")).toEqual(["filesystem", "git"]);
  });

  it("gives DISCUSS nothing by default", () => {
    expect(runtimeModeToolCapabilities(declaresAll, "DISCUSS")).toEqual([]);
  });

  it("never grants a tool the runtime didn't declare, even for RESEARCH", () => {
    expect(runtimeModeToolCapabilities({ toolCapabilities: ["terminal"] }, "RESEARCH")).toEqual([]);
    expect(runtimeModeToolCapabilities({ toolCapabilities: ["git"] }, "RESEARCH")).toEqual(["git"]);
  });

  it("respects an explicit modeToolProfiles override over the default", () => {
    const config = {
      ...declaresAll,
      modeToolProfiles: { RESEARCH: ["terminal"] },
    };
    expect(runtimeModeToolCapabilities(config, "RESEARCH")).toEqual(["terminal"]);
    // Other modes still fall back to the computed default.
    expect(runtimeModeToolCapabilities(config, "REVIEW")).toEqual(["filesystem", "git"]);
  });

  it("an empty explicit override means literally zero tools, not fallback", () => {
    const config = { ...declaresAll, modeToolProfiles: { RESEARCH: [] } };
    expect(runtimeModeToolCapabilities(config, "RESEARCH")).toEqual([]);
  });
});
