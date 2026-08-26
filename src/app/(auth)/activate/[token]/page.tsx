import Link from "next/link";
import { UserActionTokenType } from "@prisma/client";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completeAccountSetupAction } from "@/server/actions/local-auth";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { inspectUserActionToken } from "@/server/services/auth-tokens";

const INVALID_COPY = {
  INVALID: "This account setup link is invalid.",
  EXPIRED: "This account setup link has expired. Ask an instance administrator to send a new one.",
  USED: "This account setup link has already been used. Sign in or reset your password instead.",
} as const;

export default async function ActivateAccountPage({
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
    type: UserActionTokenType.ACCOUNT_SETUP,
  });

  if (inspection.state !== "VALID") {
    return (
      <AuthCardShell
        eyebrow="Account setup"
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
        <AuthMessage tone="info">
          An instance administrator can resend setup for an invited account.
        </AuthMessage>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      eyebrow="Account setup"
      title="Finish your Forge account."
      description={`Create the local password for ${inspection.token.emailSnapshot}.`}
      footer={
        <span className="text-xs text-muted-foreground">This secure setup link works once.</span>
      }
    >
      {error && (
        <div className="mb-4">
          <AuthMessage tone="danger">
            {error === "mismatch"
              ? "The passwords do not match."
              : error === "password"
                ? `Use at least ${policy.passwordMinLength} characters.`
                : "Account setup could not be completed. Ask an administrator for a new link."}
          </AuthMessage>
        </div>
      )}
      <form action={completeAccountSetupAction} className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            Name
          </span>
          <Input
            name="name"
            type="text"
            autoComplete="name"
            defaultValue={inspection.token.user.email.split("@")[0]}
            maxLength={80}
            required
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            Password
          </span>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={policy.passwordMinLength}
            maxLength={512}
            required
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
          Activate account
        </Button>
      </form>
    </AuthCardShell>
  );
}
