import Link from "next/link";
import { auth, signOut } from "@/server/auth";
import { acceptInvitationAction } from "@/server/actions/invitations";
import { inspectWorkspaceInvitation } from "@/server/services/workspace-invitations";

const STATE_COPY = {
  INVALID: {
    title: "Invitation not found",
    body: "This invitation link is invalid. Ask a workspace admin to send a new invitation.",
  },
  EXPIRED: {
    title: "Invitation expired",
    body: "This secure link has expired. Ask a workspace admin to resend the invitation.",
  },
  REVOKED: {
    title: "Invitation revoked",
    body: "A workspace admin revoked this invitation. Contact them if you still need access.",
  },
  ACCEPTED: {
    title: "Invitation already accepted",
    body: "This invitation has already been used. Sign in to continue to your workspace.",
  },
} as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="forge-grid-bg flex min-h-svh items-center justify-center bg-card px-4 py-10">
      <section className="w-full max-w-lg rounded-xl border border-border bg-background p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/forge-app-icon-v2-ember.svg" alt="" width={26} height={26} className="rounded" />
          <span className="text-lg font-semibold">Forge</span>
        </div>
        {children}
      </section>
    </main>
  );
}

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { token } = await params;
  const [inspection, session] = await Promise.all([inspectWorkspaceInvitation(token), auth()]);

  if (inspection.state !== "PENDING") {
    const copy = STATE_COPY[inspection.state];
    return (
      <Shell>
        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ember">Workspace invitation</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
        <Link href="/signin" className="focus-ring mt-6 inline-flex h-9 items-center justify-center rounded-md bg-ember px-3.5 text-sm font-medium text-ember-foreground hover:bg-ember/90">
          Sign in to Forge
        </Link>
      </Shell>
    );
  }

  const { invitation } = inspection;
  const signedInEmail = session?.user?.email?.toLowerCase();
  const emailMismatch = Boolean(signedInEmail && signedInEmail !== invitation.email);
  const callbackUrl = `/invite/${token}`;
  async function switchAccount() {
    "use server";
    await signOut({ redirectTo: `/signin?callbackUrl=${encodeURIComponent(callbackUrl)}` });
  }

  return (
    <Shell>
      <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ember">Workspace invitation</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Join {invitation.workspace.name}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {invitation.invitedBy.name ?? invitation.invitedBy.email} invited <span className="font-mono text-foreground">{invitation.email}</span> as {invitation.role.toLowerCase()}.
      </p>
      <div className="mt-5 rounded-md border border-border bg-card/40 p-4 text-sm text-muted-foreground">
        This link expires {invitation.expiresAt.toLocaleString()}. Existing users can sign in; new users can continue through a configured identity provider to create their Forge account.
      </div>

      {!session?.user ? (
        <div className="mt-6 space-y-3">
          <Link
            href={`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ember px-5 text-sm font-medium text-ember-foreground hover:bg-ember/90"
          >
            Sign in or create account
          </Link>
          <p className="text-center text-xs text-muted-foreground">You’ll return here to confirm workspace access.</p>
        </div>
      ) : emailMismatch ? (
        <div className="mt-6 rounded-md border border-danger/40 bg-danger/10 p-4">
          <h2 className="text-sm font-medium text-foreground">Use the invited account</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            You are signed in as {session.user.email}, but this invitation belongs to {invitation.email}. Sign out, then continue with the invited email.
          </p>
          <form action={switchAccount}>
            <button type="submit" className="focus-ring mt-3 inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3.5 text-sm font-medium text-foreground hover:bg-subtle">
              Switch account
            </button>
          </form>
        </div>
      ) : (
        <form action={acceptInvitationAction} className="mt-6">
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="focus-ring inline-flex h-10 w-full items-center justify-center rounded-md bg-ember px-5 text-sm font-medium text-ember-foreground hover:bg-ember/90">
            Accept and join workspace
          </button>
          <p className="mt-3 text-center text-xs text-muted-foreground">Signed in as {session.user.email}</p>
        </form>
      )}
    </Shell>
  );
}
