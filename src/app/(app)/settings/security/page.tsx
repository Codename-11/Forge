"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Link2, LockKeyhole, LogOut, ShieldCheck, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CenterModal, useConfirm } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";
import { linkIdentityAction } from "@/server/actions/identity-linking";

function providerLabel(
  provider: string,
  providers: { id: string; type: string; name: string }[],
): string {
  return (
    providers.find(
      (candidate) =>
        candidate.id === provider || candidate.type.toLowerCase() === provider.toLowerCase(),
    )?.name ?? provider
  );
}

function displayDate(value: string | Date | null | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export default function SecuritySettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const security = trpc.user.security.useQuery();
  const { confirm, confirmElement } = useConfirm();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removePassword, setRemovePassword] = useState("");

  function signedOut(message: string) {
    toast.success(message);
    window.location.assign("/signin?manual=1");
  }

  const setPassword = trpc.user.setPassword.useMutation({
    onSuccess: () => signedOut("Password saved. Sign in again to continue."),
    onError: (error) => toast.error(error.message),
  });
  const removeLocalPassword = trpc.user.removePassword.useMutation({
    onSuccess: () => signedOut("Password removed. Sign in with a linked identity."),
    onError: (error) => toast.error(error.message),
  });
  const unlinkIdentity = trpc.user.unlinkIdentity.useMutation({
    onSuccess: () => signedOut("Login identity unlinked. Sign in again to continue."),
    onError: (error) => toast.error(error.message),
  });
  const revokeSessions = trpc.user.revokeSessions.useMutation({
    onSuccess: () => signedOut("Other sessions revoked. Sign in again to continue."),
    onError: (error) => toast.error(error.message),
  });

  const data = security.data;
  const hasPassword = Boolean(data?.user.localCredential);
  const accounts = data?.user.accounts ?? [];
  const linkedProviders = new Set(accounts.map((account) => account.provider.toLowerCase()));
  const linkableProviders =
    data?.policy.mode === "LOCAL_ONLY"
      ? []
      : (data?.providers ?? []).filter(
          (provider) =>
            !linkedProviders.has(provider.id.toLowerCase()) &&
            !linkedProviders.has(provider.type.toLowerCase()),
        );
  const minimum = data?.policy.passwordMinLength ?? 12;

  useEffect(() => {
    if (searchParams.get("linked") === "1") {
      toast.success("Login method linked.");
      router.replace("/settings/security");
    } else if (searchParams.get("error") === "provider-unavailable") {
      toast.error("That login provider is no longer available.");
      router.replace("/settings/security");
    }
  }, [router, searchParams]);

  function savePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("The new passwords do not match.");
      return;
    }
    setPassword.mutate({
      ...(hasPassword ? { currentPassword } : {}),
      newPassword,
    });
  }

  if (security.isLoading) {
    return (
      <>
        <Topbar
          title="Security & sign-in"
          subtitle="Manage the methods that prove your identity to Forge."
        />
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </>
    );
  }

  if (security.error) {
    return (
      <>
        <Topbar
          title="Security & sign-in"
          subtitle="Manage the methods that prove your identity to Forge."
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            as="div"
            icon={ShieldCheck}
            title="Security settings unavailable"
            hint={security.error.message}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Security & sign-in"
        subtitle="Manage the methods that prove your identity to Forge."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
          <div className="flex items-start gap-3 rounded-md border border-border bg-card/40 p-3 text-xs">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
            <p className="text-muted-foreground">
              Login methods identify you. They do not grant access to GitHub repositories or other
              external systems. Manage those separately under{" "}
              <Link
                href="/settings/connections"
                className="text-foreground underline underline-offset-4"
              >
                Integration accounts
              </Link>
              .
            </p>
          </div>

          <Section
            title="Local password"
            hint={
              hasPassword
                ? `Last changed ${displayDate(data?.user.localCredential?.passwordChangedAt)}. Saving signs out existing sessions.`
                : "Add a local password to use this account without an external identity provider."
            }
            actions={
              <Badge
                className={hasPassword ? "bg-success/10 text-success" : "text-muted-foreground"}
              >
                {hasPassword ? "active" : "not set"}
              </Badge>
            }
          >
            <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
              {hasPassword && (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Current password</span>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </label>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">
                    {hasPassword ? "New password" : "Password"}
                  </span>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    minLength={minimum}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Confirm password</span>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    minLength={minimum}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  At least {minimum} characters.
                </span>
                <div className="flex gap-2">
                  {hasPassword && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        data?.policy.mode === "LOCAL_ONLY" ||
                        accounts.length === 0 ||
                        removeLocalPassword.isPending
                      }
                      onClick={() => setRemoveOpen(true)}
                    >
                      Remove password
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ember"
                    disabled={
                      setPassword.isPending ||
                      newPassword.length < minimum ||
                      !confirmPassword ||
                      (hasPassword && !currentPassword)
                    }
                    onClick={savePassword}
                  >
                    <LockKeyhole className="h-3.5 w-3.5" />
                    {setPassword.isPending
                      ? "Saving…"
                      : hasPassword
                        ? "Change password"
                        : "Add password"}
                  </Button>
                </div>
              </div>
              {data?.policy.mode === "LOCAL_ONLY" && hasPassword && (
                <p className="text-xs text-muted-foreground">
                  Password removal is unavailable while the instance uses local-only authentication.
                </p>
              )}
              {data?.policy.mode !== "LOCAL_ONLY" && hasPassword && accounts.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Link an external login method before removing your only sign-in method.
                </p>
              )}
            </div>
          </Section>

          <Section
            title="Linked login methods"
            hint="External identities attached to this same Forge account. Removing one never deletes a separate integration connection."
            actions={
              <span className="text-meta text-muted-foreground">{accounts.length} linked</span>
            }
          >
            {accounts.length === 0 ? (
              <EmptyState
                as="div"
                icon={Link2}
                title="No external login methods"
                hint="This account currently signs in with its local password only."
              />
            ) : (
              <Card>
                {accounts.map((account) => (
                  <li key={account.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-subtle font-mono text-[0.6875rem] font-semibold uppercase">
                      {providerLabel(account.provider, data?.providers ?? []).slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {providerLabel(account.provider, data?.providers ?? [])}
                      </div>
                      <div className="text-meta truncate font-mono text-muted-foreground">
                        {account.providerAccountId}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={unlinkIdentity.isPending || (!hasPassword && accounts.length === 1)}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Unlink ${providerLabel(account.provider, data?.providers ?? [])}?`,
                            description:
                              "This removes only the login method. Integration accounts remain intact, and existing Forge sessions will be signed out.",
                            primaryLabel: "Unlink",
                            variant: "destructive",
                          })
                        ) {
                          unlinkIdentity.mutate({ accountId: account.id });
                        }
                      }}
                    >
                      <Unlink className="h-3.5 w-3.5" /> Unlink
                    </Button>
                  </li>
                ))}
              </Card>
            )}
            {!hasPassword && accounts.length === 1 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Add a password or another external identity before removing your final sign-in
                method.
              </p>
            )}
            {linkableProviders.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {linkableProviders.map((provider) => {
                  const providerId =
                    provider.type === "OIDC" ? provider.id : provider.type.toLowerCase();
                  return (
                    <form key={provider.id} action={linkIdentityAction}>
                      <input type="hidden" name="providerId" value={providerId} />
                      <Button type="submit" size="sm" variant="outline">
                        <Link2 className="h-3.5 w-3.5" /> Link {provider.name}
                      </Button>
                    </form>
                  );
                })}
              </div>
            )}
          </Section>

          <Section
            title="Sessions"
            hint="Security changes revoke existing sessions. You can also sign out every device manually."
          >
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/40 p-4">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Account sessions</div>
                <div className="text-xs text-muted-foreground">
                  Last sign-in: {displayDate(data?.user.lastLoginAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={revokeSessions.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Sign out every session?",
                      description:
                        "Every device, including this browser, will need to sign in again.",
                      primaryLabel: "Sign out all",
                      variant: "destructive",
                    })
                  )
                    revokeSessions.mutate();
                }}
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out all
              </Button>
            </div>
          </Section>
        </div>
      </div>

      <CenterModal
        open={removeOpen}
        onOpenChange={(open) => {
          setRemoveOpen(open);
          if (!open) setRemovePassword("");
        }}
        title="Remove local password?"
        description="You will need a linked external identity to sign in. Existing sessions will be signed out."
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={removeLocalPassword.isPending}
              onClick={() => setRemoveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!removePassword || removeLocalPassword.isPending}
              onClick={() => removeLocalPassword.mutate({ currentPassword: removePassword })}
            >
              {removeLocalPassword.isPending ? "Removing…" : "Remove password"}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium">Current password</span>
          <Input
            type="password"
            autoComplete="current-password"
            value={removePassword}
            onChange={(event) => setRemovePassword(event.target.value)}
            autoFocus
          />
        </label>
      </CenterModal>
      {confirmElement}
    </>
  );
}
