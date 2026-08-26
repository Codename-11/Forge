import type { Provider } from "next-auth/providers";

type GenericOidcRow = {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  scopes: string | null;
  allowLinking: boolean;
};

/**
 * Build Forge's provider-neutral OIDC configuration. Explicit checks are
 * deliberate: generic providers must prove the authorization response belongs
 * to the initiating browser and token exchange, regardless of provider
 * defaults in a particular Auth.js release.
 */
export function genericOidcProviderConfig(row: GenericOidcRow, clientSecret: string): Provider {
  return {
    id: row.id,
    name: row.name,
    type: "oidc",
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret,
    checks: ["pkce", "state", "nonce"],
    allowDangerousEmailAccountLinking: row.allowLinking,
    ...(row.scopes ? { authorization: { params: { scope: row.scopes } } } : {}),
  };
}
