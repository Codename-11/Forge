import { describe, expect, it } from "vitest";
import {
  buildAgentHref,
  getEventNotificationActionLinks,
  mapActivityEventToNotification,
  mapAlertableActivityEventToNotification,
  type EventNotificationInput,
  type NotificationAgentReference,
  type NotificationIssueReference,
  type NotificationWorkspaceContext,
} from "@/lib/notifications/event-notification";

const workspace: NotificationWorkspaceContext = {
  slug: "axiom",
  key: "AXI",
};

/** Assert the mapper produced metadata (alertable issue kinds always do). */
function mustMap(
  input: EventNotificationInput,
): NonNullable<ReturnType<typeof mapAlertableActivityEventToNotification>> {
  const out = mapAlertableActivityEventToNotification(input);
  if (!out) throw new Error("expected notification metadata, got null");
  return out;
}

const victor: NotificationAgentReference = {
  id: "ag_db_victor",
  name: "Victor",
  profileKey: "victor",
};

const issue: NotificationIssueReference = {
  id: "iss_42",
  number: 42,
  title: "Queue item is wedged",
  workspace: { key: "AXI" },
  assignedAgent: victor,
};

describe("event notification mapping", () => {
  it("maps AGENT_NOACK to issue and profileKey agent links", () => {
    const out = mustMap({
      workspace,
      issue,
      agent: victor,
      event: {
        id: "evt_noack",
        kind: "AGENT_NOACK",
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          agentId: victor.id,
          agentProfileKey: victor.profileKey,
          requiredAckSeconds: 90,
        },
      },
    });

    expect(out.severity).toBe("WARNING");
    expect(out.summary).toBe("@victor missed wake for AXI-42");
    expect(out.reason).toContain("within 90s");
    expect(out.primaryHref).toBe("/w/axiom/issues/iss_42");
    expect(out.detailHref).toBe("/w/axiom/agents/victor?health=noack#dispatch-health");
    expect(out.detailHref).not.toContain(victor.id);
    expect(out.primaryActionLabel).toBe("View issue");
    expect(out.detailActionLabel).toBe("Check health");
    expect(out.toast.actionLabel).toBe("View issue");
  });

  it("maps ISSUE_SLA_BREACH with overdue minutes", () => {
    const out = mustMap({
      workspace,
      issue,
      event: {
        id: "evt_sla",
        kind: "ISSUE_SLA_BREACH",
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          slaMinutes: 30,
          breachedByMinutes: 12,
        },
      },
    });

    expect(out.severity).toBe("ERROR");
    expect(out.importance).toBeGreaterThan(80);
    expect(out.summary).toBe("AXI-42 breached SLA");
    expect(out.reason).toBe("AXI-42 is 12m overdue against a 30m SLA.");
    expect(out.primaryHref).toBe("/w/axiom/issues/iss_42");
    expect(out.detailHref).toBe("/w/axiom/issues/iss_42?tab=activity");
    expect(out.primaryActionLabel).toBe("View issue");
    expect(out.detailActionLabel).toBe("Open activity");
    expect(out.toast.description).toBe("12m overdue");
  });

  it("maps ISSUE_STALLED with an assigned agent", () => {
    const out = mustMap({
      workspace,
      issue,
      event: {
        id: "evt_stalled",
        kind: "ISSUE_STALLED",
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          assignedAgentId: victor.id,
          slaMinutes: 15,
        },
      },
    });

    expect(out.severity).toBe("WARNING");
    expect(out.summary).toBe("AXI-42 stalled");
    expect(out.reason).toContain("15m assignment SLA");
    expect(out.reason).toContain("@victor");
    expect(out.recommendedAction).toContain("reassign");
    expect(out.primaryHref).toBe("/w/axiom/issues/iss_42");
    expect(getEventNotificationActionLinks(out)).toEqual([
      {
        href: "/w/axiom/issues/iss_42",
        label: "View issue",
        kind: "primary",
      },
      {
        href: "/w/axiom/issues/iss_42?tab=activity",
        label: "Open activity",
        kind: "detail",
      },
    ]);
  });

  it("handles missing issue and agent references with fallback copy", () => {
    const input: EventNotificationInput = {
      workspace,
      event: {
        id: "evt_missing",
        kind: "AGENT_NOACK",
        subjectType: "issue",
        subjectId: "iss_missing",
        payload: {
          requiredAckSeconds: 45,
        },
      },
      issue: null,
      agent: null,
    };

    const out = mustMap(input);

    expect(out.summary).toBe("Missed wake for an issue");
    expect(out.reason).toBe("The assigned agent did not acknowledge an issue within 45s.");
    expect(out.primaryHref).toBe("/w/axiom/issues/iss_missing");
    expect(out.detailHref).toBe("/w/axiom/issues/iss_missing?tab=activity");
  });

  it("returns one action link when detail points at the same destination", () => {
    const out = mustMap({
      workspace,
      event: {
        id: "evt_workspace_fallback",
        kind: "ISSUE_SLA_BREACH",
        subjectType: "workspace",
        subjectId: "ws_1",
        payload: {},
      },
      issue: null,
      agent: null,
    });

    expect(out.primaryHref).toBe("/w/axiom");
    expect(getEventNotificationActionLinks(out)).toEqual([
      {
        href: "/w/axiom",
        label: "Open workspace",
        kind: "primary",
      },
    ]);
  });

  it("builds agent URLs from profileKey instead of database id", () => {
    const out = mustMap({
      workspace,
      issue,
      agent: victor,
      event: {
        kind: "AGENT_NOACK",
        subjectType: "issue",
        subjectId: issue.id,
        payload: { agentId: victor.id },
      },
    });

    expect(buildAgentHref(workspace, victor.profileKey ?? "")).toBe("/w/axiom/agents/victor");
    expect(out.detailHref).toBe("/w/axiom/agents/victor?health=noack#dispatch-health");
    expect(out.detailHref).not.toBe(`/w/axiom/agents/${victor.id}`);
  });

  it("returns null for non-alertable activity events", () => {
    const out = mapActivityEventToNotification({
      workspace,
      event: {
        kind: "ISSUE_CREATED",
        subjectType: "issue",
        subjectId: issue.id,
        payload: {},
      },
    });

    expect(out).toBeNull();
  });

  it("alerts on an achieved goal and links to the goal", () => {
    const out = mustMap({
      workspace,
      event: {
        kind: "GOAL_STATUS_CHANGED",
        subjectType: "goal",
        subjectId: "goal_1",
        payload: { from: "ACTIVE", to: "ACHIEVED" },
      },
    });
    expect(out.severity).toBe("SUCCESS");
    expect(out.primaryHref).toBe("/w/axiom/goals/goal_1");
  });

  it("stays quiet on routine goal status churn", () => {
    const out = mapAlertableActivityEventToNotification({
      workspace,
      event: {
        kind: "GOAL_STATUS_CHANGED",
        subjectType: "goal",
        subjectId: "goal_1",
        payload: { from: "OPEN", to: "PLANNING" },
      },
    });
    expect(out).toBeNull();
  });

  it("alerts when a plan exceeds budget and links to the plan", () => {
    const out = mustMap({
      workspace,
      event: {
        kind: "PLAN_BUDGET_EXCEEDED",
        subjectType: "execution-plan",
        subjectId: "plan_9",
        payload: { reason: "cost cap $5.00 exceeded" },
      },
    });
    expect(out.severity).toBe("WARNING");
    expect(out.primaryHref).toBe("/w/axiom/plans/plan_9");
    expect(out.reason).toContain("cost cap");
  });

  it("alerts only on a BLOCKED step verdict, linking to its plan", () => {
    const blocked = mustMap({
      workspace,
      event: {
        kind: "EXECUTION_STEP_JUDGED",
        subjectType: "execution-step",
        subjectId: "step_3",
        payload: { planId: "plan_9", outcome: "BLOCKED", feedback: "tests still failing" },
      },
    });
    expect(blocked.severity).toBe("ERROR");
    expect(blocked.primaryHref).toBe("/w/axiom/plans/plan_9");

    const passed = mapAlertableActivityEventToNotification({
      workspace,
      event: {
        kind: "EXECUTION_STEP_JUDGED",
        subjectType: "execution-step",
        subjectId: "step_3",
        payload: { planId: "plan_9", outcome: "DONE" },
      },
    });
    expect(passed).toBeNull();
  });
});
