import { describe, it, expect } from "vitest";
import { buildProvisionScript, PROVISION_SCRIPT_VERSION } from "@/server/integrations/provision-script";

describe("buildProvisionScript", () => {
  const script = buildProvisionScript("https://forge.example.com/");

  it("bakes the instance origin as the default base (trailing slash stripped)", () => {
    expect(script).toContain('process.env.FORGE_BASE_URL || "https://forge.example.com"');
    expect(script).not.toContain("__FORGE_BASE_DEFAULT__");
  });

  it("covers the provisioning behaviors", () => {
    expect(script).toContain("/api/mcp/runtimes.provisioning");
    expect(script).toContain("FORGE_API_KEY");
    expect(script).toContain("GH_TOKEN");
    expect(script).toContain("GIT_SSH_KEY");
    expect(script).toContain("credential.helper");
    expect(script).toContain("core.sshCommand");
    expect(script).toContain("clone");
    expect(script).toContain("pull");
    expect(script).toContain(`v${PROVISION_SCRIPT_VERSION}`);
  });

  it("is syntactically valid JavaScript", () => {
    // Strip the shebang (not valid JS) then compile-check via Function — this
    // parses without executing, catching any escaping mistakes in the embed.
    const body = script.replace(/^#![^\n]*\n/, "");
    expect(() => new Function(body)).not.toThrow();
  });

  it("produces a working POSIX single-quote escape (no broken backslashes)", () => {
    // The trickiest embed: the shellQuote replacement must be `'\\''` in source.
    expect(script).toContain(`.replace(/'/g, "'\\\\''")`);
  });
});
