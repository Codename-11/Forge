import { db } from "@/server/db";
import { logger } from "@/server/logger";
import {
  BLOCKED_EVENT_KINDS,
  formatEvent,
  hasMentions,
  type ActivityEventLike,
  type WorkspaceLike,
} from "./format";

/**
 * Local-runtime skill. The caller (plugin runtime or an ops shim) hands
 * us an ActivityEvent-shaped object, the workspace it belongs to, and
 * the plugin's per-install config blob (see README for shape). We decide
 * whether to forward + POST to the configured Slack / Discord channel
 * webhooks.
 *
 * Config comes in on the input (injected by whoever invokes the skill)
 * rather than being re-read from the Plugin row, so this handler stays
 * pure-ish: same input → same side effects. The fetch implementation is
 * also injectable, which is how unit tests avoid hitting real webhooks.
 */

export type ChannelConfig = {
  webhookUrl: string;
  eventKinds: string[];
};

export type BridgeConfig = {
  slack?: ChannelConfig;
  discord?: ChannelConfig;
  mentionsOnly?: boolean;
};

export type HandlerInput = {
  event: ActivityEventLike;
  workspace: WorkspaceLike;
  config: BridgeConfig;
};

type Ctx = { workspaceId: string; invokerUserId: string | null };

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export type HandlerOptions = {
  /** Override fetch in tests. Defaults to globalThis.fetch. */
  fetchImpl?: FetchFn;
};

export type HandlerOutput = {
  sent: Array<"slack" | "discord">;
  skipped: string | null;
};

/**
 * Core delivery routine — exported so tests can call it with an injected
 * `fetchImpl` without running through the skill registry.
 */
export async function deliver(
  input: HandlerInput,
  opts: HandlerOptions = {},
): Promise<HandlerOutput> {
  const { event, workspace, config } = input;
  const kind = String(event.kind);

  if (BLOCKED_EVENT_KINDS.has(kind)) {
    return { sent: [], skipped: "blocked-kind" };
  }

  if (config.mentionsOnly && !hasMentions(event)) {
    return { sent: [], skipped: "no-mentions" };
  }

  const payloads = formatEvent(event, workspace);
  const fetchFn: FetchFn =
    opts.fetchImpl ??
    ((url, init) =>
      fetch(url, init).then((r) => ({ ok: r.ok, status: r.status })));

  const sent: Array<"slack" | "discord"> = [];
  const targets: Array<{
    channel: "slack" | "discord";
    url: string;
    body: string;
    kinds: string[];
  }> = [];

  if (config.slack?.webhookUrl) {
    targets.push({
      channel: "slack",
      url: config.slack.webhookUrl,
      body: JSON.stringify(payloads.slack),
      kinds: config.slack.eventKinds ?? [],
    });
  }
  if (config.discord?.webhookUrl) {
    targets.push({
      channel: "discord",
      url: config.discord.webhookUrl,
      body: JSON.stringify(payloads.discord),
      kinds: config.discord.eventKinds ?? [],
    });
  }

  for (const t of targets) {
    if (!t.kinds.includes(kind)) continue;
    try {
      const res = await fetchFn(t.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: t.body,
      });
      if (res.ok) sent.push(t.channel);
      else {
        logger.warn(
          { channel: t.channel, status: res.status, kind },
          "notification-bridge: webhook non-2xx",
        );
      }
    } catch (err) {
      logger.warn(
        { channel: t.channel, err, kind },
        "notification-bridge: webhook delivery failed",
      );
    }
  }

  return { sent, skipped: sent.length === 0 ? "no-matching-channel" : null };
}

/**
 * Skill surface used by the plugin runtime. Fallback-reads the plugin's
 * stored manifest config (under `manifest.config`) if the caller didn't
 * pass `config` explicitly — lets admins drop their Slack/Discord
 * webhook URLs into the Plugin row without refactoring the invocation
 * call sites.
 */
export const skills = {
  deliver: async (input: unknown, ctx: Ctx): Promise<HandlerOutput> => {
    const parsed = input as Partial<HandlerInput> | undefined;
    if (!parsed?.event) {
      throw new Error("notification-bridge: missing `event` input");
    }
    if (!parsed.workspace) {
      throw new Error("notification-bridge: missing `workspace` input");
    }

    let config: BridgeConfig | undefined = parsed.config;
    if (!config) {
      const plugin = await db.plugin.findFirst({
        where: { workspaceId: ctx.workspaceId, slug: "notification-bridge" },
        select: { manifest: true },
      });
      const manifest = (plugin?.manifest ?? {}) as { config?: BridgeConfig };
      config = manifest.config ?? {};
    }

    return deliver({
      event: parsed.event,
      workspace: parsed.workspace,
      config,
    });
  },
};
