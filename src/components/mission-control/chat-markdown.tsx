"use client";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Heavy-renderer loaders
// ---------------------------------------------------------------------------
// mermaid is ~700 KB and katex is ~280 KB. We dynamic-import them inside
// useEffect so chat threads without diagrams or math never pull these
// chunks. Webpack/Turbopack code-splits at the `import("…")` boundary, so
// we don't need a separate React.lazy module file.
//
// Both loaders are memoised promises — once any block on the page kicks
// the import we share the resolved module across all blocks.
type MermaidApi = { render: (id: string, src: string) => Promise<{ svg: string }> };
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        // strict security: blocks click handlers in user-authored diagrams.
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return mermaid as unknown as MermaidApi;
    });
  }
  return mermaidPromise;
}

type KatexApi = {
  renderToString: (tex: string, opts?: Record<string, unknown>) => string;
};
let katexPromise: Promise<KatexApi> | null = null;
function loadKatex(): Promise<KatexApi> {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import("katex"),
      // CSS side-effect import — Next.js bundles this into the chunk so
      // it only loads when math is actually rendered on the page. tsc
      // doesn't know about Next's CSS modules ambient types, hence the
      // suppression.
      // @ts-expect-error - non-module CSS side-effect import resolved by Next
      import("katex/dist/katex.min.css"),
    ]).then(([mod]) => mod.default as unknown as KatexApi);
  }
  return katexPromise;
}

// ---------------------------------------------------------------------------
// MermaidBlock — renders a fenced ```mermaid block as an inline SVG.
// On parse failure we drop back to the plain CodeBlock fallback so the
// user never loses their source.
// ---------------------------------------------------------------------------
function MermaidBlock({ code, blockIndex }: { code: string; blockIndex: number }) {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/:/g, "-")}-${blockIndex}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, code))
      .then((res) => {
        if (!cancelled) setSvg(res.svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  if (failed) {
    return (
      <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/40">
        <div className="border-b border-border bg-card/60 px-3 py-1 font-sans text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
          diagram failed to parse
        </div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <div className="my-1.5 rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        Loading diagram…
      </div>
    );
  }

  return (
    <div
      className="my-1.5 flex justify-center overflow-x-auto rounded-md border border-border bg-card/40 px-3 py-2 [&_svg]:h-auto [&_svg]:max-w-full"
      // mermaid's `securityLevel: "strict"` strips event handlers and
      // sanitises the SVG, which is why we can inject it inline.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ---------------------------------------------------------------------------
// KatexInline / KatexBlock — render LaTeX via katex.renderToString once
// the dynamic import resolves. Fallback is the raw source in code-style
// so it stays readable while loading or on error.
// ---------------------------------------------------------------------------
function useKatex(tex: string, displayMode: boolean) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadKatex()
      .then((katex) => {
        const rendered = katex.renderToString(tex, {
          displayMode,
          throwOnError: false,
          // Trust nothing — katex still escapes HTML, but this stops
          // \href and other risky macros in user-authored math.
          trust: false,
          strict: "ignore",
        });
        if (!cancelled) setHtml(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tex, displayMode]);
  return { html, failed };
}

function KatexInline({ tex }: { tex: string }) {
  const { html, failed } = useKatex(tex, false);
  if (failed || html === null) {
    return (
      <code className="rounded border border-border bg-card/40 px-1 py-0 font-mono text-[0.85em] text-muted-foreground">
        {tex}
      </code>
    );
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function KatexBlock({ tex }: { tex: string }) {
  const { html, failed } = useKatex(tex, true);
  if (failed) {
    return (
      <div className="my-1.5 overflow-hidden rounded-md border border-border bg-card/40">
        <div className="border-b border-border bg-card/60 px-3 py-1 font-sans text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
          math failed to parse
        </div>
        <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
          <code>{tex}</code>
        </pre>
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="my-1.5 rounded-md border border-border bg-card/40 px-3 py-2 text-center font-mono text-[0.6875rem] text-muted-foreground">
        {tex}
      </div>
    );
  }
  return (
    <div
      className="my-1.5 overflow-x-auto px-3 py-1 text-center"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Inline formatter — handles **bold**, `code`, *italic*, plain URLs, and
// inline LaTeX `$..$`.
// Returns an array of React nodes from a raw text string.
// ---------------------------------------------------------------------------
function inlineFormat(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Priority order: URL, bold, inline code, inline math, italic.
  // Inline math requires a non-space char immediately after the opening
  // `$` and before the closing `$`, and the closing `$` must not be
  // followed by a digit — so plain prose like "$5 and $10" doesn't get
  // captured as math.
  const regex =
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])|(\*\*(.+?)\*\*)|(`([^`]+)`)|(\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d))|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    if (match[1]) {
      // URL
      parts.push(
        <a
          key={match.index}
          href={match[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ember underline underline-offset-2 hover:text-ember/80"
        >
          {match[1]}
        </a>,
      );
    } else if (match[2]) {
      // Bold
      parts.push(
        <strong key={match.index} className="font-semibold">
          {match[3]}
        </strong>,
      );
    } else if (match[4]) {
      // Inline code
      parts.push(
        <code
          key={match.index}
          className="rounded border border-border bg-card/40 px-1 py-0 font-mono text-[0.85em] text-foreground"
        >
          {match[5]}
        </code>,
      );
    } else if (match[6]) {
      // Inline LaTeX
      parts.push(<KatexInline key={match.index} tex={match[7]} />);
    } else if (match[8]) {
      // Italic
      parts.push(
        <em key={match.index} className="italic opacity-85">
          {match[8]}
        </em>,
      );
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// CodeBlock — <pre> with a copy button. No syntax highlighting.
// ---------------------------------------------------------------------------
function CodeBlock({ code, index }: { code: string; index: number }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      key={index}
      className="relative my-1.5 overflow-hidden rounded-md border border-border bg-card/40"
    >
      <button
        onClick={handleCopy}
        className="absolute right-1.5 top-1.5 rounded border border-border bg-background/70 px-1.5 py-0.5 font-sans text-[0.5625rem] text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label="Copy code"
        type="button"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main parser — walks lines and builds block-level React nodes.
// ---------------------------------------------------------------------------
function parseMarkdown(body: string): React.ReactNode[] {
  if (!body) return [];

  const lines = body.split("\n");
  const result: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = "";
  let codeBlockIndex = 0;
  let inMathBlock = false;
  let mathLines: string[] = [];
  let mathBlockIndex = 0;

  function flushCode(keyHint: string) {
    const code = codeLines.join("\n");
    if (codeLang === "mermaid") {
      result.push(
        <MermaidBlock key={`mermaid-${keyHint}`} code={code} blockIndex={codeBlockIndex++} />,
      );
    } else {
      result.push(<CodeBlock key={`code-${keyHint}`} code={code} index={codeBlockIndex++} />);
    }
    codeLines = [];
    codeLang = "";
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- Code fence toggle ----
    if (!inMathBlock && line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
        codeLang = line.slice(3).trim().toLowerCase();
      } else {
        inCodeBlock = false;
        flushCode(String(i));
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // ---- Block math fence ($$..$$). Supports the single-line form
    // `$$ a = b $$` and the multi-line fenced form. Must run before the
    // blank-line spacer rule. ----
    const singleLineMath = line.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (!inMathBlock && singleLineMath) {
      result.push(
        <KatexBlock key={`math-${i}-${mathBlockIndex++}`} tex={singleLineMath[1].trim()} />,
      );
      continue;
    }
    if (!inMathBlock && line.trim() === "$$") {
      inMathBlock = true;
      mathLines = [];
      continue;
    }
    if (inMathBlock) {
      if (line.trim() === "$$") {
        inMathBlock = false;
        result.push(
          <KatexBlock key={`math-${i}-${mathBlockIndex++}`} tex={mathLines.join("\n")} />,
        );
        mathLines = [];
      } else {
        mathLines.push(line);
      }
      continue;
    }

    // ---- Blank line spacer ----
    if (line.trim() === "") {
      result.push(<div key={`space-${i}`} className="h-1.5" />);
      continue;
    }

    // ---- Bullet list ----
    if (/^[-*] /.test(line)) {
      result.push(
        <div key={i} className="mb-0.5 flex gap-2">
          <span className="mt-0.5 shrink-0 text-ember">•</span>
          <span>{inlineFormat(line.slice(2))}</span>
        </div>,
      );
      continue;
    }

    // ---- Ordered list ----
    const orderedMatch = line.match(/^(\d+)\. (.*)/);
    if (orderedMatch) {
      result.push(
        <div key={i} className="mb-0.5 flex gap-2">
          <span className="mt-0 shrink-0 font-mono text-[0.85em] font-semibold text-ember">
            {orderedMatch[1]}.
          </span>
          <span>{inlineFormat(orderedMatch[2])}</span>
        </div>,
      );
      continue;
    }

    // ---- h3 ----
    if (line.startsWith("### ")) {
      result.push(
        <div
          key={i}
          className={cn(
            "mt-2 mb-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider",
            "text-muted-foreground",
          )}
        >
          {inlineFormat(line.slice(4))}
        </div>,
      );
      continue;
    }

    // ---- h2 ----
    if (line.startsWith("## ")) {
      result.push(
        <div
          key={i}
          className={cn(
            "mt-2.5 mb-1 text-[0.75rem] font-bold uppercase tracking-wider",
            "text-foreground",
          )}
        >
          {inlineFormat(line.slice(3))}
        </div>,
      );
      continue;
    }

    // ---- h1 ----
    if (line.startsWith("# ")) {
      result.push(
        <div
          key={i}
          className={cn(
            "mt-3 mb-1 text-[0.8125rem] font-bold uppercase tracking-wider",
            "text-foreground",
          )}
        >
          {inlineFormat(line.slice(2))}
        </div>,
      );
      continue;
    }

    // ---- Plain paragraph line (preserves spacing) ----
    result.push(
      <div key={i} className="mb-px whitespace-pre-wrap break-words">
        {inlineFormat(line)}
      </div>,
    );
  }

  // Unclosed code block — flush remaining lines as-is
  if (inCodeBlock && codeLines.length > 0) {
    flushCode("tail");
  }
  // Unclosed math block — render whatever we have so content isn't lost.
  if (inMathBlock && mathLines.length > 0) {
    result.push(<KatexBlock key="math-tail" tex={mathLines.join("\n")} />);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Eager prefetch: when a body contains a mermaid block, kick the dynamic
// import in parallel with mount so the diagram renders without the
// initial Suspense flash.
// ---------------------------------------------------------------------------
function usePrefetchMermaid(body: string) {
  const prefetched = useRef(false);
  const needs = /(^|\n)```mermaid\b/.test(body);
  useEffect(() => {
    if (needs && !prefetched.current) {
      prefetched.current = true;
      void loadMermaid();
    }
  }, [needs]);
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
export function ChatMarkdown({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  usePrefetchMermaid(body);
  const nodes = parseMarkdown(body);
  return (
    <div className={cn("min-w-0 break-words text-[0.75rem] leading-relaxed", className)}>
      {nodes}
    </div>
  );
}
