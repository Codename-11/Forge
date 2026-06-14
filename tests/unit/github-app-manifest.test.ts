import { describe, it, expect } from "vitest";
import {
  buildManifest,
  safeReturnTo,
  signManifestState,
  verifyManifestState,
} from "@/server/integrations/github-app-manifest";

describe("github-app manifest helpers", () => {
  it("builds a manifest with our callbacks and git permissions", () => {
    const m = buildManifest({ origin: "https://forge.example", name: "Forge Runtime" }) as Record<
      string,
      unknown
    >;
    expect(m.name).toBe("Forge Runtime");
    expect(m.redirect_url).toBe("https://forge.example/api/integrations/github-app/callback");
    expect(m.setup_url).toBe("https://forge.example/api/integrations/github-app/installed");
    expect(m.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect((m.hook_attributes as { active: boolean }).active).toBe(false);
  });

  it("round-trips signed state and rejects tampered/garbage tokens", () => {
    const token = signManifestState({
      purpose: "create",
      workspaceId: "ws1",
      userId: "u1",
      returnTo: "/w/x/settings/github-apps",
    });
    const parsed = verifyManifestState(token);
    expect(parsed?.purpose).toBe("create");
    expect(parsed?.workspaceId).toBe("ws1");
    expect(parsed?.userId).toBe("u1");

    expect(verifyManifestState("not-a-valid-token")).toBeNull();
    // Tamper the ciphertext segment → GCM auth fails → null.
    const [iv, tag] = token.split(":");
    const forged = `${iv}:${tag}:${Buffer.from("tampered-ciphertext").toString("base64")}`;
    expect(verifyManifestState(forged)).toBeNull();
  });

  it("carries the install-leg app id", () => {
    const token = signManifestState({
      purpose: "install",
      workspaceId: "ws1",
      userId: "u1",
      githubAppId: "app1",
      returnTo: "/x",
    });
    expect(verifyManifestState(token)?.githubAppId).toBe("app1");
  });

  it("safeReturnTo only allows in-app paths", () => {
    expect(safeReturnTo("/w/x/settings", "/")).toBe("/w/x/settings");
    expect(safeReturnTo("https://evil.com", "/")).toBe("/");
    expect(safeReturnTo("//evil.com", "/")).toBe("/");
    expect(safeReturnTo(null, "/fallback")).toBe("/fallback");
  });
});
