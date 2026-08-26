import Link from "next/link";
import { UserActionTokenType } from "@prisma/client";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completePasswordResetAction } from "@/server/actions/local-auth";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { inspectUserActionToken } from "@/server/services/auth-tokens";

const INVALID_COPY = {
  INVALID: "This password-reset link is invalid.",
  EXPIRED: "This password-reset link has expired.",
  USED: "This password-reset link has already been used.",
} as const;

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ token }, { error }, policy] = await Promise.all([
    params,
    searchParams,
    getInstanceAuthPolicy(),
  ]);
  const inspection = await inspectUserActionToken({
    rawToken: token,
    type: UserActionTokenType.PASSWORD_RESET,
  });

  if (inspection.state !== "VALID") {
    return (
      <AuthCardShell
        eyebrow="Password recovery"
        title="Link unavailable."
        description={INVALID_COPY[inspection.state]}
        footer={
          <Link
            href="/signin?manual=1"
            className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to sign in
          </Link>
        }
      >
        <Link
          href="/forgot-password"
          className="focus-ring inline-flex h-9 items-center justify-center rounded-md bg-ember px-3.5 text-sm font-medium text-ember-foreground hover:bg-ember/90"
        >
          Request a new link
        </Link>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      eyebrow="Password recovery"
      title="Choose a new password."
      description={`Use at least ${policy.passwordMinLength} characters. This link works once.`}
      footer={
        <Link
          href="/signin?manual=1"
          className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel and return to sign in
        </Link>
      }
    >
      {error && (
        <div className="mb-4">
          <AuthMessage tone="danger">
            {error === "mismatch"
              ? "The passwords do not match."
              : error === "password"
                ? `Use at least ${policy.passwordMinLength} characters.`
                : "This reset could not be completed. Request a new link."}
          </AuthMessage>
        </div>
      )}
      <form action={completePasswordResetAction} className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            New password
          </span>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={policy.passwordMinLength}
            maxLength={512}
            required
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            Confirm password
          </span>
          <Input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={policy.passwordMinLength}
            maxLength={512}
            required
          />
        </label>
        <Button type="submit" variant="ember" size="lg" className="w-full">
          Save new password
        </Button>
      </form>
    </AuthCardShell>
  );
}
