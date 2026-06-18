import { describe, expect, it } from "vitest";
import { parseGeneratedPlanMessage } from "@/server/services/ai";

function step(overrides: Record<string, unknown> = {}) {
  return {
    title: "Inspect current planner",
    body: "Trace the goal generation flow.",
    expected_output: "A concrete diagnosis.",
    verification: ["The failing branch is identified."],
    depends_on_step_indexes: [],
    assigned_role: "WORKER",
    ...overrides,
  };
}

describe("parseGeneratedPlanMessage", () => {
  it("parses the standard tool_calls function arguments", () => {
    const parsed = parseGeneratedPlanMessage({
      tool_calls: [
        {
          type: "function",
          function: {
            name: "submit_plan",
            arguments: JSON.stringify({ steps: [step()] }),
          },
        },
      ],
    });

    expect(parsed?.source).toBe("tool_calls");
    expect(parsed?.steps).toEqual([
      {
        title: "Inspect current planner",
        body: "Trace the goal generation flow.",
        expectedOutput: "A concrete diagnosis.",
        verification: ["The failing branch is identified."],
        dependsOnStepIndexes: [],
        assignedRole: "WORKER",
      },
    ]);
  });

  it("parses legacy function_call arguments", () => {
    const parsed = parseGeneratedPlanMessage({
      function_call: {
        name: "submit_plan",
        arguments: JSON.stringify({
          steps: [
            step({
              title: "Review generated draft",
              expectedOutput: "A reviewed plan.",
              depends_on_step_indexes: [0, 1, -1],
              assigned_role: "reviewer",
            }),
          ],
        }),
      },
    });

    expect(parsed?.source).toBe("function_call");
    expect(parsed?.steps[0]?.title).toBe("Review generated draft");
    expect(parsed?.steps[0]?.dependsOnStepIndexes).toEqual([]);
    expect(parsed?.steps[0]?.assignedRole).toBe("REVIEWER");
  });

  it("parses fenced JSON content when no tool call is present", () => {
    const parsed = parseGeneratedPlanMessage({
      content: `Here is the plan:

\`\`\`json
{
  "steps": [
    {
      "title": "Patch parser",
      "description": "Accept content JSON from OpenAI-compatible providers.",
      "expectedOutput": "Plan generation accepts provider content JSON.",
      "verification": "Focused parser tests pass",
      "dependsOnStepIndexes": [],
      "assignedRole": null
    }
  ]
}
\`\`\``,
    });

    expect(parsed?.source).toBe("content_json");
    expect(parsed?.steps[0]).toMatchObject({
      title: "Patch parser",
      body: "Accept content JSON from OpenAI-compatible providers.",
      expectedOutput: "Plan generation accepts provider content JSON.",
      verification: ["Focused parser tests pass"],
      assignedRole: null,
    });
  });

  it("falls back to numbered markdown steps", () => {
    const parsed = parseGeneratedPlanMessage({
      content: `1. Inspect goal generation
   Check the provider response shape.
   Verification: The missing parser case is known.
2. Patch and test
   Expected output: Forge creates a draft plan instead of throwing.
   Verification: Unit tests cover the fallback.`,
    });

    expect(parsed?.source).toBe("content_markdown");
    expect(parsed?.steps).toHaveLength(2);
    expect(parsed?.steps[0]).toMatchObject({
      title: "Inspect goal generation",
      body: "Check the provider response shape.",
      expectedOutput: null,
      verification: ["The missing parser case is known."],
    });
    expect(parsed?.steps[1]).toMatchObject({
      title: "Patch and test",
      body: null,
      expectedOutput: "Forge creates a draft plan instead of throwing.",
      verification: ["Unit tests cover the fallback."],
    });
  });

  it("falls back to plain top-level bullet steps", () => {
    const parsed = parseGeneratedPlanMessage({
      content: `- Inspect the deployment logs
- Patch the parser
- Verify the generated plan draft`,
    });

    expect(parsed?.source).toBe("content_markdown");
    expect(parsed?.steps.map((s) => s.title)).toEqual([
      "Inspect the deployment logs",
      "Patch the parser",
      "Verify the generated plan draft",
    ]);
  });
});
