import "server-only";
import { createSign } from "node:crypto";

/**
 * GitHub App authentication for runtime provisioning.
 *
 * Instead of a static `GH_TOKEN` PAT scoped per repo, a runtime can bind a
 * GitHub App (App ID + installation ID + PEM private key). Forge mints a
 * short-lived (≈1h) *installation access token* on demand and injects it as
 * `GH_TOKEN` at provision time. Repo access is whatever the installation
 * grants — managed entirely in GitHub's UI, never re-scoped in Forge.
 *
 * The private key never leaves the server; the minted token never touches the
 * DB. Minting is two steps:
 *   1. Sign a short-lived RS256 JWT with the app's private key (`iss` = App ID).
 *   2. POST that JWT to `/app/installations/{id}/access_tokens` → a token
 *      scoped to the installation's repos with the app's declared permissions.
 *
 * Refs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 */

const GH_API = "https://api.github.com";
const UA = "forge-runtime-provisioner";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Build an app-level JWT (RS256). GitHub allows up to 10 min expiry; we use 9
 * and backdate `iat` by 60s to tolerate clock skew between Forge and GitHub.
 */
export function buildAppJwt(appId: string, privateKeyPem: string, nowSec: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  } catch {
    throw new Error(
      "Could not sign with the app private key — paste the full PEM, including the BEGIN/END lines.",
    );
  }
  return `${signingInput}.${base64url(signature)}`;
}

export type InstallationToken = {
  token: string;
  /** ISO-8601 expiry (~1h out). */
  expiresAt: string;
  permissions?: Record<string, string>;
  repositorySelection?: string;
};

export type GithubAppCreds = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
};

async function ghFetch(url: string, bearer: string): Promise<Response> {
  return fetch(url, {
    method: url.endsWith("/access_tokens") ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": UA,
    },
  });
}

function humanizeGithubError(status: number, body: string): string {
  if (status === 401) return "GitHub rejected the app credentials (401) — check the App ID and private key.";
  if (status === 404)
    return "Installation not found (404) — check the installation ID and that the app is still installed.";
  const detail = body ? `: ${body.slice(0, 200)}` : "";
  return `GitHub API error (HTTP ${status})${detail}`;
}

/** Mint a fresh installation access token. Always hits GitHub (no cache). */
export async function mintInstallationToken(creds: GithubAppCreds): Promise<InstallationToken> {
  const jwt = buildAppJwt(creds.appId, creds.privateKeyPem, Math.floor(Date.now() / 1000));
  const res = await ghFetch(
    `${GH_API}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`,
    jwt,
  );
  if (!res.ok) {
    throw new Error(humanizeGithubError(res.status, await res.text().catch(() => "")));
  }
  const json = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
    repository_selection?: string;
  };
  return {
    token: json.token,
    expiresAt: json.expires_at,
    permissions: json.permissions,
    repositorySelection: json.repository_selection,
  };
}

// ── Per-app token cache ────────────────────────────────────────────────────
// Provisioning can be called repeatedly (every bridge start / dispatch). A
// freshly-minted token is good for ~1h, so we reuse it across calls until it's
// within 10 min of expiry rather than hammering GitHub's token endpoint. Keyed
// by the GithubApp id so a workspace app shared across runtimes mints once.
const tokenCache = new Map<string, InstallationToken>();
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export async function getInstallationTokenForApp(
  appKey: string,
  creds: GithubAppCreds,
): Promise<InstallationToken> {
  const cached = tokenCache.get(appKey);
  if (cached && Date.parse(cached.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
    return cached;
  }
  const fresh = await mintInstallationToken(creds);
  tokenCache.set(appKey, fresh);
  return fresh;
}

/** Drop a cached token (e.g. after the app credentials change). */
export function invalidateInstallationToken(appKey: string): void {
  tokenCache.delete(appKey);
}

export type ManifestConversion = {
  appId: string;
  slug: string;
  name: string;
  privateKeyPem: string;
  clientId: string | null;
  webhookSecret: string | null;
};

/**
 * Exchange a GitHub App Manifest `code` for the created app's credentials.
 * GitHub returns the App ID, slug, and a freshly-generated PEM private key —
 * so the operator never copy-pastes a key. One-shot: the code is single-use
 * and expires in ~1h. See:
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */
export async function convertManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`${GH_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": UA,
    },
  });
  if (!res.ok) {
    throw new Error(humanizeGithubError(res.status, await res.text().catch(() => "")));
  }
  const json = (await res.json()) as {
    id: number;
    slug: string;
    name: string;
    pem: string;
    client_id?: string;
    webhook_secret?: string;
  };
  if (!json.id || !json.pem) {
    throw new Error("GitHub manifest conversion returned no app id / private key.");
  }
  return {
    appId: String(json.id),
    slug: json.slug,
    name: json.name,
    privateKeyPem: json.pem,
    clientId: json.client_id ?? null,
    webhookSecret: json.webhook_secret ?? null,
  };
}

export type VerifyResult = {
  ok: true;
  /** App slug (e.g. `forge-bot`), discovered from `/app`. */
  slug: string | null;
  appName: string | null;
  account: string | null;
  expiresAt: string;
  repositorySelection: string | null;
  repoCount: number | null;
};

/**
 * End-to-end credential check for the "Test connection" UI button: prove we
 * can sign as the app, mint a token for the installation, and read what it can
 * reach. Returns rich status for an instant, legible confirmation.
 */
export async function verifyGithubApp(creds: GithubAppCreds): Promise<VerifyResult> {
  const jwt = buildAppJwt(creds.appId, creds.privateKeyPem, Math.floor(Date.now() / 1000));

  // 1) Who is this app? (slug/name — non-fatal if it fails.)
  let slug: string | null = null;
  let appName: string | null = null;
  try {
    const appRes = await ghFetch(`${GH_API}/app`, jwt);
    if (appRes.ok) {
      const app = (await appRes.json()) as { slug?: string; name?: string };
      slug = app.slug ?? null;
      appName = app.name ?? null;
    }
  } catch {
    /* best-effort */
  }

  // 2) Mint a token — this is the real proof the installation works.
  const tokRes = await ghFetch(
    `${GH_API}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`,
    jwt,
  );
  if (!tokRes.ok) {
    throw new Error(humanizeGithubError(tokRes.status, await tokRes.text().catch(() => "")));
  }
  const tok = (await tokRes.json()) as {
    token: string;
    expires_at: string;
    repository_selection?: string;
  };

  // 3) How many repos can it reach + which account? (non-fatal.)
  let repoCount: number | null = null;
  let account: string | null = null;
  try {
    const reposRes = await fetch(`${GH_API}/installation/repositories?per_page=1`, {
      headers: {
        authorization: `Bearer ${tok.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
      },
    });
    if (reposRes.ok) {
      const data = (await reposRes.json()) as {
        total_count?: number;
        repositories?: Array<{ owner?: { login?: string } }>;
      };
      repoCount = typeof data.total_count === "number" ? data.total_count : null;
      account = data.repositories?.[0]?.owner?.login ?? null;
    }
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    slug,
    appName,
    account,
    expiresAt: tok.expires_at,
    repositorySelection: tok.repository_selection ?? null,
    repoCount,
  };
}
