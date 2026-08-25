import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma, UserActionToken, UserActionTokenType } from "@prisma/client";
import { db } from "@/server/db";

const TOKEN_BYTES = 32;
const TOKEN_HASH_DOMAIN = "forge:user-action:v1:";
const MAX_TOKEN_TTL_MINUTES = 30 * 24 * 60;

type ActionTokenDatabase = Pick<Prisma.TransactionClient, "userActionToken">;
type TransactionDatabase = Pick<typeof db, "$transaction">;

export function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Hash a raw bearer token with a purpose-specific domain separator. */
export function hashUserActionToken(rawToken: string): string {
  return createHash("sha256").update(TOKEN_HASH_DOMAIN).update(rawToken).digest("hex");
}

/** Generate the bearer value returned once and the digest persisted in DB. */
export function newUserActionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  return { rawToken, tokenHash: hashUserActionToken(rawToken) };
}

function expiresAfter(ttlMinutes: number, now: Date): Date {
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_TOKEN_TTL_MINUTES) {
    throw new Error("Action token expiry must be between 1 minute and 30 days.");
  }
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

export type IssueUserActionTokenInput = {
  userId: string;
  type: UserActionTokenType;
  emailSnapshot: string;
  ttlMinutes: number;
  now?: Date;
};

/**
 * Rotate outstanding tokens of the same type, then return the new raw token
 * once. Rotation and creation share a transaction when called with the root DB.
 */
export async function issueUserActionToken(
  input: IssueUserActionTokenInput,
  database: ActionTokenDatabase | typeof db = db,
): Promise<{ rawToken: string; token: UserActionToken }> {
  const now = input.now ?? new Date();
  const expiresAt = expiresAfter(input.ttlMinutes, now);
  const generated = newUserActionToken();

  const issue = async (tx: ActionTokenDatabase) => {
    await tx.userActionToken.updateMany({
      where: { userId: input.userId, type: input.type, usedAt: null },
      data: { usedAt: now },
    });
    return tx.userActionToken.create({
      data: {
        userId: input.userId,
        type: input.type,
        tokenHash: generated.tokenHash,
        emailSnapshot: normalizeAuthEmail(input.emailSnapshot),
        expiresAt,
        createdAt: now,
      },
    });
  };

  const token =
    "$transaction" in database
      ? await (database as typeof db).$transaction((tx) => issue(tx))
      : await issue(database as ActionTokenDatabase);
  return { rawToken: generated.rawToken, token };
}

const TOKEN_USER_SELECT = {
  id: true,
  email: true,
  normalizedEmail: true,
  status: true,
  authVersion: true,
} as const;

export type UserActionTokenInspection =
  | { state: "INVALID" | "EXPIRED" | "USED" }
  | {
      state: "VALID";
      token: UserActionToken & {
        user: {
          id: string;
          email: string;
          normalizedEmail: string | null;
          status: "INVITED" | "ACTIVE" | "SUSPENDED" | "DELETED";
          authVersion: number;
        };
      };
    };

/** Read-only token inspection for rendering setup/reset pages. */
export async function inspectUserActionToken(
  input: { rawToken: string; type: UserActionTokenType; now?: Date },
  database: ActionTokenDatabase = db,
): Promise<UserActionTokenInspection> {
  const token = await database.userActionToken.findUnique({
    where: { tokenHash: hashUserActionToken(input.rawToken) },
    include: { user: { select: TOKEN_USER_SELECT } },
  });
  if (!token || token.type !== input.type) return { state: "INVALID" };
  if (token.usedAt) return { state: "USED" };
  if (token.expiresAt <= (input.now ?? new Date())) return { state: "EXPIRED" };
  return { state: "VALID", token };
}

export type ConsumeUserActionTokenResult<T> =
  | { state: "INVALID" | "EXPIRED" | "USED" }
  | { state: "CONSUMED"; token: UserActionToken; value: T };

/**
 * Claim a token with a conditional write. An optional mutation runs inside the
 * same transaction, so password/account changes roll back together with the
 * claim when they fail.
 */
export async function consumeUserActionToken<T = undefined>(
  input: { rawToken: string; type: UserActionTokenType; now?: Date },
  onConsume?: (tx: Prisma.TransactionClient, token: UserActionToken) => Promise<T>,
  database: TransactionDatabase = db,
): Promise<ConsumeUserActionTokenResult<T | undefined>> {
  const now = input.now ?? new Date();
  const tokenHash = hashUserActionToken(input.rawToken);

  return database.$transaction(async (tx) => {
    const token = await tx.userActionToken.findUnique({ where: { tokenHash } });
    if (!token || token.type !== input.type) return { state: "INVALID" as const };
    if (token.usedAt) return { state: "USED" as const };
    if (token.expiresAt <= now) return { state: "EXPIRED" as const };

    const claimed = await tx.userActionToken.updateMany({
      where: {
        id: token.id,
        type: input.type,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return { state: "USED" as const };

    const consumed = { ...token, usedAt: now };
    const value = onConsume ? await onConsume(tx, consumed) : undefined;
    return { state: "CONSUMED" as const, token: consumed, value };
  });
}
