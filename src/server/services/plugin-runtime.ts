import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { rateLimit } from "@/server/rate-limit";

/**
 * Plugin runtime — two responsibilities:
 *
 *  1. OUTBOUND: sign & deliver webhook events to plugin endpoints.
 *     - HMAC-SHA256 header `x-forge-signature` over `timestamp + "." + body`.
 *     - 5s connection timeout; best-effort retries handled by worker queue.
 *
 *  2. INBOUND invocation: a signed JWT accompanies agent callbacks into
 *     `/api/mcp/*` or the dynamic skill endpoints. Plugins present either:
 *       a) a long-lived API key (preferred for server-to-server), OR
 *       b) a short-lived JWT signed with `PLUGIN_JWT_SECRET`.
 *
 * Local skills (runtime === "local") are executed in-process by a dynamically
 * imported handler under `plugins/<slug>/handler.ts`. Those handlers should
 * treat their input as untrusted — validate against the declared schema.
 */

const encoder = new TextEncoder();
function secretKey(): Uint8Array {
  const s = process.env.PLUGIN_JWT_SECRET;
  if (!s) throw new Error("PLUGIN_JWT_SECRET is not set.");
  return encoder.encode(s);
}

export async function signPluginJwt(payload: Record<string, unknown>, ttlSec = 300): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(process.env.PLUGIN_JWT_ISSUER ?? "forge")
    .setAudience(process.env.PLUGIN_JWT_AUDIENCE ?? "forge-plugins")
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(secretKey());
}

export async function verifyPluginJwt(token: string) {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: process.env.PLUGIN_JWT_ISSUER ?? "forge",
    audience: process.env.PLUGIN_JWT_AUDIENCE ?? "forge-plugins",
  });
  return payload;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  toleranceSec = 300,
): boolean {
  const expected = signWebhookBody(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const drift = Math.abs(Date.now() / 1000 - Number(timestamp));
  return Number.isFinite(drift) && drift < toleranceSec;
}

export interface DeliverOptions {
  url: string;
  secret: string;
  body: unknown;
  timeoutMs?: number;
}

export async function deliverWebhook(opts: DeliverOptions): Promise<{
  ok: boolean;
  status: number;
  responseBody: string | null;
}> {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(opts.body);
  const sig = signWebhookBody(opts.secret, ts, raw);
  // Generic body-only HMAC, hex digest. Sent alongside the Forge-native
  // `x-forge-timestamp`/`x-forge-signature` pair so receivers that follow
  // the common `X-Webhook-Signature` convention (Hermes' webhook adapter,
  // most off-the-shelf validators) accept the delivery without code on
  // the receiver side. Forge-aware receivers continue to use the
  // timestamped pair for replay protection.
  const bodyOnlySig = createHmac("sha256", opts.secret)
    .update(raw)
    .digest("hex");
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "forge-webhook/1",
        "x-forge-timestamp": ts,
        "x-forge-signature": sig,
        "x-webhook-signature": bodyOnlySig,
      },
      body: raw,
    });
    const responseBody = await res.text().catch(() => null);
    return { ok: res.ok, status: res.status, responseBody };
  } catch (err) {
    logger.warn({ err, url: opts.url }, "webhook delivery failed");
    return { ok: false, status: 0, responseBody: null };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Invoke a skill. For `runtime: "local"` we dynamically import the handler
 * from `plugins/<slug>/handler.ts`. For `runtime: "plugin"` we make an HTTP
 * call to the plugin's webhook URL with a signed JWT in the Authorization
 * header (plugin validates against our JWKS — or the shared secret for HS256).
 */
export async function invokeSkill(params: {
  workspaceId: string;
  pluginSlug: string;
  skillName: string;
  input: unknown;
  invokerUserId: string | null;
}): Promise<unknown> {
  const plugin = await db.plugin.findFirstOrThrow({
    where: {
      workspaceId: params.workspaceId,
      slug: params.pluginSlug,
      status: "APPROVED",
    },
    include: { skills: { where: { name: params.skillName } } },
  });
  const skill = plugin.skills[0];
  if (!skill) throw new Error(`Skill ${params.pluginSlug}/${params.skillName} not found.`);

  // Plugin-declared rate limit.
  const manifestRate =
    (plugin.manifest as { rateLimit?: { perMinute?: number } }).rateLimit?.perMinute ?? 120;
  const rl = await rateLimit(`plugin:${plugin.id}:invoke`, manifestRate, 60);
  if (!rl.ok) throw new Error("Plugin rate limit exceeded.");

  if (skill.runtime === "local") {
    const { getLocalSkill } = await import("@/server/services/local-plugins");
    const handler = getLocalSkill(plugin.slug, skill.name);
    if (!handler)
      throw new Error(
        `Local handler missing for ${plugin.slug}/${skill.name}. Register it in src/server/services/local-plugins.ts.`,
      );
    return handler(params.input, {
      workspaceId: params.workspaceId,
      invokerUserId: params.invokerUserId,
    });
  }

  if (!plugin.webhookUrl || !plugin.secret) {
    throw new Error("Plugin has no delivery endpoint configured.");
  }
  const jwt = await signPluginJwt({
    sub: plugin.slug,
    workspaceId: plugin.workspaceId,
    skill: skill.name,
  });
  const res = await fetch(`${plugin.webhookUrl.replace(/\/$/, "")}/skills/${skill.name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(params.input),
  });
  if (!res.ok) throw new Error(`Plugin skill call failed: ${res.status}`);
  return res.json();
}
