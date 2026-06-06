import "server-only";

import webpush, { type PushSubscription as WebPushSubscription } from "web-push";
import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "@/server/logger";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type BrowserPushPayload = {
  title: string;
  body?: string;
  url: string;
  tag?: string;
  notificationId?: string;
  icon?: string;
  badge?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
};

let configured = false;

export function getWebPushPublicKey(): string | null {
  return (
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY ??
    process.env.VAPID_PUBLIC_KEY ??
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
    null
  );
}

export function isWebPushConfigured(): boolean {
  return Boolean(getWebPushPublicKey() && getWebPushPrivateKey());
}

export async function upsertBrowserPushSubscription(
  db: DbClient,
  params: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  },
) {
  const now = new Date();
  return db.pushSubscription.upsert({
    where: { endpoint: params.endpoint },
    create: {
      userId: params.userId,
      endpoint: params.endpoint,
      p256dh: params.p256dh,
      auth: params.auth,
      userAgent: params.userAgent ?? null,
      lastSeenAt: now,
    },
    update: {
      userId: params.userId,
      p256dh: params.p256dh,
      auth: params.auth,
      userAgent: params.userAgent ?? null,
      lastSeenAt: now,
      revokedAt: null,
    },
  });
}

export async function revokeBrowserPushSubscription(
  db: DbClient,
  params: { userId: string; endpoint: string },
) {
  const result = await db.pushSubscription.updateMany({
    where: {
      userId: params.userId,
      endpoint: params.endpoint,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return { count: result.count };
}

export async function sendBrowserPushToUser(
  db: DbClient,
  userId: string,
  payload: BrowserPushPayload,
) {
  if (!configureWebPush()) return { sent: 0, revoked: 0 };

  const subscriptions = await db.pushSubscription.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return { sent: 0, revoked: 0 };

  let sent = 0;
  let revoked = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(sub), JSON.stringify(payload), {
          TTL: 60 * 60,
        });
        sent += 1;
      } catch (err) {
        const statusCode = readStatusCode(err);
        if (statusCode === 404 || statusCode === 410) {
          revoked += 1;
          await db.pushSubscription.update({
            where: { id: sub.id },
            data: { revokedAt: new Date() },
          });
          return;
        }
        logger.warn({ err, statusCode }, "web push delivery failed");
      }
    }),
  );

  return { sent, revoked };
}

function configureWebPush(): boolean {
  if (configured) return true;
  const publicKey = getWebPushPublicKey();
  const privateKey = getWebPushPrivateKey();
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(getWebPushSubject(), publicKey, privateKey);
  configured = true;
  return true;
}

function getWebPushPrivateKey(): string | null {
  return process.env.WEB_PUSH_VAPID_PRIVATE_KEY ?? process.env.VAPID_PRIVATE_KEY ?? null;
}

function getWebPushSubject(): string {
  const configuredSubject = process.env.WEB_PUSH_SUBJECT ?? process.env.VAPID_SUBJECT;
  if (configuredSubject) return configuredSubject;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      return new URL(appUrl).origin;
    } catch {
      // Fall through to a valid mailto subject.
    }
  }
  return "mailto:admin@localhost";
}

function toWebPushSubscription(sub: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): WebPushSubscription {
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.p256dh,
      auth: sub.auth,
    },
  };
}

function readStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const value = (err as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}
