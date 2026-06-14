import { describe, it, expect, vi, afterEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildAppJwt,
  mintInstallationToken,
  verifyGithubApp,
} from "@/server/services/github-app";

// A throwaway RSA keypair to sign/verify app JWTs without touching GitHub.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildAppJwt", () => {
  it("produces a verifiable RS256 JWT with the app id as issuer", () => {
    const now = 1_700_000_000;
    const jwt = buildAppJwt("123456", privateKey, now);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

    expect(b64urlToJson(headerB64)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = b64urlToJson(payloadB64);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(now - 60); // backdated for clock skew
    expect(payload.exp).toBe(now + 9 * 60); // ≤ 10 min per GitHub

    // Signature must verify against the public key over header.payload.
    const ok = createVerify("RSA-SHA256")
      .update(`${headerB64}.${payloadB64}`)
      .verify(publicKey, Buffer.from(sigB64, "base64url"));
    expect(ok).toBe(true);
  });

  it("throws a helpful error when the private key is not a valid PEM", () => {
    expect(() => buildAppJwt("123456", "not-a-key", 1_700_000_000)).toThrow(/PEM/i);
  });
});

describe("mintInstallationToken", () => {
  it("POSTs a Bearer JWT and maps the token response", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
      expect(init.method).toBe("POST");
      const auth = (init.headers as Record<string, string>).authorization;
      expect(auth).toMatch(/^Bearer .+\..+\..+$/); // a JWT
      return new Response(
        JSON.stringify({
          token: "ghs_minted",
          expires_at: "2026-06-14T18:00:00Z",
          permissions: { contents: "write" },
          repository_selection: "selected",
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tok = await mintInstallationToken({
      appId: "123456",
      installationId: "42",
      privateKeyPem: privateKey,
    });
    expect(tok.token).toBe("ghs_minted");
    expect(tok.expiresAt).toBe("2026-06-14T18:00:00Z");
    expect(tok.repositorySelection).toBe("selected");
  });

  it("surfaces a readable error on a 404 installation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(
      mintInstallationToken({ appId: "1", installationId: "999", privateKeyPem: privateKey }),
    ).rejects.toThrow(/installation not found/i);
  });
});

describe("verifyGithubApp", () => {
  it("returns slug, account, repo count and expiry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({ slug: "forge-bot", name: "Forge Bot" }), {
          status: 200,
        });
      }
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_x",
            expires_at: "2026-06-14T18:00:00Z",
            repository_selection: "all",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/installation/repositories")) {
        return new Response(
          JSON.stringify({
            total_count: 3,
            repositories: [{ owner: { login: "acme" } }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await verifyGithubApp({
      appId: "123456",
      installationId: "42",
      privateKeyPem: privateKey,
    });
    expect(res.slug).toBe("forge-bot");
    expect(res.appName).toBe("Forge Bot");
    expect(res.account).toBe("acme");
    expect(res.repoCount).toBe(3);
    expect(res.expiresAt).toBe("2026-06-14T18:00:00Z");
  });

  it("throws when the token mint fails even if /app succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/app")) return new Response("{}", { status: 200 });
        return new Response("bad creds", { status: 401 });
      }),
    );
    await expect(
      verifyGithubApp({ appId: "1", installationId: "2", privateKeyPem: privateKey }),
    ).rejects.toThrow(/401|credentials/i);
  });
});
