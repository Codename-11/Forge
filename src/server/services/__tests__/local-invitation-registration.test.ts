import { InvitationStatus, Role } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { verifyPassword } from "@/server/services/local-credentials";
import {
  invitationTokenHash,
  newInvitationToken,
  registerLocalAccountFromInvitation,
} from "@/server/services/workspace-invitations";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => disconnectPrisma());

async function invitation(email: string) {
  const fixture = await createWorkspaceFixture({ keyPrefix: "LI" });
  fixtures.push(fixture);
  const token = newInvitationToken();
  const row = await getPrisma().workspaceInvitation.create({
    data: {
      workspaceId: fixture.workspace.id,
      email,
      role: Role.MEMBER,
      tokenHash: invitationTokenHash(token),
      invitedById: fixture.user.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { fixture, token, row };
}

describe("local account registration from workspace invitations", () => {
  it("creates one canonical user, password, membership, and consumes the invite atomically", async () => {
    const email = `local-invite-${Date.now()}@example.com`;
    const { fixture, token, row } = await invitation(email);
    const password = "workspace invitation local password";

    await expect(
      registerLocalAccountFromInvitation({ token, name: "Local Invite", password }),
    ).resolves.toMatchObject({ state: "CREATED", workspaceSlug: fixture.workspace.slug });

    const user = await getPrisma().user.findUniqueOrThrow({
      where: { normalizedEmail: email },
      include: { localCredential: true, memberships: true },
    });
    expect(user.emailVerified).toBeTruthy();
    expect(user.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: fixture.workspace.id, role: Role.MEMBER }),
      ]),
    );
    await expect(verifyPassword(password, user.localCredential!.passwordHash)).resolves.toBe(true);
    await expect(
      getPrisma().workspaceInvitation.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ status: InvitationStatus.ACCEPTED, acceptedById: user.id });
  });

  it("does not add a password or consume an invitation for an existing account", async () => {
    const { fixture, token, row } = await invitation(fixtureEmail());
    const existing = await getPrisma().user.update({
      where: { id: fixture.secondUser.id },
      data: { normalizedEmail: fixture.secondUser.email.toLowerCase() },
    });
    await getPrisma().workspaceInvitation.update({
      where: { id: row.id },
      data: { email: existing.email.toLowerCase() },
    });

    await expect(
      registerLocalAccountFromInvitation({
        token,
        name: "Collision",
        password: "should never become a credential",
      }),
    ).resolves.toMatchObject({ state: "EXISTING_ACCOUNT" });
    await expect(
      getPrisma().localCredential.findUnique({ where: { userId: existing.id } }),
    ).resolves.toBeNull();
    await expect(
      getPrisma().workspaceInvitation.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ status: InvitationStatus.PENDING, acceptedById: null });
  });
});

function fixtureEmail(): string {
  return `placeholder-${Date.now()}@example.com`;
}
