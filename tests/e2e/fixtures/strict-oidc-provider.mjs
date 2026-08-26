import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.E2E_OIDC_PORT ?? 3211);
const issuer = `http://127.0.0.1:${port}`;
const clientId = "forge-strict-oidc";
const clientSecret = "forge-strict-oidc-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const codes = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function idToken({ nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "strict-e2e" }));
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: clientId,
      sub: "strict-user",
      email: process.env.E2E_OWNER_EMAIL ?? "owner@forge.local",
      email_verified: true,
      name: "Forge Owner",
      nonce,
      iat: now,
      exp: now + 300,
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function validState(state) {
  return Boolean(state && state.length >= 32 && new Set(state).size >= 8);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  if (url.pathname === "/health") return json(res, 200, { ok: true });
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  }
  if (url.pathname === "/jwks") {
    return json(res, 200, { keys: [{ ...jwk, kid: "strict-e2e", use: "sig", alg: "RS256" }] });
  }
  if (url.pathname === "/authorize") {
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const challenge = url.searchParams.get("code_challenge");
    const method = url.searchParams.get("code_challenge_method");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (!validState(state)) return json(res, 400, { error: "weak_state" });
    if (!nonce || nonce.length < 16) return json(res, 400, { error: "missing_nonce" });
    if (!challenge || method !== "S256") return json(res, 400, { error: "pkce_required" });
    if (!redirectUri) return json(res, 400, { error: "invalid_redirect_uri" });
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { challenge, nonce });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    res.writeHead(302, { location: callback.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    const auth = req.headers.authorization;
    const basic = auth?.startsWith("Basic ")
      ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":")
      : [];
    const suppliedId = basic[0] ?? params.get("client_id");
    const suppliedSecret = basic[1] ?? params.get("client_secret");
    if (suppliedId !== clientId || suppliedSecret !== clientSecret) {
      return json(res, 401, { error: "invalid_client" });
    }
    const code = params.get("code");
    const record = code ? codes.get(code) : null;
    const verifier = params.get("code_verifier") ?? "";
    const digest = createHash("sha256").update(verifier).digest("base64url");
    if (!record || digest !== record.challenge) {
      return json(res, 400, { error: "invalid_grant" });
    }
    codes.delete(code);
    return json(res, 200, {
      access_token: randomBytes(24).toString("base64url"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken(record),
      scope: "openid profile email",
    });
  }
  if (url.pathname === "/userinfo") {
    return json(res, 200, {
      sub: "strict-user",
      email: process.env.E2E_OWNER_EMAIL ?? "owner@forge.local",
      email_verified: true,
      name: "Forge Owner",
    });
  }
  return json(res, 404, { error: "not_found" });
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`[strict-oidc] listening on ${issuer}\n`);
});
