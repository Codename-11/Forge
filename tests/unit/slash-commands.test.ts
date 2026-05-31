import { describe, expect, it } from "vitest";
import {
  matchTrailingCommand,
  parseSlashCommands,
  parseDateExpression,
} from "@/lib/slash-commands";

describe("matchTrailingCommand", () => {
  it("matches a command at the end of a title and reports the slash index", () => {
    const text = "Fix login bug /priority high";
    const m = matchTrailingCommand(text);
    expect(m?.command).toEqual({ kind: "priority", level: "high" });
    expect(text.slice(0, m!.start)).toBe("Fix login bug ");
  });

  it("captures multi-word args intact (due / label)", () => {
    expect(matchTrailingCommand("Ship it /due in 3 days")?.command.kind).toBe(
      "due",
    );
    expect(matchTrailingCommand("Triage /label needs review")?.command).toEqual({
      kind: "label",
      name: "needs review",
    });
  });

  it("matches a command that is the entire input", () => {
    const m = matchTrailingCommand("/watch");
    expect(m?.command).toEqual({ kind: "watch" });
    expect(m?.start).toBe(0);
  });

  it("ignores a mid-token slash (URLs, and/or)", () => {
    expect(matchTrailingCommand("see https://example.com/foo")).toBeNull();
    expect(matchTrailingCommand("ship this and/or that")).toBeNull();
  });

  it("returns null when the tail is not a recognised command", () => {
    expect(matchTrailingCommand("Fix bug /bogus thing")).toBeNull();
    expect(matchTrailingCommand("Fix bug /assign")).toBeNull(); // no handle
    expect(matchTrailingCommand("plain title")).toBeNull();
  });
});

describe("parseSlashCommands", () => {
  it("returns the body unchanged when no commands present", () => {
    const r = parseSlashCommands("Just a comment with no commands.");
    expect(r.commands).toEqual([]);
    expect(r.strippedBody).toBe("Just a comment with no commands.");
  });

  it("strips a single leading command and parses it", () => {
    const r = parseSlashCommands("/priority high\nFix the deploy bug");
    expect(r.commands).toEqual([{ kind: "priority", level: "high" }]);
    expect(r.strippedBody).toBe("Fix the deploy bug");
  });

  it("supports multiple top-of-document commands", () => {
    const r = parseSlashCommands(
      "/assign @victor\n/priority urgent\n/label bug\nThe site is down.",
    );
    expect(r.commands).toEqual([
      { kind: "assign", handle: "victor" },
      { kind: "priority", level: "urgent" },
      { kind: "label", name: "bug" },
    ]);
    expect(r.strippedBody).toBe("The site is down.");
  });

  it("preserves slash inside a fenced code block", () => {
    const body = "```\n/priority high\n```\nLook at this code.";
    const r = parseSlashCommands(body);
    expect(r.commands).toEqual([]);
    expect(r.strippedBody).toBe(body);
  });

  it("extracts recognised command lines anywhere, keeping prose between them", () => {
    // New coexistence model (2026-05-21): commands are no longer required
    // to be a contiguous leading block. A `/assign` line UNDER prose still
    // applies, so operators can chain prose + commands in one comment.
    const r = parseSlashCommands(
      "/priority high\nPlease fix\n/assign @bob",
    );
    expect(r.commands).toEqual([
      { kind: "priority", level: "high" },
      { kind: "assign", handle: "bob" },
    ]);
    expect(r.strippedBody).toBe("Please fix");
  });

  it("chains an @mention in prose with a /command on a later line", () => {
    const r = parseSlashCommands(
      "Hey @victor can you look at this?\n/priority urgent",
    );
    expect(r.commands).toEqual([{ kind: "priority", level: "urgent" }]);
    // The @mention prose is preserved verbatim so the create path still
    // extracts + dispatches @victor; only the command line is stripped.
    expect(r.strippedBody).toBe("Hey @victor can you look at this?");
  });

  it("does not treat a mid-line slash as a command (and/or, URLs)", () => {
    const r = parseSlashCommands(
      "ship it and/or revert — see https://x.test/p/1",
    );
    expect(r.commands).toEqual([]);
    expect(r.strippedBody).toBe(
      "ship it and/or revert — see https://x.test/p/1",
    );
  });

  it("ignores unrecognised slash forms (leaves them in body)", () => {
    const r = parseSlashCommands("/foo bar\nrest of the body");
    expect(r.commands).toEqual([]);
    expect(r.strippedBody).toBe("/foo bar\nrest of the body");
  });

  it("handles /watch and /unwatch", () => {
    const r = parseSlashCommands("/watch\n/unwatch\nbody");
    expect(r.commands).toEqual([{ kind: "watch" }, { kind: "unwatch" }]);
    expect(r.strippedBody).toBe("body");
  });

  it("handles /due tomorrow", () => {
    const now = new Date(2026, 4, 4); // May 4, 2026
    const r = parseSlashCommands("/due tomorrow", now);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].kind).toBe("due");
    if (r.commands[0].kind === "due") {
      expect(r.commands[0].date.getDate()).toBe(5);
    }
  });
});

describe("parseDateExpression", () => {
  const now = new Date(2026, 4, 4); // 2026-05-04 Mon

  it("parses today / tomorrow", () => {
    const today = parseDateExpression("today", now);
    expect(today?.getDate()).toBe(4);
    const tomorrow = parseDateExpression("tomorrow", now);
    expect(tomorrow?.getDate()).toBe(5);
  });

  it("parses 'in N days/weeks'", () => {
    expect(parseDateExpression("in 3 days", now)?.getDate()).toBe(7);
    expect(parseDateExpression("in 1 week", now)?.getDate()).toBe(11);
  });

  it("parses 'next Mon'", () => {
    const d = parseDateExpression("next Monday", now);
    expect(d?.getDay()).toBe(1);
    expect(d!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("parses ISO yyyy-mm-dd", () => {
    const d = parseDateExpression("2026-05-15", now);
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(4);
    expect(d?.getDate()).toBe(15);
  });

  it("parses 'May 15'", () => {
    const d = parseDateExpression("May 15", now);
    expect(d?.getMonth()).toBe(4);
    expect(d?.getDate()).toBe(15);
  });

  it("returns null for garbage", () => {
    expect(parseDateExpression("blah", now)).toBeNull();
    expect(parseDateExpression("", now)).toBeNull();
  });
});
