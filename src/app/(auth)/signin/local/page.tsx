import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { AuthCardShell } from "@/components/auth/auth-card-shell";
import { AuthMessage } from "@/components/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeAuthCallbackUrl } from "@/lib/auth-callback";
import { signIn } from "@/server/auth";
import { deriveAuthPresentation, getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { getEnabledSsoRows } from "@/server/sso";

export default async function LocalSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string; notice?: string }>;
}) {
  const { error, callbackUrl, notice } = await searchParams;
  const target = safeAuthCallbackUrl(callbackUrl);
  const [policy, providers] = await Promise.all([getInstanceAuthPolicy(), getEnabledSsoRows()]);
  const presentation = deriveAuthPresentation(policy, providers);
  const allowed = presentation.localCredentialsEnabled || presentation.breakGlassCredentialsEnabled;

  async function credentialsAction(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
        breakGlass: formData.get("breakGlass") === "1" ? "1" : "0",
        redirectTo: target,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect(`/signin/local?${new URLSearchParams({ error: err.type, callbackUrl: target })}`);
      }
      throw err;
    }
  }

  if (!allowed) {
    return (
      <AuthCardShell
        eyebrow="Local sign-in"
        title="Local access is disabled."
        description="This Forge instance accepts external identity providers only."
        footer={
          <Link
            href={`/signin?callbackUrl=${encodeURIComponent(target)}&manual=1`}
            className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to sign in
          </Link>
        }
      >
        <AuthMessage tone="info">
          Contact an instance administrator if you need help recovering access.
        </AuthMessage>
      </AuthCardShell>
    );
  }

  const isBreakGlass = !presentation.localCredentialsEnabled;
  return (
    <AuthCardShell
      eyebrow={isBreakGlass ? "Administrator recovery" : "Local sign-in"}
      title={isBreakGlass ? "Use the protected local administrator." : "Sign in with a password."}
      description={
        isBreakGlass
          ? "This recovery path bypasses automatic provider redirection. Use it only when external identity is unavailable."
          : "Use the local credentials attached to your Forge account."
      }
      footer={
        <Link
          href={`/signin?callbackUrl=${encodeURIComponent(target)}&manual=1`}
          className="focus-ring rounded text-xs text-muted-foreground hover:text-foreground"
        >
          ← Use another sign-in method
        </Link>
      }
    >
      {error && (
        <div className="mb-4">
          <AuthMessage tone="danger">Invalid email or password.</AuthMessage>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <AuthMessage tone="success">
            {notice === "activated"
              ? "Your account is ready. Sign in with the password you just created."
              : "Your password was reset. Sign in with your new password."}
          </AuthMessage>
        </div>
      )}
      <form action={credentialsAction} className="space-y-3">
        <input type="hidden" name="breakGlass" value={isBreakGlass ? "1" : "0"} />
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            Email
          </span>
          <Input name="email" type="email" autoComplete="email" required autoFocus />
        </label>
        <label className="block">
          <span className="mb-1.5 flex items-center justify-between font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
            <span>Password</span>
            {!isBreakGlass && (
              <Link
                href="/forgot-password"
                className="font-sans normal-case tracking-normal hover:text-foreground"
              >
                Forgot password?
              </Link>
            )}
          </span>
          <Input name="password" type="password" autoComplete="current-password" required />
        </label>
        <Button type="submit" variant="ember" size="lg" className="w-full">
          Sign in
        </Button>
      </form>
    </AuthCardShell>
  );
}
