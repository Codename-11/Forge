import "server-only";
import OpenAI from "openai";
import { logger } from "@/server/logger";

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
 *     endpoint (vLLM, OpenRouter, LM Studio…). Provider-specific URLs
 *     and tokens live in env — never in the DB.
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
): { client: OpenAI; defaultModel: string; providerId: ProviderId } | null {
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
  };
}
