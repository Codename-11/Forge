import { describe, expect, it } from "vitest";
import {
  expandTemplateLine,
  expandTemplatesInBody,
  findTemplate,
  SLASH_TEMPLATES,
  SLASH_TEMPLATE_HELP,
} from "@/lib/slash-templates";

describe("slash-templates", () => {
  describe("catalogue", () => {
    it("exposes the documented templates", () => {
      const keywords = SLASH_TEMPLATES.map((t) => t.keyword);
      expect(keywords).toEqual([
        "/status",
        "/blocked",
        "/goal",
        "/approve",
        "/handoff",
      ]);
    });

    it("SLASH_TEMPLATE_HELP mirrors keyword + example shape", () => {
      expect(SLASH_TEMPLATE_HELP).toHaveLength(SLASH_TEMPLATES.length);
      for (const row of SLASH_TEMPLATE_HELP) {
        expect(row.keyword.startsWith("/")).toBe(true);
        expect(typeof row.example).toBe("string");
      }
    });

    it("findTemplate is case-insensitive and returns null on miss", () => {
      expect(findTemplate("/STATUS")?.keyword).toBe("/status");
      expect(findTemplate("/nope")).toBeNull();
    });
  });

  describe("/status", () => {
    it("expands without args to a Working-on stub", () => {
      const result = expandTemplateLine("/status");
      expect(result).not.toBeNull();
      expect(result!.expansion.body).toBe("**Status:** Working on ");
      expect(result!.expansion.sideEffect.kind).toBe("none");
    });

    it("expands with args to a complete sentence", () => {
      const result = expandTemplateLine("/status auth flow");
      expect(result!.expansion.body).toBe("**Status:** Working on auth flow");
    });
  });

  describe("/blocked", () => {
    it("opens an action-request side-effect", () => {
      const result = expandTemplateLine("/blocked database is locked");
      expect(result!.expansion.body).toBe("**Blocked:** database is locked");
      expect(result!.expansion.sideEffect).toEqual({
        kind: "actionRequest",
        title: "Unblock needed",
      });
    });
  });

  describe("/goal", () => {
    it("returns null until an objective is typed", () => {
      expect(expandTemplateLine("/goal")).toBeNull();
    });

    it("emits a goal side-effect carrying the objective as the title", () => {
      const result = expandTemplateLine("/goal ship OAuth flow");
      expect(result!.expansion.sideEffect).toEqual({
        kind: "goal",
        title: "ship OAuth flow",
      });
    });
  });

  describe("/approve", () => {
    it("expands to a checkmark line", () => {
      const result = expandTemplateLine("/approve");
      expect(result!.expansion.body).toBe("**Approved** ✓");
      expect(result!.expansion.sideEffect.kind).toBe("none");
    });
  });

  describe("/handoff", () => {
    it("requires an agent handle", () => {
      expect(expandTemplateLine("/handoff")).toBeNull();
    });

    it("injects a /assign command and a handoff sentence", () => {
      const result = expandTemplateLine("/handoff @victor working on auth");
      expect(result).not.toBeNull();
      // Leading `/assign @victor` is intentional — the existing
      // server-side command parser picks it up and reassigns.
      expect(result!.expansion.body).toBe(
        "/assign @victor\n**Handing off to @victor:** working on auth",
      );
      expect(result!.expansion.sideEffect.kind).toBe("none");
    });

    it("accepts the @ being omitted", () => {
      const result = expandTemplateLine("/handoff mizu");
      expect(result!.expansion.body.startsWith("/assign @mizu\n")).toBe(true);
    });

    it("lowercases the handle", () => {
      const result = expandTemplateLine("/handoff @Victor");
      expect(result!.expansion.body.startsWith("/assign @victor\n")).toBe(true);
    });
  });

  describe("expandTemplatesInBody", () => {
    it("returns the body unchanged when no templates present", () => {
      const { expandedBody, sideEffects } = expandTemplatesInBody(
        "Just a comment.",
      );
      expect(expandedBody).toBe("Just a comment.");
      expect(sideEffects).toEqual([]);
    });

    it("expands a leading /blocked into prose and accumulates the side-effect", () => {
      const { expandedBody, sideEffects } = expandTemplatesInBody(
        "/blocked DB is locked\nFollowup detail",
      );
      expect(expandedBody).toBe("**Blocked:** DB is locked\nFollowup detail");
      expect(sideEffects).toEqual([
        { kind: "actionRequest", title: "Unblock needed" },
      ]);
    });

    it("expands /handoff and leaves the injected /assign for the command parser", () => {
      const { expandedBody, sideEffects } = expandTemplatesInBody(
        "/handoff @victor pushing the deploy work",
      );
      expect(expandedBody).toBe(
        "/assign @victor\n**Handing off to @victor:** pushing the deploy work",
      );
      expect(sideEffects).toEqual([]);
    });

    it("only touches the top-of-body block", () => {
      const body = "Lead-in prose\n/blocked mid-thread is ignored";
      const { expandedBody, sideEffects } = expandTemplatesInBody(body);
      expect(expandedBody).toBe(body);
      expect(sideEffects).toEqual([]);
    });

    it("preserves fenced code blocks at the top", () => {
      const body = "```\n/blocked still a code sample\n```\nReal prose.";
      const { expandedBody, sideEffects } = expandTemplatesInBody(body);
      expect(expandedBody).toBe(body);
      expect(sideEffects).toEqual([]);
    });

    it("leaves recognised non-template slash lines (e.g. /assign) for the command parser", () => {
      const body = "/assign @victor\nDriving the deploy.";
      const { expandedBody, sideEffects } = expandTemplatesInBody(body);
      expect(expandedBody).toBe(body);
      expect(sideEffects).toEqual([]);
    });
  });
});
