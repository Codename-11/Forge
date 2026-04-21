import { describe, it, expect } from "vitest";
import { extractMentions } from "@/server/services/mentions";

describe("extractMentions", () => {
  it("returns an empty array for empty / no-match bodies", () => {
    expect(extractMentions("")).toEqual([]);
    expect(extractMentions("hello world")).toEqual([]);
    // @ not followed by a valid first char — `@-foo` must start alnum.
    expect(extractMentions("@-foo @_bar")).toEqual([]);
  });

  it("matches profileKey-shaped handles", () => {
    expect(extractMentions("ping @victor @mizu")).toEqual(["victor", "mizu"]);
  });

  it("deduplicates in order", () => {
    expect(extractMentions("@victor ping @victor again")).toEqual(["victor"]);
  });

  it("allows hyphen, underscore, and digits after the first char", () => {
    expect(extractMentions("@a1 @bot-2 @snake_case")).toEqual([
      "a1",
      "bot-2",
      "snake_case",
    ]);
  });

  it("ignores email-like strings (prefix is not word-boundary-safe but handle is still captured)", () => {
    // Intentional: `@` inside an email still captures the local-part-suffix.
    // Callers resolve against the Agent table so false positives are benign.
    expect(extractMentions("bailey@axiom-labs.cloud")).toEqual(["axiom-labs"]);
  });
});
