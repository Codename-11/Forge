import "server-only";
import OpenAI from "openai";
import type { PrismaClient } from "@prisma/client";
import { logger } from "@/server/logger";
import { decryptSecret } from "@/server/crypto";

/**
 * AI provider registry. Mirrors Mission-Control's pattern:
 *
 *   - **Hermes is the default.** Hermes exposes an OpenAI-compatible
 *     `/v1/chat/completions` endpoint and routes internally to whatever
 *     provider its `model-router` plugin selects (Anthropic / OpenAI /
 *     Nous / etc.). One LLM client, one auth setup.
 *
 *   - **Other providers are explicit overrides.** Operators can point a
 *     workspace at OpenAI, Anthropic, or a custom OpenAI-compatible
 *     endpoint (vLLM, OpenRouter, LM Studio…). These can be configured two
 *     ways: per-workspace **`ProviderCredential`** rows (key encrypted via
 *     `crypto.ts`, managed in Settings → Workspace → AI), which take
 *     precedence; or environment variables as a fallback. A DB credential
 *     means the Streaming engine works with no env config at all.
 *
 *   - **The interface is OpenAI's chat-completions shape.** Anthropic's
 *     native `/v1/messages` is reached through their OpenAI-compat
 *     endpoint at `https://api.anthropic.com/v1/` so the same OpenAI
 *     client reaches everywhere.
 *
 * Adding a new provider = one entry in `PROVIDERS` plus the env vars it
 * reads. No code changes elsewhere.
 */

export type ProviderId = "hermes" | "openai" | "anthropic" | "custom";

interface ProviderDef {
  id: ProviderId;
  label: string;
  description: string;
  /// Default model when the workspace doesn't override.
  defaultModel: string;
  /// True when the provider's OpenAI-compatible surface accepts the
  /// multimodal `image_url` content block. Drives chat-stream's
  /// fallback behaviour for image attachments.
  supportsImageInput: boolean;
  /// Resolve baseURL + apiKey at call time so env reloads pick up.
  resolve: () =>
    | { ok: true; baseURL: string; apiKey: string; defaultHeaders?: Record<string, string> }
    | { ok: false; reason: string };
}

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  hermes: {
    id: "hermes",
    label: "Hermes Gateway",
    description:
      "Forge's default. Routes through the Hermes model-router plugin to whatever upstream provider the workspace's session is configured for.",
    defaultModel: "claude-haiku-4-5-20251001",
    supportsImageInput: true,
    resolve: () => {
      const baseURL =
        process.env.HERMES_GATEWAY_URL ??
        `http://127.0.0.1:${process.env.HERMES_GATEWAY_PORT ?? "8642"}/v1`;
      const apiKey = process.env.HERMES_GATEWAY_TOKEN ?? "placeholder";
      return { ok: true, baseURL, apiKey };
    },
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description:
      "Direct OpenAI API. Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL for OpenRouter / LM Studio etc.).",
    defaultModel: "gpt-4o-mini",
    supportsImageInput: true,
    resolve: () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey)
        return { ok: false, reason: "OPENAI_API_KEY not set" };
      const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      return { ok: true, baseURL, apiKey };
    },
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (direct)",
    description:
      "Anthropic's OpenAI-compatible endpoint. Set ANTHROPIC_API_KEY.",
    defaultModel: "claude-haiku-4-5-20251001",
    supportsImageInput: true,
    resolve: () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey)
        return { ok: false, reason: "ANTHROPIC_API_KEY not set" };
      // Anthropic's OpenAI-compat surface lives under /v1/.
      return {
        ok: true,
        baseURL: "https://api.anthropic.com/v1",
        apiKey,
        defaultHeaders: { "anthropic-version": "2023-06-01" },
      };
    },
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    description:
      "Any OpenAI-compatible /v1/chat/completions endpoint. Set FORGE_AI_BASE_URL and FORGE_AI_API_KEY.",
    defaultModel: "gpt-4o-mini",
    // Conservative default — custom endpoints (LM Studio, vLLM with non-VLM
    // models, etc.) may not accept image_url blocks. Operators can flip the
    // env var when they know the upstream supports it.
    supportsImageInput: process.env.FORGE_AI_SUPPORTS_IMAGES === "1",
    resolve: () => {
      const baseURL = process.env.FORGE_AI_BASE_URL;
      const apiKey = process.env.FORGE_AI_API_KEY;
      if (!baseURL || !apiKey)
        return {
          ok: false,
          reason: "FORGE_AI_BASE_URL and FORGE_AI_API_KEY both required",
        };
      return { ok: true, baseURL, apiKey };
    },
  },
};

export function listProviders(): Array<{
  id: ProviderId;
  label: string;
  description: string;
  defaultModel: string;
  available: boolean;
  unavailableReason?: string;
}> {
  return Object.values(PROVIDERS).map((p) => {
    const r = p.resolve();
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      defaultModel: p.defaultModel,
      available: r.ok,
      unavailableReason: r.ok ? undefined : r.reason,
    };
  });
}

export function getProvider(id: string | null | undefined): ProviderDef {
  if (id && (id === "hermes" || id === "openai" || id === "anthropic" || id === "custom")) {
    return PROVIDERS[id];
  }
  return PROVIDERS.hermes;
}

export function isProviderAvailable(id: string | null | undefined): boolean {
  return getProvider(id).resolve().ok;
}

/**
 * Build a configured OpenAI SDK client for the named provider, or null
 * if its env isn't set up. Callers treat null as "AI unavailable".
 */
export function getClient(
  providerId: string | null | undefined,
): {
  client: OpenAI;
  defaultModel: string;
  providerId: ProviderId;
  supportsImageInput: boolean;
} | null {
  const provider = getProvider(providerId);
  const r = provider.resolve();
  if (!r.ok) {
    logger.warn(
      { provider: provider.id, reason: r.reason },
      "ai-providers: provider unavailable",
    );
    return null;
  }
  return {
    client: new OpenAI({
      baseURL: r.baseURL,
      apiKey: r.apiKey,
      defaultHeaders: r.defaultHeaders,
    }),
    defaultModel: provider.defaultModel,
    providerId: provider.id,
    supportsImageInput: provider.supportsImageInput,
  };
}

export type ResolvedProviderClient = {
  client: OpenAI;
  defaultModel: string;
  providerId: ProviderId;
  supportsImageInput: boolean;
};

/**
 * Canonical OpenAI-compatible base URL + headers for a provider when its key
 * comes from a DB credential (rather than env, which embeds the base in
 * `resolve()`). `custom` has no canonical base — the credential must carry one.
 */
function canonicalBaseFor(
  id: ProviderId,
  credBaseUrl: string | null | undefined,
): { baseURL: string; headers?: Record<string, string> } | null {
  if (credBaseUrl && credBaseUrl.trim()) {
    const headers = id === "anthropic" ? { "anthropic-version": "2023-06-01" } : undefined;
    return { baseURL: credBaseUrl.trim(), headers };
  }
  switch (id) {
    case "openai":
      return { baseURL: "https://api.openai.com/v1" };
    case "anthropic":
      return {
        baseURL: "https://api.anthropic.com/v1",
        headers: { "anthropic-version": "2023-06-01" },
      };
    case "hermes":
      return {
        baseURL:
          process.env.HERMES_GATEWAY_URL ??
          `http://127.0.0.1:${process.env.HERMES_GATEWAY_PORT ?? "8642"}/v1`,
      };
    case "custom":
      return null; // custom requires an explicit base URL on the credential
  }
}

/**
 * Resolve a chat client for a workspace+provider, **DB credential first**,
 * env fallback. Returns null when neither is configured (caller surfaces a
 * "no chat model configured" notice — never falls back to another platform).
 */
export async function resolveWorkspaceProviderClient(
  db: PrismaClient,
  workspaceId: string,
  providerId: string | null | undefined,
): Promise<ResolvedProviderClient | null> {
  const provider = getProvider(providerId);
  const cred = await db.providerCredential.findUnique({
    where: { workspaceId_providerId: { workspaceId, providerId: provider.id } },
    select: { apiKeyEnc: true, baseUrl: true, defaultModel: true, enabled: true },
  });
  if (cred && cred.enabled && cred.apiKeyEnc) {
    const base = canonicalBaseFor(provider.id, cred.baseUrl);
    if (!base) {
      logger.warn(
        { provider: provider.id },
        "ai-providers: custom credential missing base URL",
      );
      return getClient(provider.id);
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(cred.apiKeyEnc);
    } catch (err) {
      logger.warn({ err, provider: provider.id }, "ai-providers: credential decrypt failed");
      return getClient(provider.id);
    }
    return {
      client: new OpenAI({ baseURL: base.baseURL, apiKey, defaultHeaders: base.headers }),
      defaultModel: cred.defaultModel || provider.defaultModel,
      providerId: provider.id,
      supportsImageInput: provider.supportsImageInput,
    };
  }
  return getClient(provider.id);
}

/**
 * The set of providerIds a workspace can serve chat with — DB credentials
 * (enabled + key) unioned with env-available providers. Used by chat-readiness
 * to decide if a Completions turn will reach a model. One query, sync predicate.
 */
export async function workspaceChatProviderAvailability(
  db: PrismaClient,
  workspaceId: string,
): Promise<(providerId: string) => boolean> {
  const creds = await db.providerCredential.findMany({
    where: { workspaceId, enabled: true, NOT: { apiKeyEnc: null } },
    select: { providerId: true },
  });
  const dbSet = new Set(creds.map((c) => c.providerId));
  return (providerId: string) => dbSet.has(getProvider(providerId).id) || isProviderAvailable(providerId);
}
