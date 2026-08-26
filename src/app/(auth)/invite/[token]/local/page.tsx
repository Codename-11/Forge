import Link from "next/link";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { registerLocalInvitationAction } from "@/server/actions/invitations";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { inspectWorkspaceInvitation } from "@/server/services/workspace-invitations";

export default async function LocalInvitationPage({
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
  const inspection = await inspectWorkspaceInvitation(token);
  const localAllowed = policy.mode !== "EXTERNAL_ONLY" && policy.registrationMode !== "DISABLED";
  const valid = inspection.state === "PENDING" && localAllowed;
  const minimum = policy.passwordMinLength;

  return (
    <AuthCardShell
      eyebrow="Workspace invitation"
      title={valid ? "Create your Forge account." : "Local account setup is unavailable."}
      description={
        valid
          ? `Join ${inspection.invitation.workspace.name} with a local email and password account.`
          : "Use an existing account or an identity method enabled by the instance administrator."
      }
      footer={
        <Link
          href={`/invite/${encodeURIComponent(token)}`}
          className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to invitation
        </Link>
      }
    >
      {!valid ? (
        <AuthMessage tone="info">
          This invitation may be invalid, expired, already used, or restricted to external sign-in.
        </AuthMessage>
      ) : (
        <form action={registerLocalInvitationAction} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          {error && (
            <AuthMessage tone="danger">
              {error === "mismatch"
                ? "The passwords do not match."
                : error === "password"
                  ? `Use a password with at least ${minimum} characters.`
                  : "This invitation can no longer create a local account."}
            </AuthMessage>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Name</span>
            <Input name="name" autoComplete="name" required autoFocus maxLength={80} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Email</span>
            <Input value={inspection.invitation.email} disabled className="font-mono" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Password</span>
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={minimum}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Confirm password</span>
            <Input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={minimum}
              required
            />
          </label>
          <Button type="submit" variant="ember" size="lg" className="w-full">
            Create account and join
          </Button>
          <p className="text-xs text-muted-foreground">
            At least {minimum} characters. The invitation is consumed only if account creation
            succeeds.
          </p>
        </form>
      )}
    </AuthCardShell>
  );
}
