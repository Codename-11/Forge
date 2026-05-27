import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectionProvider } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/server/crypto";

/**
 * Live OAuth 2.0 / OIDC machinery for user-owned {@link Connection}s.
 *
 * Each connection stores its OAuth client config in `connection.config`:
 *   - `clientId`        — plain text (not a secret).
 *   - `clientSecretEnc` — AES-256-GCM ciphertext (via {@link encryptSecret}).
 *   - `issuer`          — OIDC issuer base (enables discovery).
 *   - `authUrl` / `tokenUrl` / `userinfoUrl` — explicit endpoint overrides.
 *
 * For GITHUB / GOOGLE / SLACK we ship the well-known endpoints; for OIDC we
 * discover them from `${issuer}/.well-known/openid-configuration` (explicit
 * config keys override discovery). The authorize/callback routes drive the
 * flow with CSRF `state` + PKCE; tokens are encrypted into `tokenEnc` and
 * never returned to the client.
 */

export type ConnectionConfig = {
  issuer?: string;
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId?: string;
  clientSecretEnc?: string;
  [k: string]: unknown;
};

export type ResolvedEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  defaultScopes: string[];
  /** PKCE is mandatory/safe for these; we always send a challenge anyway. */
  usesPkce: boolean;
};

/** The token bundle we persist (encrypted) in `connection.tokenEnc`. */
export type TokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  scope?: string | null;
  idToken?: string | null;
  /** epoch ms */
  obtainedAt: number;
  /** epoch ms, if the provider returned expires_in */
  expiresAt?: number | null;
};

const WELL_KNOWN: Partial<
  Record<ConnectionProvider, Omit<ResolvedEndpoints, "usesPkce"> & { usesPkce?: boolean }>
> = {
  GITHUB: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    // GitHub's identity endpoint isn't OIDC userinfo; we special-case it.
    userinfoEndpoint: "https://api.github.com/user",
    defaultScopes: ["read:user"],
    usesPkce: false,
  },
  GOOGLE: {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    defaultScopes: ["openid", "email", "profile"],
    usesPkce: true,
  },
  SLACK: {
    authorizationEndpoint: "https://slack.com/openid/connect/authorize",
    tokenEndpoint: "https://slack.com/api/openid.connect.token",
    userinfoEndpoint: "https://slack.com/api/openid.connect.userInfo",
    defaultScopes: ["openid", "email", "profile"],
    usesPkce: true,
  },
};

/** Trim a URL to origin+path, no trailing slash. */
function normalizeIssuer(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Read + lightly type the connection config JSON. */
export function readConfig(config: unknown): ConnectionConfig {
  return (config && typeof config === "object" ? config : {}) as ConnectionConfig;
}

/** Decrypt the stored client secret (or null if none / undecryptable). */
export function readClientSecret(config: ConnectionConfig): string | null {
  if (!config.clientSecretEnc) return null;
  try {
    return decryptSecret(config.clientSecretEnc);
  } catch {
    return null;
  }
}

/**
 * Merge a config update: persists `clientSecret` (plain in) as
 * `clientSecretEnc` (encrypted), drops the plaintext, and shallow-merges
 * the rest over the existing config. Empty-string clientSecret = unchanged.
 */
export function mergeConfigUpdate(
  existing: ConnectionConfig,
  patch: {
    issuer?: string;
    authUrl?: string;
    tokenUrl?: string;
    userinfoUrl?: string;
    clientId?: string;
    clientSecret?: string;
  },
): ConnectionConfig {
  const next: ConnectionConfig = { ...existing };
  if (patch.issuer !== undefined) next.issuer = patch.issuer ? normalizeIssuer(patch.issuer) : undefined;
  if (patch.authUrl !== undefined) next.authUrl = patch.authUrl || undefined;
  if (patch.tokenUrl !== undefined) next.tokenUrl = patch.tokenUrl || undefined;
  if (patch.userinfoUrl !== undefined) next.userinfoUrl = patch.userinfoUrl || undefined;
  if (patch.clientId !== undefined) next.clientId = patch.clientId || undefined;
  if (patch.clientSecret) next.clientSecretEnc = encryptSecret(patch.clientSecret);
  return next;
}

/** Strip secrets from a config object for client return. */
export function redactConfig(config: unknown): Record<string, unknown> {
  const c = readConfig(config);
  const { clientSecretEnc, ...rest } = c;
  return { ...rest, hasClientSecret: !!clientSecretEnc };
}

const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Resolve the authorization / token / userinfo endpoints for a connection.
 *
 * - GITHUB/GOOGLE/SLACK: use {@link WELL_KNOWN}; explicit config overrides.
 * - OIDC/CUSTOM: explicit endpoints win; otherwise discover from issuer.
 */
export async function resolveEndpoints(
  provider: ConnectionProvider,
  config: ConnectionConfig,
): Promise<ResolvedEndpoints> {
  const known = WELL_KNOWN[provider];

  // Start from known endpoints (if any), then layer explicit overrides.
  let authorizationEndpoint = config.authUrl || known?.authorizationEndpoint || null;
  let tokenEndpoint = config.tokenUrl || known?.tokenEndpoint || null;
  let userinfoEndpoint = config.userinfoUrl || known?.userinfoEndpoint || null;
  const defaultScopes = known?.defaultScopes ?? ["openid", "email", "profile"];
  const usesPkce = known?.usesPkce ?? true;

  // OIDC discovery fills any gaps when an issuer is present.
  const needsDiscovery = (!authorizationEndpoint || !tokenEndpoint) && !!config.issuer;
  if (needsDiscovery) {
    const issuer = normalizeIssuer(config.issuer!);
    const doc = await fetchDiscovery(issuer);
    authorizationEndpoint =
      authorizationEndpoint || (typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : null);
    tokenEndpoint = tokenEndpoint || (typeof doc.token_endpoint === "string" ? doc.token_endpoint : null);
    userinfoEndpoint =
      userinfoEndpoint || (typeof doc.userinfo_endpoint === "string" ? doc.userinfo_endpoint : null);
  }

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      "Could not resolve OAuth endpoints — set an issuer (for OIDC discovery) or explicit authUrl/tokenUrl.",
    );
  }

  return { authorizationEndpoint, tokenEndpoint, userinfoEndpoint, defaultScopes, usesPkce };
}

async function fetchDiscovery(issuer: string): Promise<Record<string, unknown>> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OIDC discovery returned HTTP ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function makeStateToken(): string {
  return base64url(randomBytes(24));
}

/**
 * The cookie payload carried between authorize → callback. Signed (HMAC over
 * AUTH_SECRET) so a tampered state can't be replayed; short-lived.
 */
export type FlowState = {
  connectionId: string;
  state: string;
  verifier: string;
  /** epoch ms issued */
  iat: number;
};

function flowKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for OAuth flow state signing.");
  return createHash("sha256").update(`${secret}:connection-oauth-flow`).digest();
}

export function signFlowState(s: FlowState): string {
  const body = base64url(Buffer.from(JSON.stringify(s), "utf8"));
  const sig = base64url(createHmac("sha256", flowKey()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyFlowState(raw: string | undefined): FlowState | null {
  if (!raw) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;
  const expected = base64url(createHmac("sha256", flowKey()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (
      typeof parsed?.connectionId === "string" &&
      typeof parsed?.state === "string" &&
      typeof parsed?.verifier === "string" &&
      typeof parsed?.iat === "number"
    ) {
      return parsed as FlowState;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Cookie name for the in-flight OAuth state. */
export const FLOW_COOKIE = "forge_conn_oauth";
/** Flow state TTL (10 minutes). */
export const FLOW_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(args: {
  endpoints: ResolvedEndpoints;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const { endpoints, clientId, redirectUri, scopes, state, codeChallenge } = args;
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  const scope = (scopes.length ? scopes : endpoints.defaultScopes).join(" ");
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  // Always send PKCE; compliant servers ignore it if unsupported, and it's
  // a strict security win where supported.
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Ask for a refresh token where the provider gates it behind a prompt.
  if (endpoints.authorizationEndpoint.includes("accounts.google.com")) {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function postToken(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<RawTokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  // GitHub historically returns form-encoded unless you ask for JSON; we set
  // accept: application/json above, which it honors. Parse defensively.
  const text = await res.text();
  let json: RawTokenResponse;
  try {
    json = JSON.parse(text) as RawTokenResponse;
  } catch {
    json = Object.fromEntries(new URLSearchParams(text)) as RawTokenResponse;
  }
  if (!res.ok || json.error) {
    throw new Error(json.error_description || json.error || `Token endpoint HTTP ${res.status}`);
  }
  return json;
}

function toBundle(raw: RawTokenResponse, fallbackRefresh?: string | null): TokenBundle {
  const now = Date.now();
  if (!raw.access_token) throw new Error("Token response missing access_token.");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? fallbackRefresh ?? null,
    tokenType: raw.token_type ?? null,
    scope: raw.scope ?? null,
    idToken: raw.id_token ?? null,
    obtainedAt: now,
    expiresAt: typeof raw.expires_in === "number" ? now + raw.expires_in * 1000 : null,
  };
}

export async function exchangeCode(args: {
  endpoints: ResolvedEndpoints;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<TokenBundle> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  };
  if (args.clientSecret) params.client_secret = args.clientSecret;
  return toBundle(await postToken(args.endpoints.tokenEndpoint, params));
}

export async function refreshTokens(args: {
  endpoints: ResolvedEndpoints;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
}): Promise<TokenBundle> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  };
  if (args.clientSecret) params.client_secret = args.clientSecret;
  return toBundle(await postToken(args.endpoints.tokenEndpoint, params), args.refreshToken);
}

// ---------------------------------------------------------------------------
// Identity (account display handle)
// ---------------------------------------------------------------------------

/**
 * Fetch a human-readable account handle for the connected identity, used to
 * populate `connection.account`. Best-effort — returns null on any failure.
 */
export async function fetchAccountHandle(
  provider: ConnectionProvider,
  endpoints: ResolvedEndpoints,
  bundle: TokenBundle,
): Promise<string | null> {
  try {
    if (provider === "GITHUB") {
      const res = await fetch(endpoints.userinfoEndpoint || "https://api.github.com/user", {
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${bundle.accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "forge-connections",
        },
      });
      if (!res.ok) return null;
      const u = (await res.json()) as { login?: string; email?: string };
      return u.login ? `github.com/${u.login}` : u.email ?? null;
    }
    if (!endpoints.userinfoEndpoint) return null;
    const res = await fetch(endpoints.userinfoEndpoint, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { authorization: `Bearer ${bundle.accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as Record<string, unknown>;
    const handle =
      (typeof u.email === "string" && u.email) ||
      (typeof u.preferred_username === "string" && u.preferred_username) ||
      (typeof u.name === "string" && u.name) ||
      (typeof u.sub === "string" && u.sub) ||
      null;
    return handle || null;
  } catch {
    return null;
  }
}

/** Encrypt a token bundle for `connection.tokenEnc`. */
export function encryptBundle(bundle: TokenBundle): string {
  return encryptSecret(JSON.stringify(bundle));
}

/** Decrypt a stored token bundle (null on any failure). */
export function decryptBundle(tokenEnc: string | null | undefined): TokenBundle | null {
  if (!tokenEnc) return null;
  try {
    const parsed = JSON.parse(decryptSecret(tokenEnc)) as TokenBundle;
    if (typeof parsed?.accessToken === "string") return parsed;
  } catch {
    /* fall through */
  }
  return null;
}
