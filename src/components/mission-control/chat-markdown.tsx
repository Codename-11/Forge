"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Inline formatter — handles **bold**, `code`, *italic*, and plain URLs.
// Returns an array of React nodes from a raw text string.
// ---------------------------------------------------------------------------
function inlineFormat(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Priority order: URL, bold, inline code, italic
  const regex =
    /(https?:\/\/[^\s<]+[^\s<.,;:!?)}\]'"])|(\*\*(.+?)\*\*)|(`([^`]+)`)|\*([^*]+)\*/g;
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
      // Italic
      parts.push(
        <em key={match.index} className="italic opacity-85">
          {match[6]}
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
  let codeBlockIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- Code fence toggle ----
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        inCodeBlock = false;
        result.push(
          <CodeBlock key={`code-${i}`} code={codeLines.join("\n")} index={codeBlockIndex++} />,
        );
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
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
    result.push(
      <CodeBlock key="code-tail" code={codeLines.join("\n")} index={codeBlockIndex} />,
    );
  }

  return result;
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
  const nodes = parseMarkdown(body);
  return (
    <div className={cn("min-w-0 break-words text-[0.75rem] leading-relaxed", className)}>
      {nodes}
    </div>
  );
}
