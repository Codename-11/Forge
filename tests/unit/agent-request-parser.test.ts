import { describe, expect, it } from "vitest";
import {
  parseAgentRequestsFromBody,
  parseAgentRequestTokensFromBody,
} from "@/lib/agent-request-parser";

describe("agent request parser", () => {
  it("defaults bare @agent mentions to Discuss", () => {
    expect(parseAgentRequestsFromBody("@victor what do you think?"))
      .toEqual([{ profileKey: "victor", mode: "DISCUSS" }]);
  });

  it("detects slash, colon, and bare-word mode sugar after the mention", () => {
    expect(
      parseAgentRequestsFromBody("@victor /research options, @mizu:review this, @lucy execute it"),
    ).toEqual([
      { profileKey: "victor", mode: "RESEARCH" },
      { profileKey: "mizu", mode: "REVIEW" },
      { profileKey: "lucy", mode: "EXECUTE" },
    ]);
  });

  it("returns mode spans for composer highlighting", () => {
    const body = "Please ask @victor /review before @mizu: execute";
    const tokens = parseAgentRequestTokensFromBody(body);

    expect(tokens.map((t) => ({ key: t.profileKey, mention: body.slice(t.mentionStart, t.mentionEnd), mode: t.rawMode })))
      .toEqual([
        { key: "victor", mention: "@victor", mode: "/review" },
        { key: "mizu", mention: "@mizu", mode: "execute" },
      ]);
    expect(body.slice(tokens[0].modeStart ?? -1, tokens[0].modeEnd ?? -1)).toBe("/review");
    expect(body.slice(tokens[1].modeStart ?? -1, tokens[1].modeEnd ?? -1)).toBe("execute");
  });

  it("does not treat email addresses or partial mode words as requests", () => {
    expect(parseAgentRequestsFromBody("email me at test@example.com; @victor reviewing this"))
      .toEqual([{ profileKey: "victor", mode: "DISCUSS" }]);
  });

  it("keeps first explicit mode when an agent is mentioned more than once", () => {
    expect(parseAgentRequestsFromBody("@victor /review this; later @victor /execute"))
      .toEqual([{ profileKey: "victor", mode: "REVIEW" }]);
  });
});
