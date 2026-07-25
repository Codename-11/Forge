import { redirect } from "next/navigation";
import { signIn } from "@/server/auth";
import { AuthError } from "next-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { LiveStatusPanel, LiveLoopCard } from "./live-status-panel";
import { listEnabledSsoProviders, type PublicSsoProvider } from "@/server/sso";
import { readPackageVersion } from "@/server/build-info";

/** Short mono badge shown in the provider button. */
function providerBadge(p: PublicSsoProvider): string {
  if (p.type === "GITHUB") return "GH";
  if (p.type === "GOOGLE") return "G";
  return p.name.slice(0, 2).toUpperCase();
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

/** Small mono-badge provider button matching the design's ProviderBtn. */
function ProviderButton({
  action,
  providerId,
  icon,
  label,
}: {
  action: (formData: FormData) => Promise<void>;
  providerId: string;
  icon: string;
  label: string;
}) {
  return (
    <form action={action} className="contents">
      <input type="hidden" name="providerId" value={providerId} />
      <button
        type="submit"
        className="focus-ring flex h-10 w-full items-center gap-2.5 rounded-md border border-border bg-background px-3.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-subtle"
      >
        <span className="grid h-[22px] w-[22px] place-items-center rounded-sm bg-subtle font-mono text-[0.6875rem] font-semibold">
          {icon}
        </span>
        <span>{label}</span>
      </button>
    </form>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const target = callbackUrl || "/dashboard";

  const providers = await listEnabledSsoProviders();
  const hasProviders = providers.length > 0;
  const host = instanceHost();
  const appVersion = await readPackageVersion();

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
        redirect(`/signin?error=${encodeURIComponent(err.type)}`);
      }
      throw err;
    }
  }

  async function oauthAction(formData: FormData) {
    "use server";
    const providerId = String(formData.get("providerId") ?? "");
    if (!providerId) return;
    await signIn(providerId, { redirectTo: target });
  }

  return (
    <main className="min-h-svh lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* LEFT: brand + live status (the marquee) */}
      <section className="forge-grid-bg relative flex flex-col border-border bg-card px-6 py-8 sm:px-10 lg:border-r lg:py-9">
        {/* brand */}
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
            keyboard · agents · cycles
          </div>
          <h1 className="max-w-md text-pretty text-[1.875rem] font-semibold leading-[1.1] tracking-[-0.02em]">
            Project management for humans and agents.
          </h1>
          <p className="mb-6 mt-2.5 max-w-sm text-pretty text-[0.8125rem] leading-relaxed text-muted-foreground">
            Linear-style primitives, a first-class MCP surface, and a workflow shape every run
            follows. Sign in to pick up where you left off.
          </p>

          {/* Full panel on desktop, compact card on mobile */}
          <div className="hidden lg:block">
            <LiveStatusPanel />
          </div>
          <LiveLoopCard className="max-w-sm lg:hidden" />
        </div>

        <div className="flex items-center justify-between pt-6 font-mono text-[0.6875rem] text-muted-foreground">
          <span>forge v{appVersion} · self-hosted</span>
          <span>{host}</span>
        </div>
      </section>

      {/* RIGHT: the form */}
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
              Use your email and password. You&apos;ll pick a workspace next.
            </p>

            <form action={credentialsAction} className="space-y-2.5">
              <label className="block">
                <span className="mb-1.5 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted-foreground">
                  Email
                </span>
                <Input
                  name="email"
                  type="email"
                  placeholder="you@instance.local"
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
                  <span
                    className="text-[0.6875rem] text-muted-foreground"
                    title="Self-hosted: password is managed by your instance admin."
                  >
                    Reset
                  </span>
                </span>
                <Input
                  name="password"
                  type="password"
                  placeholder="••••••••••"
                  autoComplete="current-password"
                  required
                  className="h-10"
                />
              </label>

              {error && (
                <p className="text-xs text-danger">
                  {error === "CredentialsSignin"
                    ? "Invalid email or password."
                    : "Sign-in failed. Try again."}
                </p>
              )}

              <label className="flex items-center gap-2.5 py-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  name="keepSignedIn"
                  defaultChecked
                  className="accent-ember"
                />
                <span>Keep me signed in on this device</span>
              </label>

              <Button type="submit" variant="ember" size="lg" className="w-full">
                Sign in <Kbd>↵</Kbd>
              </Button>
            </form>

            {hasProviders && (
              <>
                <div className="my-4 flex items-center gap-2.5 text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em]">
                    or use a provider
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>

                <div
                  className={`grid grid-cols-1 gap-2 ${providers.length > 1 ? "sm:grid-cols-2" : ""}`}
                >
                  {providers.map((p) => (
                    <ProviderButton
                      key={p.providerId}
                      action={oauthAction}
                      providerId={p.providerId}
                      icon={providerBadge(p)}
                      label={p.name}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="text-xs text-muted-foreground">Need an invite? Ask a workspace admin.</div>
      </section>
    </main>
  );
}
