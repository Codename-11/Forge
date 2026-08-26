import Link from "next/link";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeAuthCallbackUrl } from "@/lib/auth-callback";
import { requestPasswordResetAction } from "@/server/actions/local-auth";
import { deriveAuthPresentation, getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { getEnabledSsoRows } from "@/server/sso";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; callbackUrl?: string }>;
}) {
  const { sent, callbackUrl } = await searchParams;
  const target = safeAuthCallbackUrl(callbackUrl);
  const [policy, providers] = await Promise.all([getInstanceAuthPolicy(), getEnabledSsoRows()]);
  const presentation = deriveAuthPresentation(policy, providers);
  const signInHref = `/signin?callbackUrl=${encodeURIComponent(target)}&manual=1`;

  return (
    <AuthCardShell
      eyebrow="Password recovery"
      title="Reset your password."
      description="Enter the email attached to your Forge account."
      footer={
        <Link
          href={signInHref}
          className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to sign in
        </Link>
      }
    >
      {sent === "1" ? (
        <AuthMessage tone="success">
          If an eligible local account exists for that email, a password-reset link has been sent.
          Check your inbox and spam folder.
        </AuthMessage>
      ) : presentation.localCredentialsEnabled ? (
        <form action={requestPasswordResetAction} className="space-y-4">
          <input type="hidden" name="callbackUrl" value={target} />
          <label className="block">
            <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
              Email
            </span>
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              placeholder="you@example.com"
            />
          </label>
          <Button type="submit" variant="ember" size="lg" className="w-full">
            Send reset link
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            For privacy, Forge shows the same result whether or not the address has a local
            password.
          </p>
        </form>
      ) : (
        <AuthMessage tone="info">
          Local password sign-in is disabled on this instance. Return to sign in and use an external
          identity provider.
        </AuthMessage>
      )}
    </AuthCardShell>
  );
}
