import { describe, it, expect } from "vitest";
import {
  formatEvent,
  hasMentions,
  BLOCKED_EVENT_KINDS,
  buildForgeUrl,
  buildIssueIdentifier,
  type ActivityEventLike,
  type WorkspaceLike,
} from "@forge/plugins/notification-bridge/format";
import {
  deliver,
  type HandlerInput,
} from "@forge/plugins/notification-bridge/handler";

const ws: WorkspaceLike = {
  id: "ws_1",
  slug: "axiom",
  key: "AXI",
  name: "Axiom Labs",
};

function makeFetchStub() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  return { fetchImpl, calls };
}

describe("notification-bridge / formatEvent", () => {
  it("formats an ISSUE_CREATED event into Slack + Discord payloads", () => {
    const event: ActivityEventLike = {
      id: "evt_1",
      kind: "ISSUE_CREATED",
      subjectType: "issue",
      subjectId: "iss_42",
      payload: { number: 42, title: "Redis connection flapping in prod" },
      createdAt: "2026-04-23T12:00:00.000Z",
    };

    const out = formatEvent(event, ws);

    // Slack shape — sanity-check without snapshotting timestamps.
    expect(out.slack.text).toBe("AXI-42 created: Redis connection flapping in prod");
    expect(out.slack.blocks).toHaveLength(2);
    expect(out.slack.blocks[0]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn" },
    });
    expect(out.slack.blocks[1]).toMatchObject({ type: "context" });
    const ctxEl = (
      out.slack.blocks[1] as { elements: Array<{ text: string }> }
    ).elements[0].text;
    expect(ctxEl).toContain("https://forge.axiom-labs.dev/w/axiom/issues/iss_42");
    expect(ctxEl).toContain("`ISSUE_CREATED`");

    // Discord shape.
    expect(out.discord.embeds).toHaveLength(1);
    const embed = out.discord.embeds[0] as Record<string, unknown>;
    expect(embed.title).toBe("AXI-42 · ISSUE_CREATED");
    expect(embed.description).toBe("AXI-42 created: Redis connection flapping in prod");
    expect(embed.url).toBe("https://forge.axiom-labs.dev/w/axiom/issues/iss_42");
    expect(typeof embed.color).toBe("number");
    expect(embed.timestamp).toBe("2026-04-23T12:00:00.000Z");
    expect(embed.footer).toEqual({ text: "Axiom Labs" });
  });

  it("formats an ISSUE_PRIORITY_CHANGED event with from→to summary", () => {
    const out = formatEvent(
      {
        kind: "ISSUE_PRIORITY_CHANGED",
        subjectType: "issue",
        subjectId: "iss_7",
        payload: { number: 7, from: "MEDIUM", to: "URGENT" },
      },
      ws,
    );
    expect(out.slack.text).toBe("AXI-7 priority: MEDIUM → URGENT");
    const embed = out.discord.embeds[0] as { description: string };
    expect(embed.description).toBe("AXI-7 priority: MEDIUM → URGENT");
  });

  it("formats a COMMENT_CREATED event with mention profile keys", () => {
    const out = formatEvent(
      {
        kind: "COMMENT_CREATED",
        subjectType: "issue",
        subjectId: "iss_99",
        payload: {
          number: 99,
          preview: "hey can you look at this",
          mentions: [
            { agentId: "ag_1", profileKey: "victor" },
            { agentId: "ag_2", profileKey: "mizu" },
          ],
        },
      },
      ws,
    );
    expect(out.slack.text).toBe(
      "New comment on AXI-99 (@victor, @mizu): hey can you look at this",
    );
    const embed = out.discord.embeds[0] as { description: string; title: string };
    expect(embed.title).toBe("AXI-99 · COMMENT_CREATED");
    expect(embed.description).toContain("@victor");
  });

  it("falls back to workspace home when subject isn't an issue", () => {
    const url = buildForgeUrl(
      { kind: "PROJECT_UPDATED", subjectType: "project", subjectId: "prj_1" },
      ws,
    );
    expect(url).toBe("https://forge.axiom-labs.dev/w/axiom");
  });

  it("buildIssueIdentifier returns null when number missing", () => {
    expect(
      buildIssueIdentifier(
        { kind: "ISSUE_CREATED", subjectType: "issue", subjectId: "iss_1" },
        ws,
      ),
    ).toBeNull();
  });
});

describe("notification-bridge / deliver handler", () => {
  it("forwards an ISSUE_CREATED event to both configured channels", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const input: HandlerInput = {
      event: {
        kind: "ISSUE_CREATED",
        subjectType: "issue",
        subjectId: "iss_42",
        payload: { number: 42, title: "Test" },
      },
      workspace: ws,
      config: {
        slack: {
          webhookUrl: "https://hooks.slack.test/x",
          eventKinds: ["ISSUE_CREATED"],
        },
        discord: {
          webhookUrl: "https://discord.test/x",
          eventKinds: ["ISSUE_CREATED"],
        },
      },
    };
    const out = await deliver(input, { fetchImpl });
    expect(out.sent).toEqual(["slack", "discord"]);
    expect(out.skipped).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://hooks.slack.test/x");
    expect(calls[1].url).toBe("https://discord.test/x");
    // Slack payload carries the expected `text`.
    expect((calls[0].body as { text: string }).text).toContain("AXI-42 created");
    // Discord payload carries the embeds array.
    expect((calls[1].body as { embeds: unknown[] }).embeds).toHaveLength(1);
  });

  it("only forwards to channels whose eventKinds includes the event", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const out = await deliver(
      {
        event: {
          kind: "COMMENT_CREATED",
          subjectType: "issue",
          subjectId: "iss_1",
          payload: { number: 1, preview: "hi", mentions: [{ agentId: "a", profileKey: "victor" }] },
        },
        workspace: ws,
        config: {
          slack: {
            webhookUrl: "https://hooks.slack.test/x",
            eventKinds: ["ISSUE_CREATED"], // not COMMENT_CREATED
          },
          discord: {
            webhookUrl: "https://discord.test/x",
            eventKinds: ["COMMENT_CREATED"],
          },
        },
      },
      { fetchImpl },
    );
    expect(out.sent).toEqual(["discord"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.test/x");
  });

  it("mentionsOnly=true filters out events with no mentions[]", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const out = await deliver(
      {
        event: {
          kind: "COMMENT_CREATED",
          subjectType: "issue",
          subjectId: "iss_1",
          payload: { number: 1, preview: "no mentions here", mentions: [] },
        },
        workspace: ws,
        config: {
          mentionsOnly: true,
          slack: {
            webhookUrl: "https://hooks.slack.test/x",
            eventKinds: ["COMMENT_CREATED"],
          },
        },
      },
      { fetchImpl },
    );
    expect(out.sent).toEqual([]);
    expect(out.skipped).toBe("no-mentions");
    expect(calls).toHaveLength(0);
    // And verify hasMentions is false for empty list.
    expect(
      hasMentions({
        kind: "COMMENT_CREATED",
        subjectType: "issue",
        subjectId: "iss_1",
        payload: { mentions: [] },
      }),
    ).toBe(false);
  });

  it("refuses to forward blocked kinds even when configured", async () => {
    const { fetchImpl, calls } = makeFetchStub();
    expect(BLOCKED_EVENT_KINDS.has("PLUGIN_ERROR")).toBe(true);
    const out = await deliver(
      {
        event: {
          kind: "PLUGIN_ERROR",
          subjectType: "plugin",
          subjectId: "pl_1",
          payload: {},
        },
        workspace: ws,
        config: {
          slack: {
            webhookUrl: "https://hooks.slack.test/x",
            eventKinds: ["PLUGIN_ERROR"], // user tried to enable — we still refuse
          },
        },
      },
      { fetchImpl },
    );
    expect(out.sent).toEqual([]);
    expect(out.skipped).toBe("blocked-kind");
    expect(calls).toHaveLength(0);
  });
});
