import "server-only";
import { SignJWT, importPKCS8, type KeyLike } from "jose";

const GITHUB_API_BASE = "https://api.github.com";
const JWT_SKEW_SECONDS = 60;
const JWT_TTL_SECONDS = 9 * 60;
const INSTALLATION_TOKEN_SKEW_MS = 60_000;

type CachedInstallationToken = {
  token: string;
  expiresAt: number;
};

let cachedPrivateKey: Promise<KeyLike> | null = null;
const installationTokenCache = new Map<string, CachedInstallationToken>();

function readAppId(): string {
  const appId = process.env.GITHUB_APP_ID?.trim();
  if (!appId) throw new Error("GITHUB_APP_ID is not configured.");
  return appId;
}

function readPrivateKey(): string {
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!pem) throw new Error("GITHUB_APP_PRIVATE_KEY is not configured.");
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

async function privateKey(): Promise<KeyLike> {
  cachedPrivateKey ??= importPKCS8(readPrivateKey(), "RS256");
  return cachedPrivateKey;
}

export async function createGitHubAppJwt(now = Math.floor(Date.now() / 1000)): Promise<string> {
  const iat = now - JWT_SKEW_SECONDS;
  const exp = now + JWT_TTL_SECONDS;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(readAppId())
    .sign(await privateKey());
}

export async function getInstallationAccessToken(
  installationId: string | number,
): Promise<string> {
  const key = String(installationId);
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > INSTALLATION_TOKEN_SKEW_MS) {
    return cached.token;
  }

  const jwt = await createGitHubAppJwt();
  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${key}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "forge-github-app",
      "x-github-api-version": "2022-11-28",
    },
  });
  const json = (await res.json().catch(() => ({}))) as {
    token?: string;
    expires_at?: string;
    message?: string;
  };
  if (!res.ok || !json.token) {
    throw new Error(json.message || `GitHub installation token failed with HTTP ${res.status}.`);
  }
  const expiresAt = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 55 * 60_000;
  installationTokenCache.set(key, { token: json.token, expiresAt });
  return json.token;
}

export function clearGitHubAppAuthCacheForTests(): void {
  cachedPrivateKey = null;
  installationTokenCache.clear();
}
