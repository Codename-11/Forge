import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { AuthMessage } from "@/components/auth/auth-message";
import { AutoRedirectProvider, ProviderButton } from "@/components/auth/provider-form";
import { safeAuthCallbackUrl } from "@/lib/auth-callback";
import { signIn } from "@/server/auth";
import { readPackageVersion } from "@/server/build-info";
import { decryptSecret } from "@/server/crypto";
import { deriveAuthPresentation, getInstanceAuthPolicy } from "@/server/services/auth-policy";
import { getEnabledSsoRows, providerIdFor } from "@/server/sso";
import { LiveStatusPanel, LiveLoopCard } from "./live-status-panel";

function providerBadge(type: "OIDC" | "GITHUB" | "GOOGLE", name: string): string {
  if (type === "GITHUB") return "GH";
  if (type === "GOOGLE") return "G";
  return name.slice(0, 2).toUpperCase();
}

function instanceHost(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return "self-hosted instance";
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, "");
  }
}

function signInErrorMessage(error?: string): string | null {
  if (!error) return null;
  if (error === "CredentialsSignin") return "Invalid email or password.";
  if (error === "AccessDenied") return "This account cannot sign in to this Forge instance.";
  if (error === "OAuthAccountNotLinked") {
    return "That external identity is already linked elsewhere or cannot be linked automatically. Sign in with its existing Forge account, or ask an instance administrator to resolve the conflict.";
  }
  return "Sign-in failed. Choose a method and try again.";
}

function usableProvider<T extends { type: string; issuer?: string | null; clientSecret: string }>(
  provider: T,
): boolean {
  if (provider.type === "OIDC" && !provider.issuer) return false;
  try {
    decryptSecret(provider.clientSecret);
    return true;
  } catch {
    return false;
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string; manual?: string }>;
}) {
  const { error, callbackUrl, manual } = await searchParams;
  const target = safeAuthCallbackUrl(callbackUrl);
  const [rows, policy, appVersion] = await Promise.all([
    getEnabledSsoRows(),
    getInstanceAuthPolicy(),
    readPackageVersion(),
  ]);
  // Match the provider set Auth.js can actually construct. An enabled row
  // with a missing issuer or unreadable secret belongs in the admin health UI,
  // not on a sign-in button or automatic redirect.
  const usableRows = rows.filter(usableProvider);
  const presentation = deriveAuthPresentation(policy, usableRows);
  const providers = usableRows.map((row) => ({
    id: row.id,
    providerId: providerIdFor(row),
    name: row.name,
    type: row.type,
  }));
  const autoProvider = providers.find(
    (provider) => provider.id === presentation.autoRedirectProviderId,
  );
  // Invitations may require deliberate account choice. Errors and the manual
  // escape hatch must also stay on the chooser to prevent redirect loops.
  const suppressAutoRedirect = Boolean(error || manual === "1" || target.startsWith("/invite/"));
  const shouldAutoRedirect = Boolean(autoProvider && !suppressAutoRedirect);

  async function credentialsAction(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
        redirectTo: target,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect(
          `/signin?${new URLSearchParams({ error: err.type, callbackUrl: target, manual: "1" })}`,
        );
      }
      throw err;
    }
  }

  async function oauthAction(formData: FormData) {
    "use server";
    const providerId = String(formData.get("providerId") ?? "");
    if (!providerId) return;
    try {
      await signIn(providerId, { redirectTo: target });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect(
          `/signin?${new URLSearchParams({ error: err.type, callbackUrl: target, manual: "1" })}`,
        );
      }
      throw err;
    }
  }

  const authError = signInErrorMessage(error);
  return (
    <main className="min-h-svh lg:grid lg:grid-cols-[1.1fr_1fr]">
      <section className="forge-grid-bg relative flex flex-col border-border bg-card px-6 py-8 sm:px-10 lg:border-r lg:py-9">
        <div className="inline-flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/forge-app-icon-v2-ember.svg"
            alt=""
            width={24}
            height={24}
            className="rounded"
          />
          <span className="text-lg font-semibold tracking-[-0.01em]">Forge</span>
        </div>
        <div className="flex flex-1 flex-col justify-center pt-6 lg:pt-10">
          <div className="mb-3 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ember">
            keyboard · agents · sprints
          </div>
          <h1 className="max-w-md text-pretty text-[1.875rem] font-semibold leading-[1.1] tracking-[-0.02em]">
            Project management for humans and agents.
          </h1>
          <p className="mb-6 mt-2.5 max-w-sm text-pretty text-[0.8125rem] leading-relaxed text-muted-foreground">
            Linear-style primitives, a first-class MCP surface, and a workflow shape every run
            follows. Sign in to pick up where you left off.
          </p>
          <div className="hidden lg:block">
            <LiveStatusPanel />
          </div>
          <LiveLoopCard className="max-w-sm lg:hidden" />
        </div>
        <div className="flex items-center justify-between pt-6 font-mono text-[0.6875rem] text-muted-foreground">
          <span>forge v{appVersion} · self-hosted</span>
          <span>{instanceHost()}</span>
        </div>
      </section>

      <section className="flex flex-col bg-background px-6 py-8 sm:px-11 lg:py-9">
        <div className="flex items-center justify-end gap-2.5 font-mono text-[0.7rem] text-muted-foreground">
          <span className="forge-breath" />
          <span>all systems normal</span>
        </div>
        <div className="flex flex-1 flex-col justify-center">
          <div className="w-full max-w-sm">
            <div className="mb-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
              sign in
            </div>
            <h2 className="text-2xl font-semibold tracking-[-0.015em]">Welcome back.</h2>
            <p className="mb-6 mt-1.5 text-[0.8125rem] text-muted-foreground">
              {shouldAutoRedirect
                ? "Your instance uses a preferred identity provider."
                : "Choose a sign-in method enabled for this instance."}
            </p>
            {authError && (
              <div className="mb-4">
                <AuthMessage tone="danger">{authError}</AuthMessage>
              </div>
            )}

            {shouldAutoRedirect && autoProvider ? (
              <>
                <AutoRedirectProvider
                  action={oauthAction}
                  providerId={autoProvider.providerId}
                  providerName={autoProvider.name}
                />
                <Link
                  href={`/signin?callbackUrl=${encodeURIComponent(target)}&manual=1`}
                  className="focus-ring mt-4 inline-flex rounded text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                >
                  Use another sign-in method
                </Link>
              </>
            ) : (
              <div className="space-y-4">
                {presentation.localCredentialsEnabled && (
                  <form action={credentialsAction} className="space-y-2.5">
                    <label className="block">
                      <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
                        Email
                      </span>
                      <Input
                        name="email"
                        type="email"
                        placeholder="you@example.com"
                        autoComplete="email"
                        required
                        autoFocus
                        className="h-10"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 flex items-baseline justify-between">
                        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
                          Password
                        </span>
                        <Link
                          href="/forgot-password"
                          className="focus-ring rounded text-[0.6875rem] text-muted-foreground hover:text-foreground"
                        >
                          Forgot password?
                        </Link>
                      </span>
                      <Input
                        name="password"
                        type="password"
                        placeholder="••••••••••••"
                        autoComplete="current-password"
                        required
                        className="h-10"
                      />
                    </label>
                    <Button type="submit" variant="ember" size="lg" className="w-full">
                      Sign in <Kbd>↵</Kbd>
                    </Button>
                    {presentation.registrationMode === "OPEN" && (
                      <p className="text-center text-xs text-muted-foreground">
                        New here?{" "}
                        <Link
                          href="/signup"
                          className="text-foreground underline underline-offset-4"
                        >
                          Create a local account
                        </Link>
                      </p>
                    )}
                  </form>
                )}

                {presentation.localCredentialsEnabled && presentation.externalProvidersEnabled && (
                  <div className="flex items-center gap-2.5 text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em]">
                      or use a provider
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {presentation.externalProvidersEnabled && (
                  <div
                    className={`grid grid-cols-1 gap-2 ${providers.length > 1 ? "sm:grid-cols-2" : ""}`}
                  >
                    {providers.map((provider) => (
                      <ProviderButton
                        key={provider.id}
                        action={oauthAction}
                        providerId={provider.providerId}
                        icon={providerBadge(provider.type, provider.name)}
                        label={provider.name}
                      />
                    ))}
                  </div>
                )}
                {!presentation.localCredentialsEnabled &&
                  !presentation.externalProvidersEnabled && (
                    <AuthMessage tone="danger">
                      No external sign-in provider is currently available. Contact the instance
                      administrator.
                    </AuthMessage>
                  )}
                {presentation.breakGlassCredentialsEnabled && (
                  <Link
                    href={`/signin/local?callbackUrl=${encodeURIComponent(target)}&manual=1&breakGlass=1`}
                    className="focus-ring inline-flex rounded text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
                  >
                    Instance administrator recovery
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Need access? Ask a workspace or instance administrator.
        </div>
      </section>
    </main>
  );
}
