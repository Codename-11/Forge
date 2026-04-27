"use client";
import { useMemo, useState } from "react";

export type McpOnboardingProvider = "hermes" | "claude" | "codex" | "custom";

type TabId = "claude-desktop" | "claude-code" | "codex" | "hermes" | "curl" | "env";

function defaultTab(provider: McpOnboardingProvider): TabId {
  if (provider === "hermes") return "hermes";
  if (provider === "codex") return "codex";
  if (provider === "custom") return "curl";
  return "claude-desktop";
}

export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background/60">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          className="focus-ring rounded px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[0.75rem] leading-relaxed text-foreground/90">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function McpIntegrationBlocks({
  baseUrl,
  rawKey,
  preferredProvider = "claude",
}: {
  baseUrl: string;
  rawKey: string;
  preferredProvider?: McpOnboardingProvider;
}) {
  const [tab, setTab] = useState<TabId>(() => defaultTab(preferredProvider));
  const rpcUrl = `${baseUrl}/api/mcp/rpc`;

  const claudeDesktop = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            forge: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                rpcUrl,
                "--header",
                `Authorization: Bearer ${rawKey}`,
              ],
            },
          },
        },
        null,
        2,
      ),
    [rpcUrl, rawKey],
  );

  const claudeCode = useMemo(
    () =>
      `claude mcp add --transport http forge ${rpcUrl} \\\n  --header "Authorization: Bearer ${rawKey}"`,
    [rpcUrl, rawKey],
  );

  const codex = useMemo(
    () =>
      `# ~/.codex/config.toml\n[mcp_servers.forge]\nurl = "${rpcUrl}"\nbearer_token_env_var = "FORGE_API_KEY"\ntool_timeout_sec = 120\n\n# shell profile or session\nexport FORGE_API_KEY="${rawKey}"`,
    [rpcUrl, rawKey],
  );

  const curl = useMemo(
    () =>
      `# MCP JSON-RPC (standard, works with any MCP client)\ncurl -sS ${rpcUrl} \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .\n\n# REST alias (simpler for curling one tool)\ncurl -sS ${baseUrl}/api/mcp/issues.list \\\n  -H "Authorization: Bearer ${rawKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"limit": 10}' | jq .`,
    [baseUrl, rpcUrl, rawKey],
  );

  const env = useMemo(
    () => `FORGE_URL=${baseUrl}\nFORGE_MCP_URL=${rpcUrl}\nFORGE_API_KEY=${rawKey}`,
    [baseUrl, rpcUrl, rawKey],
  );

  const hermes = useMemo(
    () =>
      `mcp_servers:\n  forge:\n    url: "${rpcUrl}"\n    headers:\n      Authorization: "Bearer ${rawKey}"\n    timeout: 120\n    connect_timeout: 60\n`,
    [rpcUrl, rawKey],
  );

  const tabs = [
    { id: "hermes" as const, label: "Hermes" },
    { id: "claude-desktop" as const, label: "Claude Desktop" },
    { id: "claude-code" as const, label: "Claude Code" },
    { id: "codex" as const, label: "Codex" },
    { id: "curl" as const, label: "HTTP" },
    { id: "env" as const, label: ".env" },
  ];

  const code =
    tab === "claude-desktop"
      ? claudeDesktop
      : tab === "claude-code"
        ? claudeCode
        : tab === "codex"
          ? codex
          : tab === "hermes"
            ? hermes
            : tab === "curl"
              ? curl
              : env;

  const label =
    tab === "claude-desktop"
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : tab === "claude-code"
        ? "add Forge as an MCP server"
        : tab === "codex"
          ? "~/.codex/config.toml"
          : tab === "hermes"
            ? "~/.hermes/config.yaml - merge into mcp_servers"
            : tab === "curl"
              ? "HTTP - works from any runtime"
              : "environment variables";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-subtle p-0.5 sm:grid-cols-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "focus-ring rounded px-2 py-1 text-[0.6875rem] transition-colors " +
              (tab === t.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeBlock label={label} code={code} />
    </div>
  );
}
