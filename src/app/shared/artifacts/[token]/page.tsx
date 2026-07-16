import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { MarkdownWithAttachments } from "@/components/markdown/attachment-renderer";
import { db } from "@/server/db";
import { findPublishedArtifactByToken } from "@/server/services/artifact-studio";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared artifact · Forge",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SharedArtifactPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = await rateLimit(`artifact-share:${ip}`, 60, 60);
  if (!limit.ok) notFound();
  const publication = await findPublishedArtifactByToken(db, token);
  if (!publication) notFound();
  const publicBody = publication.version.body
    .replace(
      /forge-attachment:([a-z0-9]{20,})/gi,
      (_match, attachmentId: string) =>
        `/shared/artifacts/${encodeURIComponent(token)}/assets/${attachmentId}`,
    )
    .replace(
      /^:::artifact\s+[a-z0-9]{20,}\s*\n(?:::\s*\n)?/gim,
      "> Linked workspace artifact omitted from this public version.\n",
    );

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-8">
      <article className="mx-auto max-w-4xl rounded-xl border border-border bg-card/40 p-5 shadow-sm sm:p-8">
        <header className="mb-8 border-b border-border pb-5">
          <div className="text-meta mb-2 uppercase tracking-wide text-muted-foreground">
            {publication.artifact.type.toLowerCase()} · v{publication.version.version}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{publication.version.title}</h1>
          {publication.version.summary ? (
            <p className="mt-2 text-sm text-muted-foreground">{publication.version.summary}</p>
          ) : null}
        </header>
        <MarkdownWithAttachments body={publicBody} />
        <footer className="text-meta mt-10 border-t border-border pt-4 text-muted-foreground">
          Shared from Forge · immutable version {publication.version.version}
          {publication.expiresAt ? ` · expires ${publication.expiresAt.toLocaleDateString()}` : ""}
        </footer>
      </article>
    </main>
  );
}
