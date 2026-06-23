import { describe, it, expect } from "vitest";
import { EngagementMode, MentionEngagementPolicy } from "@prisma/client";
import {
  resolveEngagementMode,
  engagementInstruction,
  forgeRunInstruction,
  forgeRunProtocolInstruction,
  modeMayExecute,
  engagementSourceToEnum,
  type WorkspaceEngagementConfig,
} from "@/server/services/engagement-mode";

const ws: WorkspaceEngagementConfig = {
  assignmentEngagementMode: EngagementMode.EXECUTE,
  mentionEngagementPolicy: MentionEngagementPolicy.INFER,
  mentionDefaultMode: EngagementMode.DISCUSS,
};

describe("resolveEngagementMode", () => {
  it("explicit override wins on every surface", () => {
    for (const surface of ["assignment", "mention", "chat", "plan", "watcher", "queue"] as const) {
      const r = resolveEngagementMode({ surface, explicit: EngagementMode.RESEARCH, workspace: ws });
      expect(r.mode).toBe(EngagementMode.RESEARCH);
      expect(r.source).toBe("explicit");
    }
  });

  describe("waterfall tiers (Phase 2 — folded in from the dispatch inbox)", () => {
    it("precedence is explicit > agent-request > payload > sticky-active-run > surface", () => {
      // all tiers set → explicit wins
      expect(
        resolveEngagementMode({
          surface: "assignment",
          explicit: EngagementMode.RESEARCH,
          agentRequestMode: EngagementMode.REVIEW,
          payloadMode: EngagementMode.DISCUSS,
          activeRunMode: EngagementMode.EXECUTE,
          workspace: ws,
        }),
      ).toMatchObject({ mode: "RESEARCH", source: "explicit" });
      // no explicit → agent-request wins
      expect(
        resolveEngagementMode({
          surface: "assignment",
          agentRequestMode: EngagementMode.REVIEW,
          payloadMode: EngagementMode.DISCUSS,
          activeRunMode: EngagementMode.EXECUTE,
          workspace: ws,
        }),
      ).toMatchObject({ mode: "REVIEW", source: "agent-request" });
      // payload beats sticky + surface
      expect(
        resolveEngagementMode({
          surface: "assignment",
          payloadMode: EngagementMode.DISCUSS,
          activeRunMode: EngagementMode.EXECUTE,
          workspace: ws,
        }),
      ).toMatchObject({ mode: "DISCUSS", source: "payload" });
      // sticky beats surface (don't flip a running RESEARCH to EXECUTE)
      expect(
        resolveEngagementMode({
          surface: "assignment",
          activeRunMode: EngagementMode.RESEARCH,
          workspace: ws,
        }),
      ).toMatchObject({ mode: "RESEARCH", source: "sticky-active-run" });
      // none set → surface default
      expect(
        resolveEngagementMode({ surface: "assignment", workspace: ws }),
      ).toMatchObject({ mode: "EXECUTE", source: "surface-default" });
    });

    it("null/undefined tiers are skipped (don't short-circuit)", () => {
      expect(
        resolveEngagementMode({
          surface: "mention",
          agentRequestMode: null,
          payloadMode: undefined,
          activeRunMode: null,
          workspace: ws,
        }).source,
      ).toBe("policy-infer");
    });
  });

  it("engagementSourceToEnum maps every kebab source to the Prisma enum", () => {
    const pairs: Array<[Parameters<typeof engagementSourceToEnum>[0], string]> = [
      ["explicit", "EXPLICIT"],
      ["surface-default", "SURFACE_DEFAULT"],
      ["policy-infer", "POLICY_INFER"],
      ["policy-fixed", "POLICY_FIXED"],
      ["policy-require-marker", "POLICY_REQUIRE_MARKER"],
      ["sticky-active-run", "STICKY_ACTIVE_RUN"],
      ["agent-request", "AGENT_REQUEST"],
      ["payload", "PAYLOAD"],
    ];
    for (const [kebab, enumVal] of pairs) {
      expect(engagementSourceToEnum(kebab)).toBe(enumVal);
    }
  });

  it("assignment + queue use the workspace assignment default", () => {
    expect(resolveEngagementMode({ surface: "assignment", workspace: ws }).mode).toBe("EXECUTE");
    expect(resolveEngagementMode({ surface: "queue", workspace: ws }).mode).toBe("EXECUTE");
    const research: WorkspaceEngagementConfig = { ...ws, assignmentEngagementMode: EngagementMode.RESEARCH };
    expect(resolveEngagementMode({ surface: "assignment", workspace: research }).mode).toBe("RESEARCH");
  });

  it("assignment + queue honor the agent binding override before the workspace default", () => {
    const bound: WorkspaceEngagementConfig = {
      ...ws,
      assignmentAgentEngagementMode: EngagementMode.REVIEW,
    };
    expect(resolveEngagementMode({ surface: "assignment", workspace: bound }).mode).toBe("REVIEW");
    expect(resolveEngagementMode({ surface: "queue", workspace: bound }).mode).toBe("REVIEW");
    expect(
      resolveEngagementMode({
        surface: "assignment",
        explicit: EngagementMode.EXECUTE,
        workspace: bound,
      }).mode,
    ).toBe("EXECUTE");
  });

  it("chat defaults DISCUSS, plan defaults EXECUTE, watcher defaults DISCUSS", () => {
    expect(resolveEngagementMode({ surface: "chat", workspace: ws }).mode).toBe("DISCUSS");
    expect(resolveEngagementMode({ surface: "plan", workspace: ws }).mode).toBe("EXECUTE");
    expect(resolveEngagementMode({ surface: "watcher", workspace: ws }).mode).toBe("DISCUSS");
  });

  it("mention INFER → default mode, inferable=true (agent may infer, asks first)", () => {
    const r = resolveEngagementMode({ surface: "mention", workspace: ws });
    expect(r.mode).toBe("DISCUSS");
    expect(r.source).toBe("policy-infer");
    expect(r.inferable).toBe(true);
    expect(engagementInstruction(r)).toContain("ASK for confirmation");
  });

  it("mention FIXED → default mode, not inferable", () => {
    const fixed: WorkspaceEngagementConfig = { ...ws, mentionEngagementPolicy: MentionEngagementPolicy.FIXED };
    const r = resolveEngagementMode({ surface: "mention", workspace: fixed });
    expect(r.mode).toBe("DISCUSS");
    expect(r.source).toBe("policy-fixed");
    expect(r.inferable).toBe(false);
  });

  it("mention REQUIRE_MARKER → DISCUSS (no execution without a marker)", () => {
    const req: WorkspaceEngagementConfig = { ...ws, mentionEngagementPolicy: MentionEngagementPolicy.REQUIRE_MARKER };
    const r = resolveEngagementMode({ surface: "mention", workspace: req });
    expect(r.mode).toBe("DISCUSS");
    expect(r.source).toBe("policy-require-marker");
  });

  it("mention with explicit marker beats REQUIRE_MARKER", () => {
    const req: WorkspaceEngagementConfig = { ...ws, mentionEngagementPolicy: MentionEngagementPolicy.REQUIRE_MARKER };
    const r = resolveEngagementMode({ surface: "mention", explicit: EngagementMode.EXECUTE, workspace: req });
    expect(r.mode).toBe("EXECUTE");
    expect(r.source).toBe("explicit");
  });

  it("modeMayExecute is true only for EXECUTE", () => {
    expect(modeMayExecute(EngagementMode.EXECUTE)).toBe(true);
    expect(modeMayExecute(EngagementMode.RESEARCH)).toBe(false);
    expect(modeMayExecute(EngagementMode.REVIEW)).toBe(false);
    expect(modeMayExecute(EngagementMode.DISCUSS)).toBe(false);
  });

  it("instruction blocks are mode-specific", () => {
    const mk = (mode: EngagementMode) =>
      engagementInstruction({ mode, source: "explicit", inferable: false });
    expect(mk(EngagementMode.EXECUTE)).toContain("EXECUTE");
    expect(mk(EngagementMode.RESEARCH)).toContain("Do NOT modify code");
    expect(mk(EngagementMode.REVIEW)).toContain("verdict");
    expect(mk(EngagementMode.DISCUSS)).toContain("No work product");
  });

  it("run protocol instructions describe ack, output start, waiting, and completion", () => {
    const text = forgeRunProtocolInstruction();
    expect(text).toContain("agent.inbox.ack");
    expect(text).toContain("agent.inbox.outputStarted");
    expect(text).toContain("runs.setWaiting");
    expect(text).toContain("runs.complete");
  });

  it("forgeRunInstruction combines mode contract with run protocol", () => {
    const text = forgeRunInstruction({
      mode: EngagementMode.RESEARCH,
      source: "explicit",
      inferable: false,
    });
    expect(text).toContain("ENGAGEMENT MODE: RESEARCH");
    expect(text).toContain("FORGE RUN PROTOCOL");
  });
});
