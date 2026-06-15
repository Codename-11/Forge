"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Download, Terminal } from "lucide-react";
import { Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { CodeBlock } from "@/components/mcp-integration-blocks";

/**
 * Self-provisioning instructions for a runtime host. The canonical script
 * (served at `/api/integrations/provision-script`, instance origin baked in)
 * fetches this runtime's secrets + repos, sets up git auth, and clones — so an
 * ephemeral agent (Claude Code, Codex CLI) or any host lands ready. The Codex
 * bridge and the Hermes `forge-provision` skill run the same script.
 */
export function RuntimeProvisioning() {
  // Origin is only known client-side; render a stable placeholder first.
  const [origin, setOrigin] = useState("https://your-forge");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const scriptUrl = `${origin}/api/integrations/provision-script`;
  const oneLiner =
    `curl -fsSL ${scriptUrl} -o forge-provision.cjs && \\\n` +
    `  FORGE_API_KEY=forge_sk_… node forge-provision.cjs`;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          Provisioning
        </span>
      }
      hint="Run one script on the host to self-provision: it fetches this runtime's secrets, sets up git auth (GitHub App token / GH_TOKEN / SSH key), and clones the bound repos. Ideal for ephemeral agents (Claude Code, Codex CLI)."
    >
      <Card as="div" className="space-y-3 p-4">
        <p className="text-meta text-muted-foreground">
          Set an agent-linked{" "}
          <Link href="/settings/access" className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">
            API key
          </Link>{" "}
          for this runtime&apos;s agent as <span className="font-mono">FORGE_API_KEY</span>, then run
          (Node 18+):
        </p>

        <CodeBlock label="bootstrap" code={oneLiner} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground">
          <a
            href={`${scriptUrl}?download=1`}
            className="inline-flex items-center gap-1 text-foreground hover:text-foreground/80"
          >
            <Download className="h-3.5 w-3.5" />
            Download forge-provision.cjs
          </a>
          <span>
            Clones into the current directory — set{" "}
            <span className="font-mono">FORGE_WORKSPACE_ROOT</span> to change it. Re-run any time;
            it&apos;s idempotent and re-mints the GitHub App token.
          </span>
        </div>

        <p className="text-meta text-muted-foreground/80">
          Persistent Hermes host? Install the{" "}
          <span className="font-mono">forge-provision</span> skill (runs this on a schedule and
          re-mints the token hourly). The Codex bridge runs the same script at container start.
        </p>
      </Card>
    </Section>
  );
}
