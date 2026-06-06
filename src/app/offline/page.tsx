import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Offline",
  description: "Forge could not reach the network.",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-10 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-border bg-card/40 p-6 shadow-sm">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/forge-app-icon-v2-ember.svg"
            alt=""
            width={40}
            height={40}
            className="rounded-md"
          />
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
              Forge
            </p>
            <h1 className="text-xl font-semibold tracking-[-0.01em]">You&apos;re offline.</h1>
          </div>
        </div>

        <p className="mt-5 text-sm leading-6 text-muted-foreground">
          Forge needs a network connection for live project data, agent runs, and workspace
          mutations. Reconnect and reload to resume your workspace.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href="/"
            className="focus-ring inline-flex h-9 items-center justify-center rounded-md bg-ember px-3.5 text-sm font-medium text-ember-foreground transition-colors hover:bg-ember/90"
          >
            Retry Forge
          </Link>
          <Link
            href="/signin"
            className="focus-ring inline-flex h-9 items-center justify-center rounded-md border border-border bg-transparent px-3.5 text-sm font-medium transition-colors hover:bg-subtle"
          >
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
