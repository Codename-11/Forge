import { describe, expect, it } from "vitest";
import { isImageAvatar, textAvatarForAgent } from "@/components/agents/agent-avatar-utils";

describe("agent avatar helpers", () => {
  it("treats short text and emoji avatars as display text, not image sources", () => {
    expect(isImageAvatar("VI")).toBe(false);
    expect(isImageAvatar("🔷")).toBe(false);
    expect(textAvatarForAgent({ name: "Victor", profileKey: "victor", avatar: "VI" })).toBe("VI");
    expect(textAvatarForAgent({ name: "Mizu", profileKey: "mizu", avatar: "💧" })).toBe("💧");
  });

  it("keeps URL-like avatars eligible for img rendering and falls back to profile initials", () => {
    expect(isImageAvatar("https://example.test/victor.png")).toBe(true);
    expect(isImageAvatar("/avatars/mizu.png")).toBe(true);
    expect(isImageAvatar("data:image/png;base64,abc")).toBe(true);
    expect(isImageAvatar("blob:https://example.test/token")).toBe(true);
    expect(textAvatarForAgent({ name: "Claude", profileKey: "claude", avatar: "https://example.test/c.png" })).toBe("CL");
  });

  it("falls back to agent name or generic initials when profile key is unavailable", () => {
    expect(textAvatarForAgent({ name: "Paperclip Coach", profileKey: null, avatar: null })).toBe("PC");
    expect(textAvatarForAgent({ name: null, profileKey: null, avatar: null })).toBe("AG");
  });
});
