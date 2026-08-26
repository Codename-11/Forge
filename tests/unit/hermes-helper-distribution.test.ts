import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Hermes helper distribution", () => {
  it("ships a script-only recurring presence heartbeat that is silent on success", () => {
    const heartbeat = source("integrations/hermes/forge-presence/bin/heartbeat.sh");
    const setup = source("integrations/hermes/forge-presence/bin/setup.sh");
    expect(heartbeat).toContain("/api/mcp/agents.heartbeat");
    expect(heartbeat).toContain("--output /dev/null");
    expect(heartbeat).toContain("--fail --silent --show-error");
    expect(heartbeat).not.toMatch(/hermes\s+(chat|run|session)|prompt|llm/i);
    expect(setup).toContain("* * * * *");
    expect(setup).toContain("crontab -");
  });

  it("keeps provisioning logic canonical by downloading the Forge-served script", () => {
    const provision = source("integrations/hermes/forge-provision/bin/run.sh");
    expect(provision).toContain("/api/integrations/provision-script");
    expect(provision).toContain('node "$TMP"');
    expect(provision).not.toContain("git clone");
  });

  it("packages both helpers as checksummed release assets", () => {
    const packager = source("scripts/package-hermes-helpers.sh");
    const release = source(".github/workflows/release.yml");
    expect(packager).toContain("forge-presence");
    expect(packager).toContain("forge-provision");
    expect(packager).toContain("SHA256SUMS");
    expect(release).toContain("package-hermes-helpers.sh");
    expect(release).toContain("dist/hermes-helpers/*");
  });
});
