import { describe, it, expect, afterAll, afterEach } from "vitest";
import { DefaultIssueAssigneeMode, Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { workspaceRouter } from "@/server/routers/workspace";
import {
  createWorkspaceFixture,
  buildContext,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration tests for the admin-gated member management procedures on
 * workspaceRouter. These replaced the legacy `workspace.invite` flow once
 * Authelia became the source of truth for identity.
 *
 * Covers:
 *   - addMember (new + idempotent return for existing membership)
 *   - setMemberRole (change + no-op)
 *   - last-admin guards (demote and remove)
 *   - non-admin rejection via adminProcedure middleware
 *
 * Runs against the real Postgres + Redis containers per `~/forge/CLAUDE.md`.
 */

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function adminSetup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "MEM" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = workspaceRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("workspaceRouter — admin member management", () => {
  it("updates the agent-run stale watchdog threshold", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    await caller.update({ agentRunStaleMinutes: 45 });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: fixture.workspace.id },
      select: { agentRunStaleMinutes: true },
    });
    expect(workspace.agentRunStaleMinutes).toBe(45);
  });

  it("updates agent progress cadence and non-terminal quiet threshold", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    await caller.update({
      agentProgressUpdateMinutes: 8,
      agentRunQuietMinutes: 12,
    });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: fixture.workspace.id },
      select: {
        agentProgressUpdateMinutes: true,
        agentRunQuietMinutes: true,
      },
    });
    expect(workspace.agentProgressUpdateMinutes).toBe(8);
    expect(workspace.agentRunQuietMinutes).toBe(12);
  });

  it("updates the reviewer-start fallback window", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    await caller.update({ reviewStartTimeoutMinutes: 8 });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: fixture.workspace.id },
      select: { reviewStartTimeoutMinutes: true },
    });
    expect(workspace.reviewStartTimeoutMinutes).toBe(8);
  });

  it("updates and validates the workspace default issue assignee", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    await caller.update({
      defaultIssueAssigneeMode: DefaultIssueAssigneeMode.USER,
      defaultIssueAssigneeUserId: fixture.secondUser.id,
    });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: fixture.workspace.id },
      select: {
        defaultIssueAssigneeMode: true,
        defaultIssueAssigneeUserId: true,
      },
    });
    expect(workspace.defaultIssueAssigneeMode).toBe(DefaultIssueAssigneeMode.USER);
    expect(workspace.defaultIssueAssigneeUserId).toBe(fixture.secondUser.id);
  });

  it("listMembers returns all memberships including the caller", async () => {
    const { caller, fixture } = await adminSetup();
    const members = await caller.listMembers();
    expect(members).toHaveLength(2);
    const emails = members.map((m) => m.email).sort();
    expect(emails).toEqual([fixture.user.email, fixture.secondUser.email].sort());
    const roles = Object.fromEntries(members.map((m) => [m.email, m.role]));
    expect(roles[fixture.user.email]).toBe(Role.OWNER);
    expect(roles[fixture.secondUser.email]).toBe(Role.MEMBER);
    // lastActiveAt is null until we wire a tracker.
    expect(members.every((m) => m.lastActiveAt === null)).toBe(true);
  });

  it("addMember creates a new user + membership when email is unknown", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();
    const email = `new-${Date.now()}@example.com`;

    const res = await caller.addMember({ email, role: Role.MEMBER });
    expect(res.created).toBe(true);
    expect(res.email).toBe(email);
    expect(res.role).toBe(Role.MEMBER);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const membership = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: { userId: user!.id, workspaceId: fixture.workspace.id },
      },
    });
    expect(membership?.role).toBe(Role.MEMBER);

    // Audit + event rows written.
    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Membership",
        action: "create",
        entityId: membership!.id,
      },
    });
    expect(audit).toBeTruthy();
    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "MEMBERSHIP_CREATED",
        subjectId: membership!.id,
      },
    });
    expect(event).toBeTruthy();

    // Cleanup the orphan user we created (fixture only tracks its own two).
    await prisma.user.delete({ where: { id: user!.id } }).catch(() => {});
  });

  it("addMember is idempotent for an existing membership (returns existing, no role change)", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    // secondUser is seeded as MEMBER. Re-add with ADMIN — should NOT change role.
    const res = await caller.addMember({
      email: fixture.secondUser.email,
      role: Role.ADMIN,
    });
    expect(res.created).toBe(false);
    expect(res.role).toBe(Role.MEMBER);

    const still = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    expect(still?.role).toBe(Role.MEMBER);

    // No duplicate audit row for the no-op path.
    const audits = await prisma.auditLog.count({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Membership",
        action: "create",
      },
    });
    expect(audits).toBe(0);
  });

  it("addMember upserts by lowercased email (case-insensitive)", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    // Mixed-case input → bound to the existing lowercase row, no duplicate user.
    const res = await caller.addMember({
      email: fixture.secondUser.email.toUpperCase(),
      role: Role.MEMBER,
    });
    expect(res.created).toBe(false);
    expect(res.userId).toBe(fixture.secondUser.id);

    const count = await prisma.user.count({
      where: { email: fixture.secondUser.email.toLowerCase() },
    });
    expect(count).toBe(1);
  });

  it("setMemberRole changes the role and writes MEMBERSHIP_ROLE_CHANGED", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    const res = await caller.setMemberRole({
      userId: fixture.secondUser.id,
      role: Role.ADMIN,
    });
    expect(res.role).toBe(Role.ADMIN);

    const membership = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    expect(membership?.role).toBe(Role.ADMIN);

    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "MEMBERSHIP_ROLE_CHANGED",
      },
    });
    expect(event).toBeTruthy();
    expect(event?.payload).toMatchObject({ from: Role.MEMBER, to: Role.ADMIN });
  });

  it("setMemberRole is a no-op when role is unchanged (no audit)", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();
    await caller.setMemberRole({ userId: fixture.secondUser.id, role: Role.MEMBER });
    const events = await prisma.activityEvent.count({
      where: { workspaceId: fixture.workspace.id, kind: "MEMBERSHIP_ROLE_CHANGED" },
    });
    expect(events).toBe(0);
  });

  it("setMemberRole rejects demoting the last admin", async () => {
    const { caller, fixture } = await adminSetup();
    // OWNER is the only admin-tier member. Attempting to demote them fails.
    await expect(
      caller.setMemberRole({ userId: fixture.user.id, role: Role.MEMBER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("removeMember clears that user as the workspace default issue assignee", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();
    await caller.update({
      defaultIssueAssigneeMode: DefaultIssueAssigneeMode.USER,
      defaultIssueAssigneeUserId: fixture.secondUser.id,
    });

    await caller.removeMember({ userId: fixture.secondUser.id });

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: fixture.workspace.id },
      select: {
        defaultIssueAssigneeMode: true,
        defaultIssueAssigneeUserId: true,
      },
    });
    expect(workspace.defaultIssueAssigneeMode).toBe(DefaultIssueAssigneeMode.NONE);
    expect(workspace.defaultIssueAssigneeUserId).toBeNull();
  });

  it("setMemberRole allows self-demote when another admin exists", async () => {
    const { caller, fixture } = await adminSetup();
    // Promote secondUser first so the workspace has two admin-tier members.
    await caller.setMemberRole({ userId: fixture.secondUser.id, role: Role.ADMIN });
    const res = await caller.setMemberRole({
      userId: fixture.user.id,
      role: Role.MEMBER,
    });
    expect(res.role).toBe(Role.MEMBER);
  });

  it("setMemberRole forbids a non-owner admin from granting or touching OWNER", async () => {
    const { caller, fixture } = await adminSetup();
    // Promote secondUser to ADMIN, then act AS that (non-owner) admin.
    await caller.setMemberRole({ userId: fixture.secondUser.id, role: Role.ADMIN });
    const adminCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const adminCaller = workspaceRouter.createCaller(adminCtx);
    // Cannot self-promote to OWNER (the privilege-escalation → delete-tenant path).
    await expect(
      adminCaller.setMemberRole({ userId: fixture.secondUser.id, role: Role.OWNER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Cannot change the existing owner's role either.
    await expect(
      adminCaller.setMemberRole({ userId: fixture.user.id, role: Role.MEMBER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The escalation did not happen.
    const prisma = getPrisma();
    const still = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    expect(still?.role).toBe(Role.ADMIN);
  });

  it("setMemberRole lets an owner grant the OWNER role", async () => {
    const { caller, fixture } = await adminSetup();
    const res = await caller.setMemberRole({ userId: fixture.secondUser.id, role: Role.OWNER });
    expect(res.role).toBe(Role.OWNER);
  });

  it("removeMember deletes the membership and preserves the user row", async () => {
    const { caller, fixture } = await adminSetup();
    const prisma = getPrisma();

    const res = await caller.removeMember({ userId: fixture.secondUser.id });
    expect(res.removed).toBe(true);

    const membership = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    expect(membership).toBeNull();

    // User row itself is intact.
    const user = await prisma.user.findUnique({ where: { id: fixture.secondUser.id } });
    expect(user).toBeTruthy();

    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "MEMBERSHIP_REMOVED",
      },
    });
    expect(event).toBeTruthy();
  });

  it("removeMember rejects removing the last admin (including self)", async () => {
    const { caller, fixture } = await adminSetup();
    await expect(
      caller.removeMember({ userId: fixture.user.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("removeMember rejects NOT_FOUND when the user isn't a member", async () => {
    const { caller } = await adminSetup();
    const prisma = getPrisma();
    const ghost = await prisma.user.create({
      data: { email: `ghost-${Date.now()}@example.com` },
    });
    try {
      await expect(
        caller.removeMember({ userId: ghost.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await prisma.user.delete({ where: { id: ghost.id } }).catch(() => {});
    }
  });

  it("non-admin callers are rejected by adminProcedure", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "MEM" });
    fixtures.push(fixture);
    const memberCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const memberCaller = workspaceRouter.createCaller(memberCtx);

    await expect(memberCaller.listMembers()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      memberCaller.addMember({ email: "x@example.com", role: Role.MEMBER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      memberCaller.setMemberRole({ userId: fixture.user.id, role: Role.MEMBER }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      memberCaller.removeMember({ userId: fixture.user.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("invite stub throws PRECONDITION_FAILED (legacy guard)", async () => {
    const { caller } = await adminSetup();
    await expect(
      caller.invite({ email: "x@example.com", role: Role.MEMBER }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      caller.invite({ email: "x@example.com", role: Role.MEMBER }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
