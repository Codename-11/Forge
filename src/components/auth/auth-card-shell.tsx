import Link from "next/link";

export function AuthCardShell({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="forge-grid-bg flex min-h-svh items-center justify-center bg-card px-4 py-10">
      <section className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-sm sm:p-8">
        <Link href="/signin" className="focus-ring mb-7 inline-flex items-center gap-2.5 rounded">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/forge-app-icon-v2-ember.svg"
            alt=""
            width={26}
            height={26}
            className="rounded"
          />
          <span className="text-lg font-semibold">Forge</span>
        </Link>

        <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-ember">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>

        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 border-t border-border pt-4">{footer}</div>}
      </section>
    </main>
  );
}
