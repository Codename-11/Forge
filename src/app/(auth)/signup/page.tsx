import Link from "next/link";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestOpenRegistrationAction } from "@/server/actions/local-auth";
import { getInstanceAuthPolicy } from "@/server/services/auth-policy";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const [{ sent }, policy] = await Promise.all([searchParams, getInstanceAuthPolicy()]);
  const enabled = policy.registrationMode === "OPEN" && policy.mode !== "EXTERNAL_ONLY";
  return (
    <AuthCardShell
      eyebrow="Local account"
      title={enabled ? "Create a Forge account." : "Open registration is disabled."}
      description={
        enabled
          ? "We’ll email a single-use verification link before you choose a password."
          : "Ask an administrator for an account or workspace invitation."
      }
      footer={
        <Link
          href="/signin?manual=1"
          className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to sign in
        </Link>
      }
    >
      {sent === "1" ? (
        <AuthMessage tone="success">
          If this email can register, a secure account-setup link has been sent.
        </AuthMessage>
      ) : enabled ? (
        <form action={requestOpenRegistrationAction} className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Name</span>
            <Input name="name" autoComplete="name" required maxLength={80} autoFocus />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium">Email</span>
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          <Button type="submit" variant="ember" size="lg" className="w-full">
            Email account setup link
          </Button>
        </form>
      ) : (
        <AuthMessage tone="info">
          Only invited or administrator-created accounts can join this instance.
        </AuthMessage>
      )}
    </AuthCardShell>
  );
}
