import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { EventKind, InvitationStatus, UserStatus, type Role } from "@prisma/client";
import { db } from "@/server/db";
import { recordChange } from "@/server/audit";
import { sendWorkspaceInviteEmail } from "@/server/services/email";
import { hashPassword } from "@/server/services/local-credentials";

export function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function invitationExpiry(hours: number, now = new Date()): Date {
  return new Date(now.getTime() + Math.max(1, hours) * 60 * 60 * 1000);
}

export function invitationPublicUrl(token: string): string {
  const origin = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000"
  )
    .trim()
    .replace(/\/+$/, "");
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

export async function expireWorkspaceInvitations(workspaceId?: string): Promise<void> {
  await db.workspaceInvitation.updateMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      status: InvitationStatus.PENDING,
      expiresAt: { lte: new Date() },
    },
    data: { status: InvitationStatus.EXPIRED },
  });
}

export type InvitationInspection =
  | {
      state: "PENDING";
      invitation: {
        id: string;
        email: string;
        role: Role;
        expiresAt: Date;
        workspace: { id: string; name: string; slug: string };
        invitedBy: { name: string | null; email: string };
      };
    }
  | { state: "ACCEPTED" | "REVOKED" | "EXPIRED"; workspaceName: string }
  | { state: "INVALID" };

export async function inspectWorkspaceInvitation(token: string): Promise<InvitationInspection> {
  const hash = invitationTokenHash(token);
  const invitation = await db.workspaceInvitation.findUnique({
    where: { tokenHash: hash },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
  if (!invitation) return { state: "INVALID" };
  if (invitation.status === InvitationStatus.PENDING && invitation.expiresAt <= new Date()) {
    await db.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        status: InvitationStatus.PENDING,
        tokenHash: hash,
        expiresAt: { lte: new Date() },
      },
      data: { status: InvitationStatus.EXPIRED },
    });
    return { state: "EXPIRED", workspaceName: invitation.workspace.name };
  }
  if (invitation.status !== InvitationStatus.PENDING) {
    return { state: invitation.status, workspaceName: invitation.workspace.name };
  }
  return {
    state: "PENDING",
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      workspace: invitation.workspace,
      invitedBy: invitation.invitedBy,
    },
  };
}

export type AcceptInvitationResult = {
  state:
    | "ACCEPTED"
    | "ALREADY_MEMBER"
    | "EXPIRED"
    | "REVOKED"
    | "ALREADY_ACCEPTED"
    | "INVALID"
    | "EMAIL_MISMATCH";
  workspaceSlug?: string;
  workspaceName?: string;
};

export async function acceptWorkspaceInvitation(params: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptInvitationResult> {
  const tokenHash = invitationTokenHash(params.token);
  return db.$transaction(async (tx) => {
    const invitation = await tx.workspaceInvitation.findUnique({
      where: { tokenHash },
      include: { workspace: { select: { name: true, slug: true } } },
    });
    if (!invitation) return { state: "INVALID" };
    const base = {
      workspaceSlug: invitation.workspace.slug,
      workspaceName: invitation.workspace.name,
    };
    if (invitation.status === InvitationStatus.ACCEPTED) {
      return { state: "ALREADY_ACCEPTED", ...base };
    }
    if (invitation.status === InvitationStatus.REVOKED) return { state: "REVOKED", ...base };
    if (invitation.status === InvitationStatus.EXPIRED || invitation.expiresAt <= new Date()) {
      await tx.workspaceInvitation.updateMany({
        where: { id: invitation.id, status: InvitationStatus.PENDING, tokenHash },
        data: { status: InvitationStatus.EXPIRED },
      });
      return { state: "EXPIRED", ...base };
    }
    if (params.userEmail.trim().toLowerCase() !== invitation.email) {
      return { state: "EMAIL_MISMATCH", ...base };
    }

    // Claim the exact token generation before granting access. This conditional
    // write is the revocation/resend race barrier: once an admin changes status
    // or rotates tokenHash, an in-flight old link cannot create membership.
    const claimed = await tx.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        status: InvitationStatus.PENDING,
        tokenHash,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: new Date(),
        acceptedById: params.userId,
        lastSendError: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await tx.workspaceInvitation.findUnique({
        where: { id: invitation.id },
        select: { status: true, tokenHash: true, expiresAt: true },
      });
      if (!current || current.tokenHash !== tokenHash) return { state: "INVALID", ...base };
      if (current.status === InvitationStatus.REVOKED) return { state: "REVOKED", ...base };
      if (current.status === InvitationStatus.ACCEPTED)
        return { state: "ALREADY_ACCEPTED", ...base };
      return { state: "EXPIRED", ...base };
    }

    const existing = await tx.membership.findUnique({
      where: {
        userId_workspaceId: { userId: params.userId, workspaceId: invitation.workspaceId },
      },
    });
    const membership = await tx.membership.upsert({
      where: {
        userId_workspaceId: { userId: params.userId, workspaceId: invitation.workspaceId },
      },
      create: {
        userId: params.userId,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      },
      update: {},
    });

    if (!existing) {
      await recordChange(tx, {
        workspaceId: invitation.workspaceId,
        actorId: params.userId,
        entity: "Membership",
        entityId: membership.id,
        action: "create",
        after: { userId: params.userId, role: membership.role, email: invitation.email },
        eventKind: EventKind.MEMBERSHIP_CREATED,
        subjectType: "membership",
        subjectId: membership.id,
        payload: { userId: params.userId, email: invitation.email, role: membership.role },
      });
    }
    await recordChange(tx, {
      workspaceId: invitation.workspaceId,
      actorId: params.userId,
      entity: "WorkspaceInvitation",
      entityId: invitation.id,
      action: "accept",
      after: { email: invitation.email, role: invitation.role },
      eventKind: EventKind.INVITATION_ACCEPTED,
      subjectType: "invitation",
      subjectId: invitation.id,
      payload: {
        email: invitation.email,
        role: invitation.role,
        existingMember: Boolean(existing),
      },
    });
    return { state: existing ? "ALREADY_MEMBER" : "ACCEPTED", ...base };
  });
}

export type LocalInvitationRegistrationResult =
  | { state: "CREATED"; userId: string; workspaceSlug: string; workspaceName: string }
  | {
      state:
        | "INVALID"
        | "EXPIRED"
        | "REVOKED"
        | "ALREADY_ACCEPTED"
        | "EXISTING_ACCOUNT"
        | "LOCAL_DISABLED";
      workspaceSlug?: string;
      workspaceName?: string;
    };

/**
 * Turn an exact pending workspace invitation into a new local Forge account
 * and membership atomically. Possession of an invite never adds a password to
 * an existing User; that principal must authenticate and manage its own login
 * methods instead.
 */
export async function registerLocalAccountFromInvitation(params: {
  token: string;
  name: string;
  password: string;
}): Promise<LocalInvitationRegistrationResult> {
  const policy = await db.instanceAuthPolicy.findUnique({ where: { id: "default" } });
  if (policy?.mode === "EXTERNAL_ONLY" || policy?.registrationMode === "DISABLED") {
    return { state: "LOCAL_DISABLED" };
  }
  const minimum = policy?.passwordMinLength ?? 12;
  if (params.password.length < minimum) {
    throw new Error(`Password must be at least ${minimum} characters.`);
  }
  const passwordHash = await hashPassword(params.password);
  const tokenHash = invitationTokenHash(params.token);

  return db.$transaction(async (tx) => {
    const invitation = await tx.workspaceInvitation.findUnique({
      where: { tokenHash },
      include: { workspace: { select: { name: true, slug: true } } },
    });
    if (!invitation) return { state: "INVALID" } as const;
    const base = {
      workspaceSlug: invitation.workspace.slug,
      workspaceName: invitation.workspace.name,
    };
    if (invitation.status === InvitationStatus.ACCEPTED) {
      return { state: "ALREADY_ACCEPTED", ...base } as const;
    }
    if (invitation.status === InvitationStatus.REVOKED) {
      return { state: "REVOKED", ...base } as const;
    }
    if (invitation.status === InvitationStatus.EXPIRED || invitation.expiresAt <= new Date()) {
      await tx.workspaceInvitation.updateMany({
        where: { id: invitation.id, status: InvitationStatus.PENDING, tokenHash },
        data: { status: InvitationStatus.EXPIRED },
      });
      return { state: "EXPIRED", ...base } as const;
    }

    const email = invitation.email.trim().toLowerCase();
    const existing = await tx.user.findFirst({
      where: {
        OR: [{ normalizedEmail: email }, { email: { equals: email, mode: "insensitive" } }],
      },
      select: { id: true },
    });
    if (existing) return { state: "EXISTING_ACCOUNT", ...base } as const;

    const claimed = await tx.workspaceInvitation.updateMany({
      where: {
        id: invitation.id,
        status: InvitationStatus.PENDING,
        tokenHash,
        expiresAt: { gt: new Date() },
      },
      data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date(), lastSendError: null },
    });
    if (claimed.count !== 1) return { state: "INVALID", ...base } as const;

    const user = await tx.user.create({
      data: {
        email,
        normalizedEmail: email,
        emailVerified: new Date(),
        name: params.name.trim(),
        status: UserStatus.ACTIVE,
        localCredential: { create: { passwordHash } },
        memberships: {
          create: { workspaceId: invitation.workspaceId, role: invitation.role },
        },
      },
      select: {
        id: true,
        memberships: {
          where: { workspaceId: invitation.workspaceId },
          select: { id: true },
          take: 1,
        },
      },
    });
    await tx.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { acceptedById: user.id },
    });
    const membershipId = user.memberships[0]?.id;
    if (membershipId) {
      await recordChange(tx, {
        workspaceId: invitation.workspaceId,
        actorId: user.id,
        entity: "Membership",
        entityId: membershipId,
        action: "create",
        after: { userId: user.id, role: invitation.role, email },
        eventKind: EventKind.MEMBERSHIP_CREATED,
        subjectType: "membership",
        subjectId: membershipId,
        payload: { userId: user.id, email, role: invitation.role },
      });
    }
    await recordChange(tx, {
      workspaceId: invitation.workspaceId,
      actorId: user.id,
      entity: "WorkspaceInvitation",
      entityId: invitation.id,
      action: "accept-local-registration",
      after: { email, role: invitation.role },
      eventKind: EventKind.INVITATION_ACCEPTED,
      subjectType: "invitation",
      subjectId: invitation.id,
      payload: { email, role: invitation.role, localRegistration: true },
    });
    return { state: "CREATED", userId: user.id, ...base } as const;
  });
}

export async function deliverWorkspaceInvitation(input: {
  invitationId: string;
  token: string;
  expiresAt?: Date;
  trackDelivery?: boolean;
}): Promise<string> {
  const invitation = await db.workspaceInvitation.findUniqueOrThrow({
    where: { id: input.invitationId },
    include: {
      workspace: { select: { name: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
  try {
    const messageId = await sendWorkspaceInviteEmail({
      to: invitation.email,
      inviteUrl: invitationPublicUrl(input.token),
      workspaceName: invitation.workspace.name,
      inviterName: invitation.invitedBy.name ?? invitation.invitedBy.email,
      expiresAt: input.expiresAt ?? invitation.expiresAt,
      note: invitation.note,
    });
    if (input.trackDelivery !== false) {
      await db.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { lastSentAt: new Date(), sendCount: { increment: 1 }, lastSendError: null },
      });
    }
    return messageId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed.";
    if (input.trackDelivery !== false) {
      await db.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { lastSendError: message.slice(0, 2000) },
      });
    }
    throw error;
  }
}
