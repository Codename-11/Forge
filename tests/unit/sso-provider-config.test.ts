import { describe, expect, it } from "vitest";
import { genericOidcProviderConfig } from "@/server/services/sso-provider-config";

describe("genericOidcProviderConfig", () => {
  it("requires PKCE, state, and nonce explicitly", () => {
    const provider = genericOidcProviderConfig(
      {
        id: "company-oidc",
        name: "Company SSO",
        issuer: "https://id.example.test",
        clientId: "forge",
        scopes: "openid profile email",
        allowLinking: false,
      },
      "secret",
    );

    expect(provider).toMatchObject({
      id: "company-oidc",
      type: "oidc",
      checks: ["pkce", "state", "nonce"],
      allowDangerousEmailAccountLinking: false,
      authorization: { params: { scope: "openid profile email" } },
    });
  });
});
