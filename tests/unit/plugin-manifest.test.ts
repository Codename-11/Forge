import { describe, it, expect } from "vitest";
import { manifestSchema } from "@/server/services/plugin-manifest";

const valid = {
  schemaVersion: 1 as const,
  slug: "issue-triage",
  name: "Issue Triage",
  version: "0.1.0",
  scopes: ["READ_ISSUES", "WRITE_ISSUES"],
  events: ["ISSUE_CREATED"],
  skills: [
    {
      name: "triage",
      runtime: "local",
      inputSchema: { type: "object" },
    },
  ],
};

describe("plugin manifest", () => {
  it("accepts a well-formed manifest", () => {
    const r = manifestSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("rejects bad semver", () => {
    const r = manifestSchema.safeParse({ ...valid, version: "one" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown scopes", () => {
    const r = manifestSchema.safeParse({ ...valid, scopes: ["NOT_A_SCOPE"] });
    expect(r.success).toBe(false);
  });

  it("requires at least one scope", () => {
    const r = manifestSchema.safeParse({ ...valid, scopes: [] });
    expect(r.success).toBe(false);
  });
});
