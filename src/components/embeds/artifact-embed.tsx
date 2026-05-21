"use client";

import { lazy, Suspense, useId, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Code2,
  ExternalLink,
  FileText,
  ImageIcon,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

// Lazy import the renderer to break the cycle:
//   attachment-renderer.tsx → ArtifactEmbed → MarkdownWithAttachments
// `lazy()` resolves the module out-of-band so module-init order is
// safe; once loaded it resolves synchronously from cache.
const MarkdownWithAttachments = lazy(() =>
  import("@/components/markdown/attachment-renderer").then((m) => ({
    default: m.MarkdownWithAttachments,
  })),
);

/**
 * Inline artifact embed. Triggered by either:
 *   - The `:::artifact <id>` block directive
 *   - The `[embed](forge-artifact:<id>)` link form
 *
 * Renders the artifact's content based on its `renderKind`:
 *   - "markdown" → scrollable max-h preview of the body
 *   - "image"    → the embedded image (resolved by the inner ![] token)
 *   - "code"     → preformatted code block with a copy button
 *   - "file"     → chip fallback (router never returns this v1; kept for
 *                  forward-compat with future binary artifacts)
 *
 * Uses the shared `MarkdownWithAttachments` renderer for the markdown
 * branch — same primitives the comment already supports, scoped inside
 * a tight card so the embed reads as "a quoted artifact" rather than
 * "wall of text from another doc".
 */
export function ArtifactEmbed({ artifactId }: { artifactId: string }) {
  const ws = useMaybeWorkspace();
  const enabled = !!ws && /^[a-z0-9]{20,}$/i.test(artifactId);
  const q = trpc.artifact.getForRender.useQuery(
    { id: artifactId },
    { enabled, staleTime: 60_000, retry: false },
  );

  if (!enabled) {
    return (
      <ArtifactWarning
        title="Artifact unavailable"
        body="Open in a workspace to view this artifact."
      />
    );
  }
  if (q.isLoading) {
    return <ArtifactSkeleton />;
  }
  if (q.error || !q.data) {
    return (
      <ArtifactWarning
        title="Artifact not found"
        body={q.error?.message ?? `id ${artifactId}`}
      />
    );
  }

  const a = q.data;
  const href = ws ? `/w/${ws.slug}/artifacts/${a.slug}` : "#";

  return (
    <div className="my-2.5 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/60 px-2.5 py-1.5">
        <KindIcon kind={a.renderKind} type={a.type} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem] font-medium text-foreground">
            {a.title}
          </div>
          <div className="truncate text-[0.6875rem] text-muted-foreground">
            <span className="font-mono">artifact</span> · {a.type.toLowerCase()} ·{" "}
            {a.status.toLowerCase()}
          </div>
        </div>
        <Link
          href={href}
          className="focus-ring inline-flex items-center gap-1 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground hover:bg-background hover:text-foreground"
          title="Open artifact"
        >
          <ExternalLink className="h-3 w-3" /> Open
        </Link>
      </div>
      <ArtifactBody artifact={a} />
    </div>
  );
}

function ArtifactBody({
  artifact,
}: {
  artifact: {
    body: string;
    renderKind: "image" | "code" | "markdown";
    codeLang: string | null;
    codeBody: string | null;
    summary: string | null;
  };
}) {
  if (artifact.renderKind === "image") {
    return (
      <div className="px-3 py-2">
        {/* The body for image artifacts is `![alt](...)` — we hand it back
            to the markdown renderer which already knows how to expand
            forge-attachment URLs into <img> with the lightbox wired up. */}
        <DeferredMarkdown body={artifact.body} />
      </div>
    );
  }
  if (artifact.renderKind === "code") {
    return (
      <CodePreview
        code={artifact.codeBody ?? artifact.body}
        lang={artifact.codeLang ?? ""}
      />
    );
  }
  // Markdown — capped scroll so a long doc doesn't dominate the thread.
  return (
    <div className="forge-md max-h-72 overflow-auto px-3 py-2 text-[0.8125rem]">
      <DeferredMarkdown body={artifact.body || artifact.summary || ""} />
    </div>
  );
}

function DeferredMarkdown({ body }: { body: string }) {
  return (
    <Suspense
      fallback={
        <div className="space-y-1">
          <div className="h-3 w-1/2 animate-pulse rounded bg-subtle" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-subtle" />
        </div>
      }
    >
      <MarkdownWithAttachments body={body} />
    </Suspense>
  );
}

function CodePreview({ code, lang }: { code: string; lang: string }) {
  const reactId = useId();
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="bg-card/40">
      <div className="flex items-center justify-between border-b border-border/60 bg-card/60 px-3 py-1">
        <span className="font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          id={`copy-${reactId}`}
          className="focus-ring rounded border border-border/60 bg-background/70 px-1.5 py-0.5 font-sans text-[0.625rem] text-muted-foreground hover:bg-background hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[0.75rem] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function KindIcon({
  kind,
  type,
}: {
  kind: "image" | "code" | "markdown";
  type: string;
}) {
  if (kind === "image")
    return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-ember" />;
  if (kind === "code")
    return <Code2 className="h-3.5 w-3.5 shrink-0 text-ember" />;
  // Markdown — type tells us whether it's a note vs a spec/doc.
  if (type === "NOTE")
    return <FileText className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  return <FileText className="h-3.5 w-3.5 shrink-0 text-ember" />;
}

function ArtifactSkeleton() {
  return (
    <div className="my-2.5 overflow-hidden rounded-md border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/60 px-2.5 py-1.5">
        <div className="h-3.5 w-3.5 animate-pulse rounded bg-subtle" />
        <div className="flex-1 space-y-1">
          <div className="h-3 w-1/3 animate-pulse rounded bg-subtle" />
          <div className="h-2.5 w-1/4 animate-pulse rounded bg-subtle" />
        </div>
      </div>
      <div className="space-y-1 px-3 py-2">
        <div className="h-3 w-3/4 animate-pulse rounded bg-subtle" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-subtle" />
      </div>
    </div>
  );
}

function ArtifactWarning({ title, body }: { title: string; body: string }) {
  return (
    <div className="my-2 inline-flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem]">
      <AlertTriangle className="h-3.5 w-3.5 text-warning" />
      <span className="font-medium text-foreground">{title}</span>
      <span className="text-muted-foreground">— {body}</span>
    </div>
  );
}
