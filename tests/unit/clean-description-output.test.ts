import { describe, expect, it } from "vitest";
import { cleanDescriptionOutput } from "@/server/services/ai";

describe("cleanDescriptionOutput", () => {
  it("passes plain markdown through, trimmed", () => {
    expect(cleanDescriptionOutput("  A clear summary.\n\n## Steps\n- one  ")).toBe(
      "A clear summary.\n\n## Steps\n- one",
    );
  });

  it("strips a whole-output ```markdown fence", () => {
    expect(
      cleanDescriptionOutput("```markdown\nSummary line.\n\n- a\n- b\n```"),
    ).toBe("Summary line.\n\n- a\n- b");
  });

  it("strips a whole-output bare ``` fence", () => {
    expect(cleanDescriptionOutput("```\nJust this.\n```")).toBe("Just this.");
  });

  it("does NOT strip when the body is prose containing a code block", () => {
    const md = "Here's the fix:\n\n```ts\nconst x = 1;\n```\n\nDone.";
    expect(cleanDescriptionOutput(md)).toBe(md);
  });

  it("returns null for empty / whitespace / nullish", () => {
    expect(cleanDescriptionOutput("")).toBeNull();
    expect(cleanDescriptionOutput("   \n  ")).toBeNull();
    expect(cleanDescriptionOutput(null)).toBeNull();
    expect(cleanDescriptionOutput(undefined)).toBeNull();
  });
});
