"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeAuthCallbackUrl } from "@/lib/auth-callback";
import { db } from "@/server/db";
import { rateLimit } from "@/server/rate-limit";
import {
  sendAccountSetupEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "@/server/services/email";
import {
  completeAccountSetup,
  completePasswordReset,
  createInvitedUser,
  requestPasswordReset,
} from "@/server/services/user-lifecycle";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";

async function requestContext() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip"),
    userAgent: h.get("user-agent"),
  };
}

function emailRateKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

function publicAppUrl(path: string): string {
  const origin = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.AUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
  return `${origin}${path}`;
}

/** Enumeration-safe: every input returns the same public result. */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const callbackUrl = safeAuthCallbackUrl(String(formData.get("callbackUrl") ?? ""));
  const context = await requestContext();

  try {
    const [byIp, byEmail] = await Promise.all([
      rateLimit(`password-reset:ip:${context.ipAddress ?? "unknown"}`, 20, 3600),
      rateLimit(`password-reset:email:${emailRateKey(email)}`, 5, 3600),
    ]);
    if (email && email.length <= 320 && byIp.ok && byEmail.ok) {
      const reset = await requestPasswordReset(db, { email, ...context });
      if (reset) {
        await sendPasswordResetEmail({
          to: reset.email,
          url: publicAppUrl(`/reset-password/${encodeURIComponent(reset.token)}`),
          expiresAt: reset.expiresAt,
        });
      }
    }
  } catch (error) {
    // Delivery and lookup failures are intentionally indistinguishable from an
    // unknown email on the public surface.
    console.error("[auth] password-reset request failed", error);
  }

  redirect(`/forgot-password?${new URLSearchParams({ sent: "1", callbackUrl })}`);
}

/** Open registration still verifies ownership through the emailed setup link. */
export async function requestOpenRegistrationAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const context = await requestContext();
  try {
    const policy = await getInstanceAuthPolicy();
    const [byIp, byEmail] = await Promise.all([
      rateLimit(`registration:ip:${context.ipAddress ?? "unknown"}`, 20, 3600),
      rateLimit(`registration:email:${emailRateKey(email)}`, 5, 3600),
    ]);
    if (
      policy.registrationMode === "OPEN" &&
      policy.mode !== "EXTERNAL_ONLY" &&
      email &&
      email.length <= 320 &&
      name &&
      name.length <= 80 &&
      byIp.ok &&
      byEmail.ok
    ) {
      const created = await createInvitedUser(db, {
        actorId: null,
        email,
        name,
        ...context,
      });
      await sendAccountSetupEmail({
        to: created.user.email,
        name: created.user.name,
        url: publicAppUrl(`/activate/${encodeURIComponent(created.setupToken)}`),
        expiresAt: created.expiresAt,
      });
    }
  } catch {
    // Deliberately indistinguishable from an existing or ineligible account.
  }
  redirect("/signup?sent=1");
}

function credentialFields(formData: FormData) {
  return {
    token: String(formData.get("token") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  };
}

export async function completePasswordResetAction(formData: FormData): Promise<void> {
  const input = credentialFields(formData);
  const path = `/reset-password/${encodeURIComponent(input.token)}`;
  if (input.password !== input.confirmPassword) redirect(`${path}?error=mismatch`);
  if (!input.token || input.token.length > 256) redirect(`${path}?error=link`);

  try {
    const context = await requestContext();
    const result = await completePasswordReset(db, {
      token: input.token,
      password: input.password,
      ...context,
    });
    const user = await db.user.findUnique({
      where: { id: result.userId },
      select: { email: true, name: true },
    });
    if (user) {
      await sendPasswordChangedEmail({
        to: user.email,
        name: user.name,
        changedAt: new Date(),
      }).catch((error) => console.error("[auth] password-changed notice failed", error));
    }
  } catch (error) {
    console.error("[auth] password reset failed", error);
    redirect(`${path}?error=password`);
  }

  redirect("/signin/local?manual=1&notice=password-reset");
}

export async function completeAccountSetupAction(formData: FormData): Promise<void> {
  const input = credentialFields(formData);
  const name = String(formData.get("name") ?? "").trim();
  const path = `/activate/${encodeURIComponent(input.token)}`;
  if (input.password !== input.confirmPassword) redirect(`${path}?error=mismatch`);
  if (!input.token || input.token.length > 256 || !name || name.length > 80) {
    redirect(`${path}?error=link`);
  }

  try {
    await completeAccountSetup(db, {
      token: input.token,
      password: input.password,
      name,
      ...(await requestContext()),
    });
  } catch (error) {
    console.error("[auth] account setup failed", error);
    redirect(`${path}?error=password`);
  }

  redirect("/signin/local?manual=1&notice=activated");
}
